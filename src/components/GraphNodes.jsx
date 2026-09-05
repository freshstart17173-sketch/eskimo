import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { Icon, ICONS, AlbumArt } from './shared.jsx';

// state is one of null | 'playing' | 'next' | 'later' — the only three
// highlight treatments the graph uses now (no badge, no black-fill-means-
// selected ambiguity).
export function SongNode({ data }) {
  const { song, state, dimmed, hovered, inCount, outCount, onEnter, onLeave, hoverCard } = data;
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
        <AlbumArt className="node-art" />
      </div>
      <div className="node-tags-row">
        <div className="node-tags">
          <span className="tag tag-accent">{song.bpm} BPM</span>
          <span className="tag tag-good">{song.key}</span>
        </div>
        <div className="node-io">↓{inCount} ↑{outCount}</div>
      </div>

      {hoverCard && (
        <div className="hover-card" onMouseEnter={onEnter} onMouseLeave={onLeave}>
          <div className="hover-card-title">{song.title}</div>
          <div className="hover-card-artist">{song.artist}</div>
          <div className="hover-card-row">
            <button className={'hover-toggle' + (hoverCard.isStaged ? ' active' : '')} onClick={hoverCard.onStage}>Stage</button>
            <button className="hover-toggle" disabled={!hoverCard.isStaged} onClick={hoverCard.onConfirm}>Confirm</button>
          </div>
          {hoverCard.isStaged && (
            <div className="hover-card-row">
              <button className={'hover-toggle' + (hoverCard.mode === 'transition' ? ' active' : '')} disabled={!hoverCard.hasTransition} onClick={() => hoverCard.onSetMode('transition')}>Trans.</button>
              <button className={'hover-toggle' + (hoverCard.mode === 'cut' ? ' active' : '')} onClick={() => hoverCard.onSetMode('cut')}>Cut</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EndNode({ data }) {
  const { state, queued, onClick } = data;
  const cls = ['end-node', state && 'state-' + state].filter(Boolean).join(' ');
  return (
    <div className={cls} onClick={onClick}>
      <Handle type="target" position={Position.Left} />
      <div className="end-node-title"><Icon path={<rect x="5" y="5" width="14" height="14" />} filled size={11} /> End Set</div>
      <div className="end-node-hint">{queued ? 'part of your plan' : 'stop here'}</div>
    </div>
  );
}
