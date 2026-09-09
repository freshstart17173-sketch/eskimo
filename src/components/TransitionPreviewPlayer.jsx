import React, { useEffect, useRef, useState } from 'react';
import { fmtTime, clamp } from '../core.js';
import { getAudioContext } from '../audioDetect.js';
import { buildTransitionPreviewBuffer, buildEdgePreviewBuffer, previewEnvelope } from '../transitionPreview.js';
import { Icon, ICONS } from './shared.jsx';

const WINDOW_SEC = 0.05;

// Peak-normalized bar heights, same "never fully flat" floor LiveWaveform
// (GraphNodes.jsx) uses for its live meter — a window of true silence
// still reads as a sliver, not a gap in the bar row.
function barHeights(envelope) {
  let max = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] > max) max = envelope[i];
  if (max <= 0) return Array.from(envelope, () => 12);
  return Array.from(envelope, (v) => Math.round(12 + (v / max) * 88));
}

// Add Audio's "Listen before you save it" — always plays exactly the
// window the requirement asks for (edgeSeconds of the left song ending at
// its OUT cue, the whole dropped clip, edgeSeconds of the right song
// starting at its IN cue — see transitionPreview.js), never the whole
// dropped file and never the whole reference song either. The waveform
// colors that middle span (the actual dropped clip) differently from the
// original audio on either side, with a labeled bracket over it, so the
// transition itself is visible before it's ever heard.
//
// Playback is a real AudioBufferSourceNode + GainNode through
// audioDetect.js's shared AudioContext — never audioEngine.js's own
// engine, which is wired to real Now Playing and has no notion of a
// scratch preview. A source node can't seek or pause-and-resume in
// place, so pausing/seeking always stops the current node and (if
// playback should continue) starts a fresh one at the new offset — the
// same anchor-based position tracking (a ctx-time + an offset, not a
// running clock) audioEngine.js itself uses, which is what makes the
// rAF-driven playhead immune to the drift a setInterval clock would add.
// `file` (Add Audio's not-yet-uploaded drop) and `edgeUrl` (Library's
// already-saved edge) are mutually exclusive sources for the same clip —
// exactly one is ever passed by a given caller — routed to
// buildTransitionPreviewBuffer/buildEdgePreviewBuffer respectively so
// there's one shared trim/scope/concat implementation regardless of which
// stage of the audio's life this is previewing.
export default function TransitionPreviewPlayer({ file, edgeUrl, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null); // { buffer, regions, envelope } | null
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [volumeOpen, setVolumeOpen] = useState(false);

  const dataRef = useRef(null);
  const gainNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const startCtxTimeRef = useRef(0);
  const startOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const rafRef = useRef(null);

  const waveRef = useRef(null);
  const scrubRef = useRef(null);
  const playheadRef = useRef(null);
  const scrubFillRef = useRef(null);
  const timeNowRef = useRef(null);
  const volumeRootRef = useRef(null);
  const bracketRef = useRef(null);
  // Which side of the transition boundary playback was on last frame — a
  // plain boolean isn't enough to know when the switch actually *happens*
  // versus merely *is*, and "lights up the moment playback reaches it" was
  // the explicit ask, not just "the boundary looks different while inside
  // it" (already covered by `.in-transition` bars). Compared frame to
  // frame here rather than derived from React state, same reasoning as
  // every other continuous value in this component.
  const wasInTransitionRef = useRef(false);
  const litTimerRef = useRef(null);

  useEffect(() => { dataRef.current = data; }, [data]);

  function ensureGain() {
    if (!gainNodeRef.current) {
      const ctx = getAudioContext();
      gainNodeRef.current = ctx.createGain();
      gainNodeRef.current.gain.value = volume;
      gainNodeRef.current.connect(ctx.destination);
    }
    return gainNodeRef.current;
  }

  function cancelRaf() { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; }

  function writeDisplay(offsetSec) {
    const d = dataRef.current;
    if (!d) return;
    const pct = d.buffer.duration ? clamp((offsetSec / d.buffer.duration) * 100, 0, 100) : 0;
    if (playheadRef.current) playheadRef.current.style.left = pct + '%';
    if (scrubFillRef.current) scrubFillRef.current.style.width = pct + '%';
    if (timeNowRef.current) timeNowRef.current.textContent = fmtTime(clamp(offsetSec, 0, d.buffer.duration));

    // "Lights up" the instant playback actually reaches the boundary —
    // not just "looks different while inside it" (the `.in-transition`
    // bar color already covers that) — retriggered on every crossing in
    // either direction (entering the added audio, or landing back on the
    // original past it) by removing and re-adding the class across a
    // frame, since a CSS animation already at its end state doesn't
    // replay just because the class never left.
    const { leftSec, transitionSec } = d.regions;
    const inTransitionNow = offsetSec >= leftSec && offsetSec < leftSec + transitionSec;
    if (inTransitionNow !== wasInTransitionRef.current) {
      wasInTransitionRef.current = inTransitionNow;
      const el = bracketRef.current;
      if (el) {
        el.classList.remove('lit');
        void el.offsetWidth; // force reflow so the next add restarts the animation
        el.classList.add('lit');
        if (litTimerRef.current) clearTimeout(litTimerRef.current);
        litTimerRef.current = setTimeout(() => el.classList.remove('lit'), 500);
      }
    }
  }

  function currentOffset() {
    if (!sourceNodeRef.current) return startOffsetRef.current;
    const ctx = getAudioContext();
    return startOffsetRef.current + (ctx.currentTime - startCtxTimeRef.current);
  }

  function stopPlayback() {
    cancelRaf();
    if (sourceNodeRef.current) {
      const s = sourceNodeRef.current;
      sourceNodeRef.current = null;
      s.onended = null; // a manual stop() would otherwise still fire 'ended'
      try { s.stop(); } catch (e) { /* already stopped/ended */ }
    }
    setPlaying(false);
  }

  function startAt(offsetSec) {
    const d = dataRef.current;
    if (!d) return;
    const ctx = getAudioContext();
    ctx.resume();
    const gain = ensureGain();
    const source = ctx.createBufferSource();
    source.buffer = d.buffer;
    source.connect(gain);
    const clamped = clamp(offsetSec, 0, d.buffer.duration);
    source.start(0, clamped);
    sourceNodeRef.current = source;
    startCtxTimeRef.current = ctx.currentTime;
    startOffsetRef.current = clamped;
    source.onended = () => {
      sourceNodeRef.current = null;
      cancelRaf();
      setPlaying(false);
      startOffsetRef.current = d.buffer.duration;
      writeDisplay(d.buffer.duration);
    };
    setPlaying(true);
    cancelRaf();
    const tick = () => {
      if (!sourceNodeRef.current) return;
      const offset = currentOffset();
      if (offset >= d.buffer.duration) return; // onended finishes the job
      writeDisplay(offset);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function togglePlay() {
    const d = dataRef.current;
    if (!d) return;
    if (sourceNodeRef.current) {
      const offset = currentOffset();
      stopPlayback();
      startOffsetRef.current = clamp(offset, 0, d.buffer.duration);
      writeDisplay(startOffsetRef.current);
    } else {
      let offset = startOffsetRef.current;
      if (offset >= d.buffer.duration) offset = 0; // replay from the top once it's played through
      startAt(offset);
    }
  }

  // Decode/build effect — gated on there being a source (file or edgeUrl)
  // and at least one reference song to scope against (the caller only
  // mounts this component under that same condition, but the guard holds
  // regardless). A closure `cancelled` flag is the generation guard: if
  // leftId/rightId/outSeconds/inSeconds changes again before this decode
  // finishes, the stale result is dropped instead of clobbering the newer
  // selection's state.
  useEffect(() => {
    stopPlayback();
    startOffsetRef.current = 0;
    wasInTransitionRef.current = false;
    setData(null); setError('');
    if ((!file && !edgeUrl) || (!leftSong && !rightSong)) return undefined;
    let cancelled = false;
    setLoading(true);
    const build = file
      ? buildTransitionPreviewBuffer({ file, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec })
      : buildEdgePreviewBuffer({ edgeUrl, leftSong, rightSong, outSeconds, inSeconds, clipStartSec, clipEndSec });
    build
      .then((result) => {
        if (cancelled || !result) return;
        const envelope = previewEnvelope(result.buffer, WINDOW_SEC);
        setData({ ...result, envelope });
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('Eskimo Studio: could not build the transition preview', e);
        setError('Could not build a preview for this pairing — save still works from the detected cue points above.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, edgeUrl, leftSong && leftSong.id, rightSong && rightSong.id, outSeconds, inSeconds, clipStartSec, clipEndSec]);

  // Stop cleanly on unmount (navigating away from Add Audio mid-playback).
  useEffect(() => () => { stopPlayback(); if (litTimerRef.current) clearTimeout(litTimerRef.current); }, []);

  // Dual-target scrub: pointerdown/pointermove on the scrub bar AND the
  // waveform itself. Matches Playhead's own (SequencePane.jsx) "preview
  // while dragging, commit on drop" pattern — dragging pauses playback and
  // only restarts the source node (which can't seek in place) on release,
  // rather than tearing one down and rebuilding it on every pixel of
  // movement.
  useEffect(() => {
    if (!data) return undefined;
    const targets = [waveRef.current, scrubRef.current].filter(Boolean);
    function pctFromClientX(clientX, el) {
      const rect = el.getBoundingClientRect();
      if (!rect.width) return 0;
      return clamp((clientX - rect.left) / rect.width, 0, 1);
    }
    function onPointerDown(el) {
      return (e) => {
        e.preventDefault();
        const wasPlaying = !!sourceNodeRef.current;
        if (wasPlaying) stopPlayback();
        draggingRef.current = true;
        const applyFromEvent = (ev) => {
          const pct = pctFromClientX(ev.clientX, el);
          const offset = pct * dataRef.current.buffer.duration;
          startOffsetRef.current = offset;
          writeDisplay(offset);
        };
        applyFromEvent(e);
        function onMove(ev) { if (draggingRef.current) applyFromEvent(ev); }
        function onUp(ev) {
          draggingRef.current = false;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          applyFromEvent(ev);
          if (wasPlaying) startAt(startOffsetRef.current);
        }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };
    }
    const handlers = targets.map((el) => { const h = onPointerDown(el); el.addEventListener('pointerdown', h); return [el, h]; });
    return () => { handlers.forEach(([el, h]) => el.removeEventListener('pointerdown', h)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Volume popover — same "click outside closes it" convention every other
  // popover in this app follows (see VolumeControl, PerformPage.jsx).
  useEffect(() => {
    if (!volumeOpen) return undefined;
    function onDocMouseDown(e) { if (volumeRootRef.current && !volumeRootRef.current.contains(e.target)) setVolumeOpen(false); }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [volumeOpen]);

  function handleVolumeChange(v) {
    setVolume(v);
    if (gainNodeRef.current) gainNodeRef.current.gain.value = v;
  }

  if ((!file && !edgeUrl) || (!leftSong && !rightSong)) return null;

  if (loading) {
    return (
      <div className="transition-preview">
        <div className="hint-text analyzing-hint"><span className="spinner" /> Building preview…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="transition-preview">
        <div className="hint-text">{error}</div>
      </div>
    );
  }
  if (!data) return null;

  const { regions, envelope, buffer } = data;
  const total = buffer.duration;
  const heights = barHeights(envelope);
  const bracketStartPct = total ? (regions.leftSec / total) * 100 : 0;
  const bracketEndPct = total ? ((regions.leftSec + regions.transitionSec) / total) * 100 : 0;
  // Matches AddAudio.jsx's own type logic — which side(s) actually matched
  // decides the label, not a hardcoded "Transition" regardless of type (the
  // exact class of mislabeling reported elsewhere in this round).
  const bracketLabel = leftSong && rightSong ? 'Transition' : rightSong ? 'Intro' : 'Outro';
  // Precise labeled cue markers — direct instruction: a single player that
  // "perfectly shows the in or out points of any added media", not a
  // separate lower-fidelity duplicate display elsewhere on the page (which
  // used to exist and, worse, had the wording backwards for Outro/Intro —
  // see the naming reasoning below).
  //
  // A Transition has a real early cue point on BOTH sides (the surrounding
  // songs are deliberately cut short so the clip can carry the splice) —
  // left = OUT, right = IN, the ordinary meaning. An Outro has no real out
  // point on the left song at all (it always plays to its own full natural
  // duration — see audioEngine.js/core.js) — the only meaningful moment
  // left to mark is where you enter the outro's own new material, so it
  // reads IN instead. An Intro has no real in point on the destination
  // (it always starts fresh at 0) — the meaningful moment is where you
  // exit the intro's own material into the destination, so it reads OUT.
  const leftCueLabel = rightSong ? 'OUT' : 'IN';
  const rightCueLabel = leftSong ? 'IN' : 'OUT';

  return (
    <div className="transition-preview">
      <div className="transition-preview-wave" ref={waveRef}>
        <div className="transition-preview-bracket" ref={bracketRef} style={{ left: bracketStartPct + '%', width: (bracketEndPct - bracketStartPct) + '%' }} />
        {heights.map((h, i) => {
          const t = (i + 0.5) * WINDOW_SEC;
          const inTransition = t >= regions.leftSec && t < regions.leftSec + regions.transitionSec;
          return <span key={i} className={'transition-preview-bar' + (inTransition ? ' in-transition' : '')} style={{ height: h + '%' }} />;
        })}
        <div className="transition-preview-bracket-label" style={{ left: ((bracketStartPct + bracketEndPct) / 2) + '%' }}>
          {bracketLabel} · {fmtTime(regions.transitionSec)}
        </div>
        {leftSong && outSeconds != null && (
          <>
            <div className="waveform-marker" style={{ left: bracketStartPct + '%' }} />
            <div className="waveform-marker-label" style={{ left: bracketStartPct + '%' }}>{leftCueLabel} <span className="mono-num">{fmtTime(outSeconds)}</span></div>
          </>
        )}
        {rightSong && inSeconds != null && (
          <>
            <div className="waveform-marker" style={{ left: bracketEndPct + '%' }} />
            <div className="waveform-marker-label" style={{ left: bracketEndPct + '%' }}>{rightCueLabel} <span className="mono-num">{fmtTime(inSeconds)}</span></div>
          </>
        )}
        <div className="transition-preview-playhead" ref={playheadRef} />
      </div>
      <div className="transition-preview-controls">
        <button className="icon-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          <Icon path={playing ? ICONS.pause : ICONS.play} filled={!playing} size={13} />
        </button>
        <span className="transition-preview-time mono-num" ref={timeNowRef}>0:00</span>
        <div className="transition-preview-scrub" ref={scrubRef}>
          <div className="transition-preview-scrub-fill" ref={scrubFillRef} />
        </div>
        <span className="transition-preview-time mono-num">{fmtTime(total)}</span>
        <div className="player-bar-volume" ref={volumeRootRef}>
          <button className="icon-btn" aria-label="Volume" onClick={() => setVolumeOpen(o => !o)}>
            <Icon path={ICONS.volume} size={14} />
          </button>
          {volumeOpen && (
            <div className="player-bar-volume-popover">
              <input type="range" min="0" max="1" step="0.01" value={volume} onChange={(e) => handleVolumeChange(Number(e.target.value))} aria-label="Volume" autoFocus />
            </div>
          )}
        </div>
      </div>
      <div className="transition-preview-note">Always just this window — the original audio around the splice, never the whole dropped file.</div>
    </div>
  );
}
