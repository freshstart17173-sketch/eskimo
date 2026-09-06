import React, { useState, useRef, useEffect } from 'react';
import { fmtTime, clamp } from '../core.js';
import { Icon, ICONS, SongPicker, AlbumArt, useResolvedAudioUrl } from './shared.jsx';

// A self-contained play/pause toggle over the row's own built audio (a
// transition's fragment, or a cut/outro candidate's intro) — stops the
// click from reaching the card underneath it, so previewing never
// accidentally commits the pick the way clicking the card itself does.
// `url` may be a `local:` marker (IndexedDB, no backend configured — see
// localAudioStore.js) rather than a real URL; resolving it is async, so
// the button plays a moment after the resolve rather than on the very
// first click for locally-stored audio.
function PreviewButton({ url }) {
  const resolvedUrl = useResolvedAudioUrl(url);
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  function toggle(e) {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else { el.currentTime = 0; el.play(); }
  }
  return (
    <button className="seq-card-preview" onClick={toggle} aria-label={playing ? 'Pause preview' : 'Preview'} data-tooltip={playing ? 'Pause preview' : 'Preview'} data-tooltip-above>
      <Icon path={playing ? ICONS.pause : ICONS.play} filled={!playing} size={10} />
      <audio ref={audioRef} src={resolvedUrl || undefined} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} style={{ display: 'none' }} />
    </button>
  );
}

// One candidate — either a produced transition (own card, cue countdown +
// drain bar, destination shown underneath the label) or a cut/outro target
// (destination is the headline, no cue since a hard cut has no urgency).
// A single flat list of these, no nested sub-lists: clicking commits
// immediately, there's no separate stage-then-confirm step anymore — a
// built audio piece gets its own preview button instead, precisely so a
// listen doesn't double as a commit.
function Card({ row, onClick, onMouseEnter, onMouseLeave, onFocusRow, readOnly }) {
  const drainPct = (row.kind === 'transition' && row.hasCue && row.basisSec)
    ? clamp(Math.round((row.secondsLeft / row.basisSec) * 100), 0, 100) : 0;
  const label = row.kind === 'transition'
    ? (row.label || 'Transition') + ' into ' + row.destTitle
    : row.destTitle + (row.hasIntro ? ', has an intro' : '');
  const content = (
    <>
      {row.kind === 'transition' && <div className="seq-card-drain" style={{ width: drainPct + '%' }} />}
      <div className="seq-card-main">
        <AlbumArt className="seq-card-art" url={row.destCoverUrl} />
        <div className="seq-card-text">
          {row.kind === 'transition' ? (
            <>
              <div className="seq-card-label">{row.label || 'Transition'}</div>
              <div className="seq-card-sub">{row.destTitle} <span className="seq-card-sub-artist">{row.destArtist}</span></div>
            </>
          ) : (
            <>
              <div className="seq-card-label">{row.destTitle}</div>
              <div className="seq-card-sub">
                {row.destArtist}
                {row.hasIntro && <span className="tag tag-good seq-card-intro-tag">Intro</span>}
              </div>
            </>
          )}
        </div>
        {row.previewUrl && <PreviewButton url={row.previewUrl} />}
        <div className="seq-card-nums">
          {row.kind === 'transition' && row.hasCue && <span className="seq-card-cue mono-num">{fmtTime(row.secondsLeft)}</span>}
          <span className="seq-card-length mono-num">{fmtTime(row.destDurationSec)}</span>
        </div>
      </div>
    </>
  );
  // Read-only (Later preview) cards are genuinely inert — no button
  // semantics to fake. The real Next cards are actual <button>s (not a
  // div+onClick) so Tab/Enter/Space work without any hand-rolled key
  // handling, and focusing one mirrors hover — the same "what would this
  // lead to" preview a mouse hover gives — so a keyboard-only pass over
  // the list gets the same information a sighted mouse user does.
  if (readOnly) return <div className="seq-card seq-card-readonly">{content}</div>;
  return (
    <button
      type="button" className="seq-card" aria-label={label} onClick={onClick}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      onFocus={() => { onMouseEnter(); if (onFocusRow) onFocusRow(); }} onBlur={onMouseLeave}
    >
      {content}
    </button>
  );
}

