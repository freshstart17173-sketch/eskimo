// Real audio matching for Add Audio's "detect the song(s) this connects" step.
//
// This works because of the reference-track workflow: every song can be
// downloaded as its exact uploaded master (see Library -> "Download
// reference"), so a producer builds their transition/intro/outro FROM that
// same file. That means at the splice point, the dropped file's waveform is
// (near-)identical to the reference track's — which makes this tractable
// with straightforward signal correlation instead of needing a full
// Shazam-style acoustic fingerprint database: decode both clips with the
// Web Audio API, reduce each to a coarse RMS energy envelope, and find the
// best-aligned normalized cross-correlation between the dropped file's
// leading/trailing edge and each candidate's trailing/leading edge.
//
// Needs real reference audio to compare against — with no songs uploaded
// with audio yet, there is nothing to detect against, so callers should
// fall back to pickDetectedSongs (core.js) until that's true.
//
// Cost note: for a plain-PCM WAV master, fetchEdgesRanged below gets
// everything this needs — an exact duration plus head/tail envelopes —
// from a HEAD-sized probe and two small byte-range GETs, not the whole
// file (R2 and most CDNs answer Range requests natively; see TODO.md for
// the CORS header this needs on the bucket). Anything that isn't a WAV
// this can parse falls back to downloading the whole file, same as
// before — correctness over a cleverness that doesn't generalize.

import { resolveAudioUrl } from './localAudioStore.js';

const EDGE_SECONDS = 10; // how much of each clip's head/tail we compare
const WINDOW_SEC = 0.05; // ~50ms RMS windows — coarse but resistant to bit-level noise
// Raised from 0.55 after measuring both sides directly with a real
// (synthetic but non-periodic) splice: a genuine byte-exact overlap scores
// 0.84-0.95 here, while an unrelated pairing can still drift up to ~0.5-0.6
// by pure chance (two independent amplitude envelopes both trending
// "smoothly", or a percussive one echoing its own general shape elsewhere
// in the same track) — 0.55 was inside that noise band, letting an
// upload's *irrelevant* side (e.g. an outro's own new tail material,
// compared against some other song's head) occasionally read as a
// confident second match and get misclassified as a Transition instead of
// a plain Outro/Intro. 0.7 sits well clear of every false positive
// measured (~0.6 max) while every genuine match measured cleared 0.8.
const MATCH_THRESHOLD = 0.7;

let sharedAudioCtx = null;
function getAudioContext() {
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

// ---------------------------------------------------------------------------
// Range-fetch fast path (WAV/PCM only — see the header comment above for why
// AIFF/FLAC/MP3 fall back to the full-file fetch instead of trying to fake
// their way through this).
// ---------------------------------------------------------------------------

function readAscii(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// Walks a WAV's RIFF chunks to find 'fmt ' and 'data' rather than assuming
// the classic "always at byte 44" layout — a DAW export can carry extra
// metadata chunks (LIST, fact, …) before the actual samples.
function parseWavHeader(bytes) {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(dv, 0, 4) !== 'RIFF' || readAscii(dv, 8, 4) !== 'WAVE') return null;
  let offset = 12, fmt = null, dataOffset = null, dataSize = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(dv, offset, 4);
    const chunkSize = dv.getUint32(offset + 4, true);
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(offset + 8, true),
        numChannels: dv.getUint16(offset + 10, true),
        sampleRate: dv.getUint32(offset + 12, true),
        byteRate: dv.getUint32(offset + 16, true),
        blockAlign: dv.getUint16(offset + 20, true),
        bitsPerSample: dv.getUint16(offset + 22, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt || dataOffset == null || !fmt.byteRate) return null;
  return { ...fmt, dataOffset, dataSize };
}

// Wraps a slice of raw PCM bytes in a fresh, internally-consistent 44-byte
// WAV header (sized to exactly that slice) so decodeAudioData sees a valid
// standalone file instead of a bare fragment — never relies on a browser
// tolerating a header whose declared chunk sizes don't match the buffer.
function wavBlobFrom(fmt, pcmBytes) {
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const writeAscii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeAscii(0, 'RIFF'); dv.setUint32(4, 36 + pcmBytes.byteLength, true); writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, fmt.audioFormat, true);
  dv.setUint16(22, fmt.numChannels, true); dv.setUint32(24, fmt.sampleRate, true);
  dv.setUint32(28, fmt.byteRate, true); dv.setUint16(32, fmt.blockAlign, true); dv.setUint16(34, fmt.bitsPerSample, true);
  writeAscii(36, 'data'); dv.setUint32(40, pcmBytes.byteLength, true);
  return new Blob([header, pcmBytes]);
}

