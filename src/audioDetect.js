// Real audio matching for Add Audio's "detect the splice point" step.
//
// This works because of the reference-track workflow: every song can be
// downloaded as its exact uploaded master (see Library -> "Download
// reference"), so a producer builds their transition/intro/outro FROM that
// same file. That means at the splice point, the dropped file's waveform is
// (near-)identical to the reference track's — which makes this tractable
// with straightforward signal correlation instead of needing a full
// Shazam-style acoustic fingerprint database.
//
// The DJ picks which song(s) and which cut type this is BEFORE dropping
// the file (AddAudio.jsx) — there is no auto-detect-which-song-out-of-the-
// whole-library step here anymore. What's detected automatically is just
// the splice timecode against the song(s) already chosen (see
// detectSpliceForKnownSongs below), which needed a real rewrite of its own:
// real produced uploads turned out to commonly be a FULL-LENGTH re-export
// of the whole song with the splice embedded partway through — sometimes
// 90+ seconds in — not a short clip beginning right at the cue point, so
// detecting the actual divergence point means decoding and scanning the
// whole file, not just comparing a short fixed edge window.

import { resolveAudioUrl } from './localAudioStore.js';

const WINDOW_SEC = 0.05; // ~50ms RMS windows — coarse but resistant to bit-level noise

let sharedAudioCtx = null;
export function getAudioContext() {
  if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return sharedAudioCtx;
}

async function decodeArrayBuffer(arrayBuffer) {
  const ctx = getAudioContext();
  // Safari still wants the callback form; the promise form covers everyone else.
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
  });
}

export async function decodeFile(file) {
  return decodeArrayBuffer(await file.arrayBuffer());
}

export async function fetchAndDecode(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed: ' + res.status);
  return decodeArrayBuffer(await res.arrayBuffer());
}

// Mono-mixed RMS envelope over fixed-size windows.
export function rmsEnvelope(buffer, startSample, endSample, windowSize) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const n = Math.max(0, endSample - startSample);
  const numWindows = Math.floor(n / windowSize);
  const env = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    const base = startSample + w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c][base + i] || 0;
      v /= channels.length;
      sum += v * v;
    }
    env[w] = Math.sqrt(sum / windowSize);
  }
  return env;
}

function zScore(arr) {
  if (arr.length === 0) return arr;
  let mean = 0; for (let i = 0; i < arr.length; i++) mean += arr[i]; mean /= arr.length;
  let variance = 0; for (let i = 0; i < arr.length; i++) variance += (arr[i] - mean) ** 2; variance /= arr.length;
  const std = Math.sqrt(variance) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - mean) / std;
  return out;
}

// Best-lag normalized cross-correlation between two envelopes. `a[i]`
// lines up with `b[i + lag]` at the winning lag, so the caller can turn
// that lag back into an actual timecode — this is what makes the detected
// in/out points real instead of guessed.
export function bestCorrelation(a, b) {
  if (a.length === 0 || b.length === 0) return { score: 0, lag: 0 };
  const na = zScore(a), nb = zScore(b);
  // The valid lag range is NOT symmetric when the two envelopes differ in
  // length (the ordinary case: a's a short probe window, b's a much
  // longer reference envelope) — sliding a's start across b's whole length
  // needs lag from -(na.length-1) up to +(nb.length-1), not ±min(na,nb)-1.
  // Confirmed as a real bug, not a hunch: a genuine, byte-exact splice
  // between a 5s dropped clip and a 14s reference song scored 0.84 at its
  // true lag (160) but that lag sat outside the old ±99 (min(100,200)-1)
  // window, so the search never even considered it and returned some
  // spurious in-range lag with a much weaker score instead.
  const minLag = -(na.length - 1);
  const maxLag = nb.length - 1;
  // A lag near the search's extremes only overlaps a handful of windows —
  // on z-scored (zero-mean, unit-variance) data, a handful of points can
  // score deceptively high by pure chance, which a flat `count < 4` floor
  // let straight through as a "confident" match. The fix isn't "require
  // most of the shorter envelope" though — a real outro/transition upload
  // is meant to carry only a bar or two of the original before its own new
  // material starts (see TODO.md), so most of the dropped clip's own
  // envelope is *supposed* to be non-overlapping content the correlation
  // was never going to match against; requiring a fixed fraction of it
  // rejected exactly the short-overlap case this exists to detect (a 2s
  // overlap against a clip that's mostly new material after it scores well
  // under any reasonable percentage of either full envelope). What
  // actually guards against a coincidental fluke is an absolute floor on
  // how much real overlap backs the score — a bar or two even at a slow
  // tempo is comfortably more than a second, so requiring that much (not
  // a percentage) filters the same tiny-window flukes without punishing a
  // short, legitimate overlap.
  const MIN_OVERLAP_SEC = 1;
  const minCount = Math.min(Math.min(na.length, nb.length), Math.max(4, Math.round(MIN_OVERLAP_SEC / WINDOW_SEC)));
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, count = 0;
    for (let i = 0; i < na.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= nb.length) continue;
      sum += na[i] * nb[j];
      count++;
    }
    if (count < minCount) continue;
    const score = sum / count;
    if (score > best) { best = score; bestLag = lag; }
  }
  return { score: best === -Infinity ? 0 : best, lag: bestLag };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// ---------------------------------------------------------------------------
