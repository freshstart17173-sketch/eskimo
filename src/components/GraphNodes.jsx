import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { fmtTime } from '../core.js';
import { Icon, ICONS, AlbumArt } from './shared.jsx';

// state is one of null | 'playing' | 'next' | 'later' — the only three
// highlight treatments the graph uses now (no badge, no black-fill-means-
// selected ambiguity).
export function SongNode({ data }) {
  const { song, state, dimmed, hovered, inCount, outCount, onEnter, onLeave, hoverCard, playing, position } = data;
  const cls = ['node-card', state && 'state-' + state, hovered && 'node-hovered', dimmed && 'node-dimmed'].filter(Boolean).join(' ');
  return (
    <div className={cls} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="node-title-row">
        <div>
          <div className="node-title">{song.title}</div>
          <div className="node-artist">{song.artist}</div>
        </div>
        <AlbumArt className="node-art" url={song.coverUrl} />
      </div>
      <div className="node-tags-row">
        <div className="node-tags">
          <span className="tag tag-accent">{song.bpm} BPM</span>
          <span className="tag tag-good">{song.key}</span>
        </div>
        <div className="node-io">↓{inCount} ↑{outCount}</div>
      </div>
      {playing && (
        <div className="node-playing-row">
          <div className="node-waveform"><span /><span /><span /><span /><span /></div>
          {position && <div className="node-position mono-num">{fmtTime(position.elapsed)} / {fmtTime(position.duration)}</div>}
        </div>
      )}

      {hoverCard && (
        <div className="hover-card" onMouseEnter={onEnter} onMouseLeave={onLeave}>
          <div className="hover-card-title">{song.title}</div>
          <div className="hover-card-artist">{song.artist}</div>
          <div className="hover-card-ending-row segmented">
            <button className="hover-ending-btn" disabled={!hoverCard.transition} onClick={hoverCard.transition && hoverCard.transition.onCommit}>Transition</button>
            <button className="hover-ending-btn" disabled={!hoverCard.cut} onClick={hoverCard.cut && hoverCard.cut.onCommit}>Cut</button>
            <button className="hover-ending-btn" disabled={!hoverCard.outro} onClick={hoverCard.outro && hoverCard.outro.onCommit} data-tooltip={!hoverCard.outro ? 'No outro produced for this song' : undefined}>Outro</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Purely informational on the canvas — shows where End Set sits in the plan
// (highlighted next/later like any other hop) but isn't itself clickable:
// the real trigger lives in the toolbar, deliberately apart from the graph
// so panning/clicking around the canvas can't end the set by accident.
export function EndNode({ data }) {
  const { state, queued } = data;
  const cls = ['end-node', state && 'state-' + state].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} />
      <div className="end-node-title"><Icon path={<rect x="5" y="5" width="14" height="14" />} filled size={11} /> End Set</div>
      <div className="end-node-hint">{queued ? 'part of your plan' : 'not queued'}</div>
    </div>
  );
}