// Click-anywhere-or-drag scrubbing on the progress bar — it used to be
// purely decorative (a width/left percentage with no listeners at all).
// Dragging updates the shown position locally on every move (so it tracks
// the cursor smoothly) but only commits the actual seek — restarting the
// real audio deck, via `onSeek` — on release, the same "preview while
// dragging, commit on drop" pattern most scrubbers use, rather than
// restarting the audio buffer on every pixel of movement.
function Playhead({ pct, onSeek }) {
  const trackRef = useRef(null);
  const [dragPct, setDragPct] = useState(null);
  const draggingRef = useRef(false);
  const moveRef = useRef(null);
  const upRef = useRef(null);

  function pctFromEvent(e) {
    const rect = trackRef.current.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
  }
  function onPointerDown(e) {
    e.preventDefault();
    draggingRef.current = true;
    setDragPct(pctFromEvent(e));
    moveRef.current = (ev) => { if (draggingRef.current) setDragPct(pctFromEvent(ev)); };
    upRef.current = (ev) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const p = pctFromEvent(ev);
      window.removeEventListener('pointermove', moveRef.current);
      window.removeEventListener('pointerup', upRef.current);
      setDragPct(null);
      onSeek(p / 100);
    };
    window.addEventListener('pointermove', moveRef.current);
    window.addEventListener('pointerup', upRef.current);
  }
  useEffect(() => () => {
    if (moveRef.current) window.removeEventListener('pointermove', moveRef.current);
    if (upRef.current) window.removeEventListener('pointerup', upRef.current);
  }, []);

  const shownPct = dragPct != null ? dragPct : pct;
  return (
    <div className="playhead-track" ref={trackRef} onPointerDown={onPointerDown}>
      <div className="playhead-fill" style={{ width: shownPct + '%' }} />
      <div className="playhead-scrubber" style={{ left: shownPct + '%' }} />
    </div>
  );
}