// Splice-point detection against a known song (see the file header comment
// above) — real produced uploads turned out to commonly be a FULL-LENGTH
// re-export of the whole song with the splice embedded partway through, not
// a short clip starting right at the cue point, so this scans as far into
// the timeline as it takes to find the actual divergence, not just a fixed
// short edge window. Confirmed directly against a real pair of files: a
// produced "with outro" master and its plain reference matched sample-for-
// sample (near-zero relative RMS difference) for the first ~91 seconds,
// then diverged sharply for the rest.
// ---------------------------------------------------------------------------

const DIVERGE_WINDOW_SEC = 0.05; // fine-scan window — matches WINDOW_SEC's own resolution
// Empirically: two genuinely-matching windows (even across a lossy
// re-encode) measured well under 0.05; a real divergence point jumped
// straight past 0.4 (the diverging content isn't just "different by some
// amount", it's unrelated audio — its own energy has no reason to resemble
// the original's at that moment at all).
//
// Since relativeDiffEnvelope became level-invariant its output is
// sqrt(1 - rho^2), which is bounded at 1 rather than running past it, so
// divergence now reads ~0.9-1.0 instead of "past 1.0". The gap the
// threshold sits in got WIDER, not narrower — a matching window no longer
// carries any level-offset error at all — so 0.35 still sits comfortably in
// the middle and needs no recalibration. In rho terms it means "windows
// correlating above ~0.94 count as the same audio".
const DIVERGE_THRESHOLD = 0.35;
// Requires the divergence to STAY past threshold for a full second before
// accepting it — a single stray transient (a drum hit landing a few
// samples out of phase between a lossy re-encode and the original) can
// spike one window without being the real splice point.
const DIVERGE_HOLD_SEC = 1.0;
// How much of the probe's own leading edge feeds the initial coarse
// alignment correlation — needs to be long enough to be a distinctive,
// non-repeating passage (an intro/opening is usually unique within its
// own song), not so long it starts overlapping the eventual divergence
// point on a short produced clip.
const COARSE_ALIGN_SEC = 20;

// A read-only, duck-typed AudioBuffer-alike with every channel's sample
// order reversed. Intro detection needs the exact same "declining match
// walking forward from an anchor" scan as Outro, just aimed the other way
// (an intro clip's own NEW material sits at its start, matching the
// destination near the clip's END) — reversing both buffers turns that
// into the identical forward-scan shape Outro already handles, so there is
// only one scanning implementation to keep correct, not two hand-written
// mirror-image copies that could quietly drift apart.
function reversedBuffer(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice().reverse());
  return {
    numberOfChannels: buffer.numberOfChannels, length: buffer.length,
    sampleRate: buffer.sampleRate, duration: buffer.duration,
    getChannelData: (c) => channels[c],
  };
}

