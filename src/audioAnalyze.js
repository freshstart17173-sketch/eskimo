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

export function estimateBpm(mono, sampleRate) {
  const { onset, frameRate } = onsetEnvelope(mono, sampleRate);
  const minLag = Math.floor((60 / MAX_BPM) * frameRate);
  const maxLag = Math.ceil((60 / MIN_BPM) * frameRate);
  if (onset.length < maxLag + 4) return null;

  let mean = 0; for (let i = 0; i < onset.length; i++) mean += onset[i]; mean /= onset.length;
  const centered = new Float32Array(onset.length);
  for (let i = 0; i < onset.length; i++) centered[i] = onset[i] - mean;

  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centered.length; i++) sum += centered[i] * centered[i + lag];
    if (sum > bestScore) { bestScore = sum; bestLag = lag; }
  }
  if (bestScore <= 0) return null;
  return Math.round((60 / (bestLag / frameRate)) * 10) / 10;
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

function computeChroma(mono, sampleRate) {
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

export function estimateKey(chroma) {
  let best = null, bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    const majorScore = correlate(chroma, rotate(MAJOR_PROFILE, tonic));
    if (majorScore > bestScore) { bestScore = majorScore; best = `${NOTE_NAMES[tonic]} maj`; }
    const minorScore = correlate(chroma, rotate(MINOR_PROFILE, tonic));
    if (minorScore > bestScore) { bestScore = minorScore; best = `${NOTE_NAMES[tonic]} min`; }
  }
  return best;
}

// Decodes the file once and derives everything from that single buffer —
// durationSec comes straight from the decoded buffer (exact, not guessed),
// bpm/key are null when the signal is too short or too quiet to trust.
export async function analyzeAudio(file) {
  const buffer = await decodeFile(file);
  const mono = toMono(buffer);
  const bpm = estimateBpm(mono, buffer.sampleRate);
  const chroma = computeChroma(mono, buffer.sampleRate);
  const key = estimateKey(chroma);
  return { durationSec: buffer.duration, bpm, key };
}
