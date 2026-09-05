import React, { useState } from 'react';
import { END, fmtTime } from '../core.js';
import { Icon, ICONS, SongPicker, AlbumArt } from './shared.jsx';

function Row({ row, isEnd, isStaged, showToggles, onClick, stagedMode, onSetMode }) {
  const transitionExpired = row.secondsLeft === 0;
  return (
    <div className={'seq-row' + (isStaged ? ' seq-row-staged' : '')} onClick={onClick}>
      <div className="seq-row-main">
        {!isEnd && <AlbumArt className="lib-art" style={{ width: 22, height: 22 }} />}
        <div className="seq-row-text">
          <div className="seq-row-title">{row.title}</div>
          {!isEnd && <div className="seq-row-artist">{row.artist}</div>}
        </div>
        {!isEnd && <span className="seq-row-countdown mono-num">{fmtTime(row.secondsLeft)}</span>}
      </div>
      {showToggles && !isEnd && (
        <div className="seq-row-toggles segmented">
          <button className={'seq-toggle' + (stagedMode === 'transition' ? ' active' : '')} disabled={!row.transitionEdge || transitionExpired}
            onClick={(e) => { e.stopPropagation(); onSetMode('transition'); }}>Transition</button>
          <button className={'seq-toggle' + (stagedMode === 'cut' ? ' active' : '')}
            onClick={(e) => { e.stopPropagation(); onSetMode('cut'); }}>Cut</button>
        </div>
      )}
    </div>
  );
}

export default function SequencePane({
  songs, session, venueName, hasStarted, nowSong, cueBarPct, hasOutroForPlaying,
  nextRows, laterRows, stagedId, stagedMode,
  onTogglePlaying, onResumeSet, onStartSet, onSetEndingChoice,
  onStage, onCommitStaged, onSetStagedMode, onSkipNext,
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
              <AlbumArt className="node-art" style={{ width: 34, height: 34 }} />
              <div className="seq-now-text">
                <div className="seq-now-title">{nowSong.title}</div>
                <div className="seq-now-artist">{nowSong.artist}</div>
              </div>
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
            <button className="btn playhead-next-btn" onClick={onSkipNext}>Next song →</button>

            <div className="seq-ending-row">
              <span className="seq-ending-label">How it ends</span>
              <div className="seq-ending-toggle segmented">
                <button className={'seq-ending-btn' + (session.endingChoice === 'cut' ? ' active' : '')} onClick={() => onSetEndingChoice('cut')}>Cut</button>
                <button className={'seq-ending-btn' + (session.endingChoice === 'outro' ? ' active' : '')} disabled={!hasOutroForPlaying} onClick={() => onSetEndingChoice('outro')}>Outro</button>
              </div>
            </div>
          </div>
        )}

        {session.setEnded && (
          <div className="success-note">
            <span>Set ended.</span>
            <button className="btn btn-primary btn-sm" onClick={onResumeSet}>Start a new set</button>
          </div>
        )}

        {hasStarted && !session.setEnded && (
          <>
            <div>
              <div className="seq-list-title">Next</div>
              <div className="seq-list">
                {nextRows.map(row => (
                  <Row key={row.id} row={row} isEnd={row.id === END} isStaged={stagedId === row.id}
                    showToggles={stagedId === row.id} onClick={() => onStage(row.id)}
                    stagedMode={stagedMode} onSetMode={onSetStagedMode} />
                ))}
                {nextRows.length === 0 && <div className="seq-empty">nothing built out of this song yet</div>}
              </div>
              {stagedId && (
                <button className="btn btn-accent btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={onCommitStaged}>
                  Set {songs[stagedId] ? songs[stagedId].title : 'End Set'} as Next
                </button>
              )}
            </div>

            <div>
              <div className="seq-list-title">Later</div>
              <div className="seq-list">
                {laterRows.map(row => (
                  <Row key={row.id} row={row} isEnd={false} isStaged={false} showToggles={false} onClick={() => {}} />
                ))}
                {!stagedId && <div className="seq-empty">pick something in Next to preview what follows it</div>}
                {stagedId && laterRows.length === 0 && <div className="seq-empty">nothing built past that pick yet</div>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