// Per-window match residual between two buffers at given start offsets —
// near 0 while genuinely matching (same recording), near 1 once they diverge
// into unrelated content. Mono-mixes each buffer's own channels independently
// (mirrors rmsEnvelope's own convention) so a mono probe against a stereo
// reference, or vice versa, still compares correctly. Stops at whichever
// buffer runs out of samples first.
//
// LEVEL-INVARIANT ON PURPOSE. This used to measure `rms(a - b) / rms(a)`, a
// raw sample-by-sample subtraction, which made the whole detector fail on a
// uniform gain difference between the export and the reference master: for a
// gain factor g that ratio is |1 - 1/g|, so a mere 3 dB mismatch reads 0.29-
// 0.41 and trips DIVERGE_THRESHOLD at sample zero — reporting a bogus splice
// at the very start of the file. That is not a hypothetical: peak/LUFS
// normalization on export, a different limiter ceiling, or a master fader
// nudge between the two renders all produce exactly that, and a producer has
// no reason to expect any of them to matter.
//
// Instead, each window now solves for the best-fit gain g (least squares,
// g = sum(ab)/sum(b^2)) and measures the residual that gain CAN'T explain.
// The closed form of that residual is sum(a^2) * (1 - rho^2), where rho is
// the correlation coefficient between the two windows, so what comes out is
// simply sqrt(1 - rho^2):
//   - the same audio at any level  -> rho ~= 1    -> ~0
//   - unrelated audio             -> rho ~= 0    -> ~1
// One fitted parameter against a couple of thousand samples per window, so
// there is nothing here for a real divergence to hide behind — diverging
// content is uncorrelated, which no choice of g can rescue. It also absorbs
// TIME-VARYING gain for free, which is what a compressor or limiter left on
// the master bus actually does to a re-render.
function relativeDiffEnvelope(bufferA, bufferB, startA, startB, windowSize, maxWindows) {
  const chA = []; for (let c = 0; c < bufferA.numberOfChannels; c++) chA.push(bufferA.getChannelData(c));
  const chB = []; for (let c = 0; c < bufferB.numberOfChannels; c++) chB.push(bufferB.getChannelData(c));
  const availableWindows = Math.floor(Math.min(bufferA.length - startA, bufferB.length - startB) / windowSize);
  const numWindows = Math.max(0, Math.min(maxWindows, availableWindows));
  const out = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let sumSqA = 0, sumSqB = 0, sumAB = 0;
    const baseA = startA + w * windowSize, baseB = startB + w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      let av = 0; for (let c = 0; c < chA.length; c++) av += chA[c][baseA + i] || 0; av /= chA.length;
      let bv = 0; for (let c = 0; c < chB.length; c++) bv += chB[c][baseB + i] || 0; bv /= chB.length;
      sumSqA += av * av;
      sumSqB += bv * bv;
      sumAB += av * bv;
    }
    // A silent reference window explains nothing, so the residual is all of
    // A's own energy (ratio 1) — except where A is silent too, which is a
    // genuine match and falls out of the rmsA guard below.
    const explained = sumSqB > 1e-12 ? (sumAB * sumAB) / sumSqB : 0;
    const residual = Math.max(0, sumSqA - explained);
    const rmsA = Math.sqrt(sumSqA / windowSize);
    const rmsResidual = Math.sqrt(residual / windowSize);
    out[w] = rmsA > 1e-6 ? rmsResidual / rmsA : rmsResidual;
  }
  return out;
}

