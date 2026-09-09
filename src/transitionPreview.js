// Builds the scoped audio the Add Audio transition-preview player actually
// plays: never the whole dropped file, never the whole reference song —
// just `edgeSeconds` of the left song ending at its OUT cue, the whole
// dropped clip, then `edgeSeconds` of the right song starting at its IN
// cue (see the player's own requirement, quoted in full in the plan this
// implements). Intro-only/outro-only uploads (only one reference song)
// get one edge slice instead of two — the dropped clip is never withheld
// just because only one side matched.
//
// Everything here decodes through audioDetect.js's own shared
// AudioContext (see getAudioContext there) rather than a new one:
// `decodeAudioData` resamples to the context it's called on, so every
// buffer built through the same context already shares one sample rate
// with no explicit resampling step needed — the reason this reuses that
// context instead of standing up a third one alongside it and
// audioEngine.js's real playback engine.

import { getAudioContext, rmsEnvelope, decodeFile, fetchAndDecode } from './audioDetect.js';
import { resolveAudioUrl } from './localAudioStore.js';

// Channel counts are NOT auto-normalized the way sample rate is — a mono
// reference song next to a stereo dropped clip (or vice versa) needs
// reconciling by hand. Real masters here are essentially always mono or
// stereo, so this duplicates a mono channel into both output channels
// and, for anything wider, just takes channels 0/1 — no general downmix
// matrix, which would be solving a problem nobody's masters actually have.
function toStereoChannelData(buffer) {
  if (buffer.numberOfChannels === 1) {
    const mono = buffer.getChannelData(0);
    return [mono, mono];
  }
  return [buffer.getChannelData(0), buffer.getChannelData(1)];
}

function sliceBuffer(ctx, buffer, startSec, endSec) {
  const startSample = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const endSample = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
  const length = Math.max(0, endSample - startSample);
  const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, length), buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(startSample, endSample), c, 0);
  }
  return out;
}

// `side` is 'out' (the left song — slice ends AT cueSeconds, running
// backward edgeSeconds) or 'in' (the right song — slice starts AT
// cueSeconds, running forward edgeSeconds). Resolves a `local:` marker
// the same way audioDetect.js's own detection path does, so this works
// identically regardless of which storage a reference track used.
export async function loadEdgeSlice(song, cueSeconds, side, edgeSeconds = 3) {
  if (!song || !song.audioUrl || cueSeconds == null) return null;
  const url = await resolveAudioUrl(song.audioUrl).catch(() => null);
  if (!url) return null;
  const full = await fetchAndDecode(url);
  const ctx = getAudioContext();
  const startSec = side === 'out' ? Math.max(0, cueSeconds - edgeSeconds) : Math.max(0, cueSeconds);
  const endSec = side === 'out' ? cueSeconds : Math.min(full.duration, cueSeconds + edgeSeconds);
  return sliceBuffer(ctx, full, startSec, endSec);
}

// The one buffer the player actually plays, plus where its three regions
// land (seconds, in playback order) so the waveform can color/label them
// without recomputing boundaries of its own. A side with no reference
// song (or no detected cue) simply contributes no slice — its region
// stays 0 rather than the whole thing being withheld.
//
// `clipStartSec`/`clipEndSec` bound the dropped clip's OWN real content —
// see audioDetect.js's detectSpliceForKnownSongs. A real produced upload
// commonly still carries a chunk of the reference song's own audio before
// (Outro/Transition) or after (Intro/Transition) its actual new material,
// because that's how the DJ recorded it — matched, near-identical audio
// the reference-song slices above already cover on their own. Without
// trimming to [clipStartSec, clipEndSec] first, that duplicated stretch
// would play as part of the "transition" region too — on a produced
// master that's a full-length re-export, that's the whole file, which is
// exactly the bug this trim exists to prevent. null/undefined on either
// bound means "no detected boundary there" and falls back to the clip's
// own natural start/end, same as when there's no detected cue at all.
async function assembleTransitionBuffer({ droppedFull, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec, edgeSeconds = 3 }) {
  const ctx = getAudioContext();
  const clipStart = clipStartSec != null ? clipStartSec : 0;
  const clipEnd = clipEndSec != null ? clipEndSec : droppedFull.duration;
  const dropped = (clipStart > 0 || clipEnd < droppedFull.duration)
    ? sliceBuffer(ctx, droppedFull, clipStart, clipEnd)
    : droppedFull;
  const [leftSlice, rightSlice] = await Promise.all([
    (leftSong && outSeconds != null) ? loadEdgeSlice(leftSong, outSeconds, 'out', edgeSeconds) : null,
    (rightSong && inSeconds != null) ? loadEdgeSlice(rightSong, inSeconds, 'in', edgeSeconds) : null,
  ]);

  const parts = [leftSlice, dropped, rightSlice].filter(Boolean);
  const totalLength = parts.reduce((sum, b) => sum + b.length, 0);
  const buffer = ctx.createBuffer(2, Math.max(1, totalLength), ctx.sampleRate);
  let offset = 0;
  parts.forEach((part) => {
    const [l, r] = toStereoChannelData(part);
    buffer.copyToChannel(l, 0, offset);
    buffer.copyToChannel(r, 1, offset);
    offset += part.length;
  });

  return {
    buffer,
    regions: {
      leftSec: leftSlice ? leftSlice.duration : 0,
      transitionSec: dropped.duration,
      rightSec: rightSlice ? rightSlice.duration : 0,
    },
  };
}

// Add Audio's own "listen before you save it" path — the clip is still a
// plain dropped File, not yet uploaded anywhere.
export async function buildTransitionPreviewBuffer({ file, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec, edgeSeconds = 3 }) {
  const droppedFull = await decodeFile(file);
  return assembleTransitionBuffer({ droppedFull, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec, edgeSeconds });
}

// Library's "built audio" preview on an already-saved edge — same
// scoping, just decoding the edge's own stored audioUrl (resolving a
// `local:` marker the same way loadEdgeSlice's reference-song lookups
// do) instead of a dropped File. Without this, Library was playing an
// already-saved edge's entire raw uploaded master start to end — the
// same "whole file, not just the real content" bug the File-based path
// above exists to prevent, just hit from the other place a produced
// upload's audio gets played back. Returns null (rather than throwing)
// when the URL can't resolve, so the caller can fall back cleanly.
export async function buildEdgePreviewBuffer({ edgeUrl, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec, edgeSeconds = 3 }) {
  const resolved = await resolveAudioUrl(edgeUrl).catch(() => null);
  if (!resolved) return null;
  const droppedFull = await fetchAndDecode(resolved);
  return assembleTransitionBuffer({ droppedFull, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec, edgeSeconds });
}

// Thin wrapper over audioDetect.js's own RMS math — the same envelope
// used for match-detection correlation doubles as the preview's waveform
// bar heights, so this doesn't reinvent it.
export function previewEnvelope(buffer, windowSec = 0.05) {
  const windowSize = Math.max(1, Math.round(buffer.sampleRate * windowSec));
  return rmsEnvelope(buffer, 0, buffer.length, windowSize);
}
