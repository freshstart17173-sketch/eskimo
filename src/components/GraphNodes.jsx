import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { fmtTime } from '../core.js';
import { Icon, ICONS, AlbumArt } from './shared.jsx';

// Short, monochrome type glyphs for the socket dots — matching this app's
// existing brutalist habit (the "↓1 ↑2" in/out counts, the plain-ink tags)
// of coding meaning through typography rather than hue. A dominant-color-
// per-song scheme was tried in design and explicitly rejected: it doesn't
// read cleanly and a dark/busy cover breaks the whole mental model, so
// sockets stay a small fixed, type-coded alphabet instead.
const SOCKET_LABEL = { none: 'N', intro: 'I', outro: 'O', transition: 'T' };
const SOCKET_TITLE = { none: 'None', intro: 'Intro', outro: 'Outro', transition: 'Transition' };

// Evenly spaced vertical offsets for however many sockets a side actually
// has (1-3) — React Flow's Handle positions itself with inline top/left
// math based on the `position` prop, which flexbox can't reach since an
// absolutely-positioned element ignores its parent's flex layout, so the
// spacing has to be computed explicitly instead.
function socketTop(index, count) {
  if (count === 1) return 50;
  if (count === 2) return index === 0 ? 34 : 66;
  return 22 + index * 28; // 3: 22/50/78
}

// Up to three typed sockets along a node's left or right edge, each a real
// React Flow `Handle` (not a plain div) so Phase 3's drag-to-connect has
// something to attach to — inert for now since nodesConnectable is still
// off at the ReactFlow level. `active` is the type currently in effect for
// that side (from activePlaylist); everything else renders hollow.
// None/Intro/Outro toggle directly on click; a Transition socket only
// ever gets set by a real drag, so it gets no click handler at all.
function SocketColumn({ side, types, active, onToggle }) {
  if (!types || types.length === 0) return null;
  return types.map((type, i) => (
    <Handle
      key={type} type={side === 'left' ? 'target' : 'source'} position={side === 'left' ? Position.Left : Position.Right}
      id={side + '-' + type} isConnectable={false}
      style={{ top: socketTop(i, types.length) + '%' }}
      className={'node-socket' + (active === type ? ' node-socket-active' : '') + (type === 'transition' ? '' : ' node-socket-clickable')}
      data-tooltip={SOCKET_TITLE[type]} data-tooltip-above={side === 'left' ? undefined : true}
      onClick={type === 'transition' ? undefined : (e) => { e.stopPropagation(); onToggle(side, type); }}
    >
      <span className="node-socket-label">{SOCKET_LABEL[type]}</span>
    </Handle>
  ));
}

// state is one of null | 'playing' | 'next' | 'later' — the only three
// highlight treatments the graph uses now (no badge, no black-fill-means-
// selected ambiguity).
export function SongNode({ data }) {
  const {
    song, state, dimmed, hovered, inCount, outCount, onEnter, onLeave, playing, position,
    leftTypes, rightTypes, leftActive, rightActive, leftLabel, rightLabel, onToggleSocket,
  } = data;
  const cls = ['node-card', state && 'state-' + state, hovered && 'node-hovered', dimmed && 'node-dimmed'].filter(Boolean).join(' ');
  return (
    <div className={cls} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <SocketColumn side="left" types={leftTypes} active={leftActive} onToggle={(side, type) => onToggleSocket(song.id, side, type)} />
      <SocketColumn side="right" types={rightTypes} active={rightActive} onToggle={(side, type) => onToggleSocket(song.id, side, type)} />
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
      {(leftLabel || rightLabel) && (
        <div className="node-connection-labels">
          {leftLabel && <div className="node-connection-label node-connection-label-left">← {leftLabel}</div>}
          {rightLabel && <div className="node-connection-label node-connection-label-right">{rightLabel} →</div>}
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