export default function SequencePane({
  songs, session, venueName, hasStarted, nowSong, cueBarPct, hasOutroForPlaying,
  mixingIntoSong, crossfadePct,
  nextRows, laterRows, setHoveredId,
  startPickId, onSetStartPick,
  onTogglePlaying, onResumeSet, onPlayAgain, onStartSet, onSetNextMode,
  onCommitRow, onSkipNext, onSeek,
}) {
  const [startStarting, setStartStarting] = useState('cut');

  // When a transition's cue point passes unpicked, PerformPage drops it
  // from nextRows outright (see the redesign note there) — if that card
  // happened to have keyboard focus, the focus would otherwise just
  // vanish into the document body. Track which row is focused and, if it
  // disappears, land on whatever now sits in its old slot (transition mode
  // sorts soonest-first, so that's genuinely "the next one").
  const listRef = useRef(null);
  const focusedKeyRef = useRef(null);
  const prevRowsRef = useRef(nextRows);
  useEffect(() => {
    const prevRows = prevRowsRef.current;
    prevRowsRef.current = nextRows;
    const focusedKey = focusedKeyRef.current;
    if (!focusedKey || session.nextMode !== 'transition') return;
    if (nextRows.some(r => r.key === focusedKey)) return;
    const prevIndex = prevRows.findIndex(r => r.key === focusedKey);
    if (prevIndex === -1 || nextRows.length === 0) { focusedKeyRef.current = null; return; }
    const targetIndex = Math.min(prevIndex, nextRows.length - 1);
    focusedKeyRef.current = nextRows[targetIndex].key;
    const el = listRef.current && listRef.current.querySelectorAll('.seq-card')[targetIndex];
    if (el) el.focus();
  }, [nextRows, session.nextMode]);

  return (
    <div className="sequence-pane">
      <div className="seq-scroll">
        <div className="seq-venue">{venueName || 'Untitled session'}</div>

        {!hasStarted ? (
          <div className="seq-start-card">
            <div className="section-label">Start the set</div>
            <SongPicker songs={songs} value={startPickId} onChange={onSetStartPick} placeholder="Search songs…" />
            {startPickId && (
              <>
                <div className="seq-row-toggles segmented" style={{ marginTop: 9 }}>
                  <button className={'seq-toggle' + (startStarting === 'cut' ? ' active' : '')} aria-pressed={startStarting === 'cut'} onClick={() => setStartStarting('cut')}>Cut</button>
                  <button className={'seq-toggle' + (startStarting === 'intro' ? ' active' : '')} aria-pressed={startStarting === 'intro'} onClick={() => setStartStarting('intro')}>Intro</button>
                </div>
                <button className="btn btn-primary" style={{ width: '100%', marginTop: 9 }} onClick={() => onStartSet(startPickId, startStarting)}>Start playing</button>
              </>
            )}
          </div>
        ) : (
          <div className="seq-now-card">
            <div className="section-label section-label-dark">Playing</div>
            <div className="seq-now-row">
              <button className="seq-play-btn" onClick={onTogglePlaying} aria-label={session.isPlaying ? 'Pause' : 'Play'}>
                <Icon path={session.isPlaying ? ICONS.pause : ICONS.play} filled={!session.isPlaying} size={14} />
              </button>
              <AlbumArt className="node-art" style={{ width: 34, height: 34 }} url={nowSong.coverUrl} />
              <div className="seq-now-text">
                <div className="seq-now-title">{nowSong.title}</div>
                <div className="seq-now-artist">{nowSong.artist}</div>
              </div>
              <button className="seq-skip-btn" onClick={onSkipNext} aria-label="Skip to next" data-tooltip="Skip to next" data-tooltip-above>
                <Icon path={ICONS.skip} filled size={15} />
              </button>
            </div>
            <div className="seq-now-tags">
              <span className="tag">{nowSong.bpm} BPM</span>
              <span className="tag">{nowSong.key}</span>
            </div>
            <Playhead pct={cueBarPct} onSeek={onSeek} />
            <div className="playhead-times">
              <span className="mono-num">{fmtTime(nowSong.durationSec - session.timeLeft)}</span>
              <span className="mono-num">{fmtTime(nowSong.durationSec)}</span>
            </div>

            {mixingIntoSong && (
              <div className="seq-mixing-row">
                <span className="seq-mixing-label">Mixing into</span>
                <AlbumArt className="node-art" style={{ width: 30, height: 30 }} url={mixingIntoSong.coverUrl} />
                <div className="seq-mixing-text">
                  <div className="seq-mixing-title">{mixingIntoSong.title}</div>
                  <div className="seq-mixing-artist">{mixingIntoSong.artist}</div>
                </div>
                <span className="seq-mixing-pct mono-num">{crossfadePct}%</span>
              </div>
            )}

            <div className="seq-mode-row">
              <span className="seq-mode-label">Next</span>
              <div className="seq-mode-toggle segmented">
                <button className={'seq-ending-btn' + (session.nextMode === 'transition' ? ' active' : '')} aria-pressed={session.nextMode === 'transition'} onClick={() => onSetNextMode('transition')}>Transition</button>
                <button className={'seq-ending-btn' + (session.nextMode === 'cut' ? ' active' : '')} aria-pressed={session.nextMode === 'cut'} onClick={() => onSetNextMode('cut')}>Cut</button>
                <button
                  className={'seq-ending-btn' + (session.nextMode === 'outro' ? ' active' : '')} aria-pressed={session.nextMode === 'outro'}
                  disabled={!hasOutroForPlaying} onClick={() => onSetNextMode('outro')}
                  data-tooltip={!hasOutroForPlaying ? 'No outro produced for this song' : undefined} data-tooltip-above
                >Outro</button>
              </div>
            </div>
          </div>
        )}

        {session.setEnded && (
          <div className="success-note">
            <span>Set ended{nowSong ? ` — ${nowSong.title} had nowhere built to go next` : ''}.</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary btn-sm" onClick={onPlayAgain}>Play again</button>
              <button className="btn btn-ghost btn-sm" onClick={onResumeSet}>Pick another</button>
            </div>
          </div>
        )}

        {hasStarted && !session.setEnded && (
          <div>
            <div className="seq-list-title">Next</div>
            <div className="seq-list" ref={listRef}>
              {nextRows.map(row => (
                <Card
                  key={row.key} row={row} onClick={() => onCommitRow(row)}
                  onMouseEnter={() => setHoveredId(row.destId)} onMouseLeave={() => setHoveredId(null)}
                  onFocusRow={() => { focusedKeyRef.current = row.key; }}
                />
              ))}
              {nextRows.length === 0 && (
                <div className="seq-empty">
                  {session.nextMode === 'transition' ? 'nothing built out of this song yet — try Cut or Outro' : 'nothing else to jump to'}
                </div>
              )}
            </div>

            {laterRows.length > 0 && (
              <div className="seq-later-preview">
                <div className="seq-list-title">If you pick that</div>
                <div className="seq-list seq-list-compact">
                  {laterRows.map(row => <Card key={row.key} row={row} readOnly />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
