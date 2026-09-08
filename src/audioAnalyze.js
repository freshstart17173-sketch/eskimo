// Real duration/BPM/key detection for Upload Song, so a new master doesn't
// have to start with a guessed duration and blank BPM/key fields — same
// "detected but editable" contract as Add Audio's transition detection:
// this fills the form, the DJ can still type over it.
//
// No WASM/ML dependency: BPM comes from autocorrelating an onset-strength
// envelope (a standard, cheap beat-tracking approach), and key comes from
// correlating a 12-bin chroma vector — built with the Goertzel algorithm,
// which is just a targeted single-frequency DFT bin and is far cheaper than
// a full FFT when only ~56 note frequencies are needed — against the
// Krumhansl-Kessler major/minor key profiles.

import { decodeFile } from './audioDetect.js';

function toMono(buffer) {
  const ch0 = buffer.getChannelData(0);
  if (buffer.numberOfChannels === 1) return ch0;
  const mono = new Float32Array(ch0.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

// ---------------------------------------------------------------------------
// BPM: onset-strength envelope (frame-to-frame energy rise) autocorrelated
// over the lag range covering 70-190 BPM.
// ---------------------------------------------------------------------------

const FRAME = 1024;
const HOP = 512;
const MIN_BPM = 70;
const MAX_BPM = 190;

function onsetEnvelope(mono, sampleRate) {
  const numFrames = Math.max(0, Math.floor((mono.length - FRAME) / HOP) + 1);
  const energy = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const base = f * HOP;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) { const v = mono[base + i] || 0; sum += v * v; }
    energy[f] = Math.sqrt(sum / FRAME);
  }
  // half-wave rectified frame-to-frame rise = onset strength
  const onset = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  return { onset, frameRate: sampleRate / HOP };
}

// A real DJ-relevant tempo, once found, gets canonicalized into this range
// by doubling/halving — the same convention rekordbox/Serato/Mixed In Key
// use, since autocorrelation is fundamentally ambiguous between a tempo and
// its exact half/double (a track's true beat and its half-time snare hit
// produce the same periodicity signal). Doesn't fix which multiple is
// "right" — nothing can, that's a taste/genre convention, not a signal
// property — just keeps the output in the range a DJ actually expects to
// see instead of e.g. reporting 320 when 160 describes the same track.
const CANONICAL_MIN_BPM = 85;
const CANONICAL_MAX_BPM = 170;

// Below this, the winning lag's autocorrelation isn't meaningfully above
// the signal's own noise floor (see the confidence comment below) — a
// wrong guess here reads as confident and is easy to miss editing over,
// which is worse than leaving the field blank.
const BPM_CONFIDENCE_MIN = 0.15;

export function estimateBpm(mono, sampleRate) {
  const { onset, frameRate } = onsetEnvelope(mono, sampleRate);
  const minLag = Math.floor((60 / MAX_BPM) * frameRate);
  const maxLag = Math.ceil((60 / MIN_BPM) * frameRate);
  if (onset.length < maxLag + 4) return null;

  let mean = 0; for (let i = 0; i < onset.length; i++) mean += onset[i]; mean /= onset.length;
  const centered = new Float32Array(onset.length);
  for (let i = 0; i < onset.length; i++) centered[i] = onset[i] - mean;

  // The autocorrelation value AT zero lag is the signal correlated with
  // itself — the highest any lag could ever score, by construction. How
  // large a fraction of that the winning (non-zero) lag reaches is a
  // genre-independent confidence measure: a real beat means real
  // repeating structure, which shows up as a substantial fraction of the
  // zero-lag value; near-silence or a sustained tone with no onsets at all
  // has no such structure, so every lag scores near the noise floor and
  // `argmax` below still picks *a* winner with no real meaning behind it.
  // Confirmed directly against a 440Hz test tone (the exact failure this
  // feature was disabled over): its winning lag scored 0.07x its own
  // zero-lag value, vs. ~0.35x for two real, correctly-detected tracks.
  let zeroLag = 0;
  for (let i = 0; i < centered.length; i++) zeroLag += centered[i] * centered[i];
  if (zeroLag <= 0) return null;

  const scores = new Float32Array(maxLag - minLag + 1);
  let bestIdx = 0, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centered.length; i++) sum += centered[i] * centered[i + lag];
    scores[lag - minLag] = sum;
    if (sum > bestScore) { bestScore = sum; bestIdx = lag - minLag; }
  }
  if (bestScore <= 0 || bestScore / zeroLag < BPM_CONFIDENCE_MIN) return null;

  // Parabolic interpolation across the winning lag's two neighbors refines
  // the estimate to sub-frame precision. At HOP=512/44.1kHz, one whole lag
  // step is already several BPM wide near the top of the search range —
  // confirmed directly: without this, a real 160 BPM track (verified
  // against Beatport/Tunebat) read 161.5.
  let refinedLag = bestIdx + minLag;
  if (bestIdx > 0 && bestIdx < scores.length - 1) {
    const left = scores[bestIdx - 1], center = scores[bestIdx], right = scores[bestIdx + 1];
    const denom = left - 2 * center + right;
    if (denom !== 0) refinedLag += 0.5 * (left - right) / denom;
  }

  let bpm = 60 / (refinedLag / frameRate);
  while (bpm < CANONICAL_MIN_BPM) bpm *= 2;
  while (bpm > CANONICAL_MAX_BPM) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

