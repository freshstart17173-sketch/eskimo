import React, { useState } from 'react';
import { fmtTime, clamp } from '../core.js';
import { Icon, ICONS, SongPicker, AlbumArt } from './shared.jsx';

// One candidate — either a produced transition (own card, cue countdown +
// drain bar, destination shown underneath the label) or a cut/outro target
// (destination is the headline, no cue since a hard cut has no urgency).
// A single flat list of these, no nested sub-lists: clicking commits
// immediately, there's no separate stage-then-confirm step anymore.
function Card({ row, onClick, onMouseEnter, onMouseLeave, readOnly }) {
  const drainPct = (row.kind === 'transition' && row.hasCue && row.basisSec)
    ? clamp(Math.round((row.secondsLeft / row.basisSec) * 100), 0, 100) : 0;
  return (
    <div
      className={'seq-card' + (readOnly ? ' seq-card-readonly' : '')}
      onClick={readOnly ? undefined : onClick}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    >
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
        <div className="seq-card-nums">
          {row.kind === 'transition' && row.hasCue && <span className="seq-card-cue mono-num">{fmtTime(row.secondsLeft)}</span>}
          <span className="seq-card-length mono-num">{fmtTime(row.destDurationSec)}</span>
        </div>
      </div>
    </div>
  );
}

export default function SequencePane({
  songs, session, venueName, hasStarted, nowSong, cueBarPct, hasOutroForPlaying,
  mixingIntoSong, crossfadePct,
  nextRows, laterRows, setHoveredId,
  onTogglePlaying, onResumeSet, onStartSet, onSetNextMode,
  onCommitRow, onSkipNext, onRequestEndSet,
}) {
  const [startPickId, setStartPickId] = useState(null);
  const [startStarting, setStartStarting] = useState('cut');

  return (
    <div className="sequence-pane">
      <div className="seq-scroll">
        <div className="seq-venue">{venueName || 'Untitled session'}</div>

        {!hasStarted ? (
          <div className="seq-start-card">
            <div className="section-label">Start the set</div>
            <SongPicker songs={songs} value={startPickId} onChange={setStartPickId} placeholder="Search songs…" />
            {startPickId && (
              <>
                <div className="seq-row-toggles segmented" style={{ marginTop: 9 }}>
                  <button className={'seq-toggle' + (startStarting === 'cut' ? ' active' : '')} onClick={() => setStartStarting('cut')}>Cut</button>
                  <button className={'seq-toggle' + (startStarting === 'intro' ? ' active' : '')} onClick={() => setStartStarting('intro')}>Intro</button>
                </div>
                <button className="btn btn-primary" style={{ width: '100%', marginTop: 9 }} onClick={() => onStartSet(startPickId, startStarting)}>Start playing</button>
              </>
            )}
          </div>
        ) : (
          <div className="seq-now-card">
            <div className="section-label section-label-dark">Playing</div>
            <div className="seq-now-row">
              <button className="seq-play-btn" onClick={onTogglePlaying}>
                <Icon path={session.isPlaying ? ICONS.pause : ICONS.play} filled={!session.isPlaying} size={14} />
              </button>
              <AlbumArt className="node-art" style={{ width: 34, height: 34 }} url={nowSong.coverUrl} />
              <div className="seq-now-text">
                <div className="seq-now-title">{nowSong.title}</div>
                <div className="seq-now-artist">{nowSong.artist}</div>
              </div>
              <button className="seq-skip-btn" onClick={onSkipNext} data-tooltip="Skip to next" data-tooltip-above>
                <Icon path={ICONS.skip} filled size={15} />
              </button>
            </div>
            <div className="seq-now-tags">
              <span className="tag">{nowSong.bpm} BPM</span>
              <span className="tag">{nowSong.key}</span>
            </div>
            <div className="playhead-track">
              <div className="playhead-fill" style={{ width: cueBarPct + '%' }} />
              <div className="playhead-scrubber" style={{ left: cueBarPct + '%' }} />
            </div>
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
                <button className={'seq-ending-btn' + (session.nextMode === 'transition' ? ' active' : '')} onClick={() => onSetNextMode('transition')}>Transition</button>
                <button className={'seq-ending-btn' + (session.nextMode === 'cut' ? ' active' : '')} onClick={() => onSetNextMode('cut')}>Cut</button>
                <button className={'seq-ending-btn' + (session.nextMode === 'outro' ? ' active' : '')} disabled={!hasOutroForPlaying} onClick={() => onSetNextMode('outro')}>Outro</button>
              </div>
            </div>
            <button className="seq-end-set-link" onClick={onRequestEndSet}>End set…</button>
          </div>
        )}

        {session.setEnded && (
          <div className="success-note">
            <span>Set ended.</span>
            <button className="btn btn-primary btn-sm" onClick={onResumeSet}>Start a new set</button>
          </div>
        )}

        {hasStarted && !session.setEnded && (
          <div>
            <div className="seq-list-title">Next</div>
            <div className="seq-list">
              {nextRows.map(row => (
                <Card
                  key={row.key} row={row} onClick={() => onCommitRow(row)}
                  onMouseEnter={() => setHoveredId(row.destId)} onMouseLeave={() => setHoveredId(null)}
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