async function rangeGet(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) throw new Error('range fetch failed: ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

// Gets exactly what detection needs from a WAV reference — an exact
// duration (from the header, not a decoded buffer) plus head/tail RMS
// envelopes — via one small probe GET and up to two small range GETs,
// instead of downloading the whole file. Returns null (caller falls back
// to fetchAndDecode) for anything this can't safely fast-path: not a WAV,
// not plain PCM, a header that didn't fit the probe, or a server that
// doesn't answer Range requests (some do return 200 with the full body
// instead of erroring, which still works here, just without the savings).
export async function fetchEdgesRanged(url, edgeSeconds = EDGE_SECONDS) {
  let probe;
  try { probe = await rangeGet(url, 0, 65535); } catch (e) { return null; }
  const fmt = parseWavHeader(probe);
  if (!fmt || fmt.audioFormat !== 1) return null; // 1 = PCM; anything else isn't safe to hand-reconstruct

  const duration = fmt.dataSize / fmt.byteRate;
  const edgeBytes = Math.min(fmt.dataSize, Math.floor((edgeSeconds * fmt.byteRate) / fmt.blockAlign) * fmt.blockAlign);
  const dataEnd = fmt.dataOffset + fmt.dataSize;

  // The probe already carries the start of the data chunk — top up only
  // the remainder past it instead of re-requesting bytes it already has.
  const headPcmEnd = fmt.dataOffset + edgeBytes;
  let headPcm;
  if (probe.length >= headPcmEnd) {
    headPcm = probe.slice(fmt.dataOffset, headPcmEnd);
  } else {
    const already = probe.slice(fmt.dataOffset, probe.length);
    const rest = await rangeGet(url, probe.length, headPcmEnd - 1);
    headPcm = new Uint8Array(already.length + rest.length);
    headPcm.set(already, 0);
    headPcm.set(rest, already.length);
  }

  const tailStart = Math.max(fmt.dataOffset, dataEnd - edgeBytes);
  const tailPcm = await rangeGet(url, tailStart, dataEnd - 1);

  const [headBuffer, tailBuffer] = await Promise.all([
    decodeArrayBuffer(await wavBlobFrom(fmt, headPcm).arrayBuffer()),
    decodeArrayBuffer(await wavBlobFrom(fmt, tailPcm).arrayBuffer()),
  ]);
  return { headEnv: headEnvelope(headBuffer, edgeSeconds), tailEnv: tailEnvelope(tailBuffer, edgeSeconds), duration };
}

// Mono-mixed RMS envelope over fixed-size windows.
function rmsEnvelope(buffer, startSample, endSample, windowSize) {
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

export function headEnvelope(buffer, seconds = EDGE_SECONDS) {
  const windowSize = Math.max(1, Math.round(buffer.sampleRate * WINDOW_SEC));
  const end = Math.min(buffer.length, Math.round(buffer.sampleRate * seconds));
  return rmsEnvelope(buffer, 0, end, windowSize);
}
export function tailEnvelope(buffer, seconds = EDGE_SECONDS) {
  const windowSize = Math.max(1, Math.round(buffer.sampleRate * WINDOW_SEC));
  const start = Math.max(0, buffer.length - Math.round(buffer.sampleRate * seconds));
  return rmsEnvelope(buffer, start, buffer.length, windowSize);
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
  // length (the ordinary case: a's the dropped clip's own edge, trimmed to
  // its actual short length; b's the reference song's edge, usually the
  // full EDGE_SECONDS window) — sliding a's start across b's whole length
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

// candidateSongs: [{ id, audioUrl, durationSec }] — only songs with a real
// reference track can be matched against. Returns null ids when nothing
// clears the confidence threshold, same shape core.js's
// pickDetectedSongs-based fallback expects, so callers can swap between the
// two without branching on the result shape. leftOutSeconds/rightInSeconds
// are the actual detected splice timecodes (from the winning correlation
// lag), not guesses — null when there was no confident match to derive them from.
// onProgress(checked, total), when given, fires once per reference track
// actually looked at — lets the UI show real "N of M checked" feedback
// instead of one static "Analyzing…" for the whole batch.
export async function detectMatch(file, candidateSongs, onProgress) {
  const dropped = await decodeFile(file);
  const droppedHead = headEnvelope(dropped);
  const droppedTail = tailEnvelope(dropped);

  const withAudio = candidateSongs.filter(s => s.audioUrl);
  let bestLeft = null, bestLeftScore = 0, bestLeftLag = 0, bestLeftRefDuration = 0;
  let bestRight = null, bestRightScore = 0, bestRightLag = 0;

  for (let i = 0; i < withAudio.length; i++) {
    const song = withAudio[i];
    let leftEnv, rightEnv, refDuration;
    // song.audioUrl may be a `local:` marker (IndexedDB, no backend
    // configured) rather than a real fetchable URL — resolve it to its
    // (memoized) `blob:` URL first so both fetch paths below work
    // identically regardless of which storage a reference track used.
    const resolvedUrl = await resolveAudioUrl(song.audioUrl).catch(() => null);
    if (!resolvedUrl) { if (onProgress) onProgress(i + 1, withAudio.length); continue; }
    const ranged = await fetchEdgesRanged(resolvedUrl).catch(() => null);
    if (ranged) {
      leftEnv = ranged.tailEnv; rightEnv = ranged.headEnv; refDuration = ranged.duration;
    } else {
      let ref;
      try { ref = await fetchAndDecode(resolvedUrl); } catch (e) { console.warn('Eskimo Studio: could not fetch reference audio for', song.id, e); if (onProgress) onProgress(i + 1, withAudio.length); continue; }
      leftEnv = tailEnvelope(ref); rightEnv = headEnvelope(ref); refDuration = ref.duration;
    }

    // the dropped file's leading edge should match a candidate's trailing
    // edge — that candidate is the "left side" (what it plays out of)
    const left = bestCorrelation(droppedHead, leftEnv);
    if (left.score > bestLeftScore) { bestLeftScore = left.score; bestLeft = song.id; bestLeftLag = left.lag; bestLeftRefDuration = refDuration; }

    // the dropped file's trailing edge should match a candidate's leading
    // edge — that candidate is the "right side" (what it plays into)
    const right = bestCorrelation(droppedTail, rightEnv);
    if (right.score > bestRightScore) { bestRightScore = right.score; bestRight = song.id; bestRightLag = right.lag; }
    if (onProgress) onProgress(i + 1, withAudio.length);
  }

  const matchedLeft = bestLeftScore >= MATCH_THRESHOLD;
  const matchedRight = bestRightScore >= MATCH_THRESHOLD;
  return {
    leftId: matchedLeft ? bestLeft : null,
    rightId: matchedRight ? bestRight : null,
    leftConfidence: bestLeftScore,
    rightConfidence: bestRightScore,
    // OUT point = where in the full left-song timeline the tail window
    // (which starts at refDuration - EDGE_SECONDS) plus the winning lag falls.
    leftOutSeconds: matchedLeft ? Math.max(0, (bestLeftRefDuration - EDGE_SECONDS) + bestLeftLag * WINDOW_SEC) : null,
    // IN point = where in the right song's own timeline (starting at 0) the
    // winning lag falls — the head window already starts at absolute 0.
    rightInSeconds: matchedRight ? Math.max(0, bestRightLag * WINDOW_SEC) : null,
  };
}