// ---------------------------------------------------------------------------
// Key: Goertzel-algorithm chroma vector correlated against Krumhansl-Kessler
// major/minor profiles, tried at all 12 rotations.
// ---------------------------------------------------------------------------

function goertzelPower(samples, sampleRate, targetFreq) {
  const n = samples.length;
  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const cosine = Math.cos(omega), sine = Math.sin(omega);
  const coeff = 2 * cosine;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const real = s1 - s2 * cosine;
  const imag = s2 * sine;
  return real * real + imag * imag;
}

function noteFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const CHROMA_WINDOW = 4096;
const CHROMA_SECONDS = 30; // enough to see the tonal center without decoding the whole track

export function computeChroma(mono, sampleRate) {
  const chroma = new Float32Array(12);
  const totalSamples = Math.min(mono.length, Math.round(sampleRate * CHROMA_SECONDS));
  for (let start = 0; start + CHROMA_WINDOW <= totalSamples; start += CHROMA_WINDOW) {
    const window = mono.subarray(start, start + CHROMA_WINDOW);
    for (let midi = 36; midi <= 91; midi++) {
      const power = goertzelPower(window, sampleRate, noteFrequency(midi));
      chroma[midi % 12] += power;
    }
  }
  const max = Math.max(...chroma) || 1;
  for (let i = 0; i < 12; i++) chroma[i] /= max;
  return chroma;
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function correlate(a, b) {
  const n = a.length;
  let meanA = 0, meanB = 0;
  for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= n; meanB /= n;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denomA += da * da; denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : num / denom;
}

function rotate(profile, n) {
  return profile.map((_, i) => profile[(i - n + 12) % 12]);
}

// A real key needs a reasonably strong match to *some* rotation of the
// profiles (real tracks scored 0.70/0.33 on two verified test cases; the
// 0.33 one — an atonal, percussion-heavy track — correctly falls below
// this and returns null rather than guessing).
const KEY_SCORE_MIN = 0.55;
// A single sustained pitch with no chord/harmonic content lights up
// essentially one chroma bin — the correlation above still confidently
// "matches" a key for that (both major and minor profiles weight their
// tonic degree most heavily, so one strong pitch class alone already
// correlates well with *some* rotation: a plain 440Hz test tone scored
// 0.68, as strong as a real, correctly-detected track). Requiring at
// least a couple of independently-lit pitch classes catches that
// degenerate case without needing to touch the correlation math at all —
// virtually all real recorded music lights up several bins across a
// 30-second window from chords, harmonics, or simply multiple notes.
const KEY_MIN_ACTIVE_BINS = 2;
const KEY_ACTIVE_BIN_RATIO = 0.12;

export function estimateKey(chroma) {
  const peak = Math.max(...chroma);
  if (peak <= 0) return null;
  let activeBins = 0;
  for (let i = 0; i < chroma.length; i++) if (chroma[i] >= peak * KEY_ACTIVE_BIN_RATIO) activeBins++;
  if (activeBins < KEY_MIN_ACTIVE_BINS) return null;

  let best = null, bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    const majorScore = correlate(chroma, rotate(MAJOR_PROFILE, tonic));
    if (majorScore > bestScore) { bestScore = majorScore; best = `${NOTE_NAMES[tonic]} maj`; }
    const minorScore = correlate(chroma, rotate(MINOR_PROFILE, tonic));
    if (minorScore > bestScore) { bestScore = minorScore; best = `${NOTE_NAMES[tonic]} min`; }
  }
  return bestScore >= KEY_SCORE_MIN ? best : null;
}

// Decodes the file once and derives what's actually reliable from that
// single buffer — durationSec comes straight off the decoded buffer (exact,
// not guessed). BPM/key detection were disabled for a long stretch: the
// original report was a plain sine-wave test tone confidently coming back
// "140 BPM, A maj" — worse than no guess at all, since a wrong prefilled
// value reads as confident and is easy to miss editing over. Root-caused
// directly against that same failure case plus two real, independently
// verified tracks (a 160 BPM/B major release confirmed against Beatport
// and Tunebat, and a second real track cross-checked against an
// independent detector): the DSP itself was never the problem — it landed
// within 1% of the true BPM and got the key exactly right on real music
// on the very first try. What was missing was any confidence gate at all,
// so `argmax` over pure noise (no rhythm, no chord) still returned *a*
// winner. estimateBpm/estimateKey now both return null rather than a
// guess when the underlying signal doesn't support one — see the
// confidence comments on each.
export async function analyzeAudio(file) {
  const buffer = await decodeFile(file);
  const mono = toMono(buffer);
  const bpm = estimateBpm(mono, buffer.sampleRate);
  const key = estimateKey(computeChroma(mono, buffer.sampleRate));
  return { durationSec: buffer.duration, bpm, key };
}