// Best-fit gain of B against A over one window (the same least-squares
// scalar relativeDiffEnvelope fits per window, see above). Used to carry a
// known-good gain estimate into the sample-level refinement below, which
// compares raw amplitudes and would otherwise reintroduce exactly the
// level-sensitivity relativeDiffEnvelope just removed.
function bestFitGain(bufferA, bufferB, startA, startB, count) {
  const chA = []; for (let c = 0; c < bufferA.numberOfChannels; c++) chA.push(bufferA.getChannelData(c));
  const chB = []; for (let c = 0; c < bufferB.numberOfChannels; c++) chB.push(bufferB.getChannelData(c));
  let sumSqB = 0, sumAB = 0;
  for (let i = 0; i < count; i++) {
    let av = 0; for (let c = 0; c < chA.length; c++) av += chA[c][startA + i] || 0; av /= chA.length;
    let bv = 0; for (let c = 0; c < chB.length; c++) bv += chB[c][startB + i] || 0; bv /= chB.length;
    sumSqB += bv * bv;
    sumAB += av * bv;
  }
  return sumSqB > 1e-12 ? sumAB / sumSqB : 1;
}

// Refines a divergence boundary found at DIVERGE_WINDOW_SEC (~50ms)
// resolution down to individual-sample precision — "should be identical
// when spliced" needs better than a 50ms window can promise on its own.
// Requires a short run of consecutively-elevated absolute difference
// (not one single sample) before accepting the boundary, the same
// "don't trust one transient" reasoning as DIVERGE_HOLD_SEC above, just at
// sample scale instead of window scale.
//
// `gain` scales the reference before comparing, since this measures raw
// amplitude against an absolute floor and so is level-sensitive in a way
// relativeDiffEnvelope deliberately no longer is. Without it a modest level
// offset alone clears ABS_FLOOR on any loud passage (at |ref| ~ 0.3, even
// +0.5 dB gives ~0.018) and the boundary snaps to the start of the scan
// region — the coarse scan would be forgiving and this would quietly undo it.
function refineSampleBoundary(probeBuffer, refBuffer, probeStart, refStart, scanSamples, gain = 1) {
  const pch = probeBuffer.getChannelData(0), rch = refBuffer.getChannelData(0);
  const maxLen = Math.max(0, Math.min(scanSamples, probeBuffer.length - probeStart, refBuffer.length - refStart));
  const RUN = 8;
  const ABS_FLOOR = 0.01;
  const window = [];
  let runSum = 0;
  for (let i = 0; i < maxLen; i++) {
    const d = Math.abs((pch[probeStart + i] || 0) - gain * (rch[refStart + i] || 0));
    window.push(d); runSum += d;
    if (window.length > RUN) runSum -= window.shift();
    if (window.length === RUN && (runSum / RUN) > ABS_FLOOR) return probeStart + i - RUN + 1;
  }
  return probeStart;
}

