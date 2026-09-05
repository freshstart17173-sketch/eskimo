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
// fall back to pickDetectedSongs (core.js) until that's true. See TODO.md
// for the current cost/perf tradeoff (this fetches each candidate's whole
// file today; range-requesting just the head/tail is the noted follow-up).

const EDGE_SECONDS = 10; // how much of each clip's head/tail we compare
const WINDOW_SEC = 0.05; // ~50ms RMS windows — coarse but resistant to bit-level noise
const MATCH_THRESHOLD = 0.55; // normalized cross-correlation floor to call it a match

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
  const maxLag = Math.min(na.length, nb.length) - 1;
  let best = -Infinity, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0, count = 0;
    for (let i = 0; i < na.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= nb.length) continue;
      sum += na[i] * nb[j];
      count++;
    }
    if (count < 4) continue;
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
export async function detectMatch(file, candidateSongs) {
  const dropped = await decodeFile(file);
  const droppedHead = headEnvelope(dropped);
  const droppedTail = tailEnvelope(dropped);

  let bestLeft = null, bestLeftScore = 0, bestLeftLag = 0, bestLeftRefDuration = 0;
  let bestRight = null, bestRightScore = 0, bestRightLag = 0;

  for (const song of candidateSongs) {
    if (!song.audioUrl) continue;
    let ref;
    try { ref = await fetchAndDecode(song.audioUrl); } catch (e) { console.warn('Eskimo Studio: could not fetch reference audio for', song.id, e); continue; }

    // the dropped file's leading edge should match a candidate's trailing
    // edge — that candidate is the "left side" (what it plays out of)
    const left = bestCorrelation(droppedHead, tailEnvelope(ref));
    if (left.score > bestLeftScore) { bestLeftScore = left.score; bestLeft = song.id; bestLeftLag = left.lag; bestLeftRefDuration = ref.duration; }

    // the dropped file's trailing edge should match a candidate's leading
    // edge — that candidate is the "right side" (what it plays into)
    const right = bestCorrelation(droppedTail, headEnvelope(ref));
    if (right.score > bestRightScore) { bestRightScore = right.score; bestRight = song.id; bestRightLag = right.lag; }
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