// The core scan: finds where `probeBuffer` stops matching `refBuffer`,
// walking FORWARD from probeBuffer's own start. Returns times in seconds:
// `alignSec` (where in refBuffer's own timeline probeBuffer's t=0 aligns —
// found by coarse correlation, so this is NOT assumed to be 0 even though
// it commonly turns out to be, for a full-length re-export that starts in
// sync with the original), `divergeProbeSec` (where in PROBEBUFFER's own
// timeline the match ends) and `divergeRefSec` (the same instant, on
// refBuffer's own timeline — just `alignSec + divergeProbeSec`).
async function scanForwardDivergence(probeBuffer, refBuffer) {
  const winSize = Math.max(1, Math.round(refBuffer.sampleRate * WINDOW_SEC));
  const coarseSamples = Math.min(probeBuffer.length, Math.round(refBuffer.sampleRate * COARSE_ALIGN_SEC));
  const probeCoarseEnv = rmsEnvelope(probeBuffer, 0, coarseSamples, winSize);
  const refFullEnv = rmsEnvelope(refBuffer, 0, refBuffer.length, winSize);
  const { lag, score } = bestCorrelation(probeCoarseEnv, refFullEnv);
  const alignSec = Math.max(0, lag * WINDOW_SEC);
  const refStartSample = Math.round(alignSec * refBuffer.sampleRate);

  const fineWinSamples = Math.max(1, Math.round(refBuffer.sampleRate * DIVERGE_WINDOW_SEC));
  const maxWindows = Math.floor(Math.min(probeBuffer.length, Math.max(0, refBuffer.length - refStartSample)) / fineWinSamples);
  const diffEnv = relativeDiffEnvelope(probeBuffer, refBuffer, 0, refStartSample, fineWinSamples, maxWindows);
  const holdWindows = Math.max(1, Math.round(DIVERGE_HOLD_SEC / DIVERGE_WINDOW_SEC));
  let divergeWindow = diffEnv.length; // never diverges within what was scanned — whole probe matches the reference
  for (let w = 0; w < diffEnv.length; w++) {
    if (diffEnv[w] <= DIVERGE_THRESHOLD) continue;
    let sustained = true;
    for (let j = w; j < Math.min(diffEnv.length, w + holdWindows); j++) {
      if (diffEnv[j] <= DIVERGE_THRESHOLD) { sustained = false; break; }
    }
    if (sustained) { divergeWindow = w; break; }
  }
  let divergeProbeSec = divergeWindow * DIVERGE_WINDOW_SEC;
  if (divergeWindow > 0 && divergeWindow < diffEnv.length) {
    const lastMatchProbe = (divergeWindow - 1) * fineWinSamples;
    const lastMatchRef = refStartSample + lastMatchProbe;
    // Measured on the last window that still MATCHED, so it's a clean read of
    // the level offset between the two renders rather than one contaminated
    // by the diverging content just after it.
    const gain = bestFitGain(probeBuffer, refBuffer, lastMatchProbe, lastMatchRef, fineWinSamples);
    const refinedSample = refineSampleBoundary(
      probeBuffer, refBuffer, lastMatchProbe, lastMatchRef, fineWinSamples * 2, gain,
    );
    divergeProbeSec = refinedSample / refBuffer.sampleRate;
  }

  return { alignSec, divergeProbeSec, divergeRefSec: alignSec + divergeProbeSec, score };
}

// The real entry point once the DJ has told us which song(s) and which cut
// type this produced file is for (AddAudio.jsx's manual picker) — no more
// guessing WHICH song out of the whole library, just an accurate splice
// timecode against the song(s) actually chosen. `leftSong` (Outro/
// Transition) gets a forward scan; `rightSong` (Intro/Transition) gets the
// same scan on time-reversed copies of both buffers (see reversedBuffer),
// converted back to real, forward timecodes afterward. Always downloads
// each reference song's FULL master (not just its head/tail) — the
// fetchEdgesRanged fast path above only ever covered a fixed short edge
// window, which is exactly the assumption this function exists to drop.
export async function detectSpliceForKnownSongs(file, { leftSong, rightSong }, onProgress) {
  const dropped = await decodeFile(file);
  const result = {
    leftOutSeconds: null, leftClipStartSec: null, leftScore: null,
    rightInSeconds: null, rightClipEndSec: null, rightScore: null,
  };

  if (leftSong && leftSong.audioUrl) {
    const url = await resolveAudioUrl(leftSong.audioUrl).catch(() => null);
    if (url) {
      const ref = await fetchAndDecode(url);
      if (onProgress) onProgress('left');
      const { divergeRefSec, divergeProbeSec, score } = await scanForwardDivergence(dropped, ref);
      result.leftOutSeconds = clamp(divergeRefSec, 0, ref.duration);
      result.leftClipStartSec = clamp(divergeProbeSec, 0, dropped.duration);
      result.leftScore = score;
    }
  }
  if (rightSong && rightSong.audioUrl) {
    const url = await resolveAudioUrl(rightSong.audioUrl).catch(() => null);
    if (url) {
      const ref = await fetchAndDecode(url);
      if (onProgress) onProgress('right');
      const revProbe = reversedBuffer(dropped);
      const revRef = reversedBuffer(ref);
      const { divergeRefSec: revDivergeRef, divergeProbeSec: revDivergeProbe, score } = await scanForwardDivergence(revProbe, revRef);
      result.rightInSeconds = clamp(ref.duration - revDivergeRef, 0, ref.duration);
      result.rightClipEndSec = clamp(dropped.duration - revDivergeProbe, 0, dropped.duration);
      result.rightScore = score;
    }
  }
  return result;
}
