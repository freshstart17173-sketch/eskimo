import React, { createContext, useContext } from 'react';
import { Handle, Position } from '@xyflow/react';
import { fmtTime } from '../core.js';
import { Icon, ICONS, AlbumArt } from './shared.jsx';

// The once-a-second elapsed clock reaches the playing node through context
// instead of through React Flow's own node `data` — seeGraphPane.jsx's
// comment above its node-rebuild effect for why: routing a per-second tick
// through `setNodes` was flickering the disconnect button on every active
// edge in the whole graph, not just ones touching the playing node.
export const NowPlayingContext = createContext({ nowPlayingId: null, elapsed: 0, duration: 0 });

// Fixed, per-type socket colors — Blender-node-style (a Geometry socket is
// always teal, a Boolean always pink, regardless of which node it's on).
// This is a different thing from the per-song cover-color scheme tried
// earlier and dropped: that varied by *song* and couldn't be trusted to
// read cleanly; this varies by *type* only, a small fixed four-color
// legend that's the same on every node, which is exactly what makes a
// real node editor scannable at a glance.
const SOCKET_TITLE = { none: 'None', intro: 'Intro', outro: 'Outro', transition: 'Transition' };

// A compact ring instead of a linear bar — cheaper on card width, and just
// as readable at a glance. Color sweeps a single HSL hue from green (120°)
// to red (0°) as the cue approaches, which passes through yellow/orange on
// its own without needing separate named thresholds. The ring only starts
// draining inside a short warning window before the cue — full green (and,
// past that window, not rendered at all) the rest of the time, so it reads
// as "still plenty of time" until it actually needs attention.
const RING_WARN_WINDOW_SEC = 20;
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function CountdownRing({ remainingSec }) {
  const pct = clamp01(remainingSec / RING_WARN_WINDOW_SEC);
  const hue = 120 * pct;
  const radius = 7, circumference = 2 * Math.PI * radius;
  const dash = circumference * pct;
  return (
    <svg
      className="socket-countdown-ring" width={16} height={16} viewBox="0 0 18 18"
      role="img" aria-label={'cue in ' + fmtTime(Math.max(0, Math.round(remainingSec)))}
    >
      <circle cx="9" cy="9" r={radius} className="socket-countdown-track" fill="none" />
      <circle
        cx="9" cy="9" r={radius} fill="none" strokeLinecap="round" strokeWidth="2.4"
        stroke={`hsl(${hue}, 75%, 45%)`} strokeDasharray={`${dash} ${circumference}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

// One row: a colored socket dot (a real React Flow `Handle`) plus its
// fixed type label — "Transition"/"Intro"/"Outro" never renames itself to
// whichever specific edge is wired underneath it, since that read as the
// socket changing kind rather than just a choice under a stable one. When
// more than one produced candidate exists for an active slot, a small
// inline dropdown appears next to the label so switching is a plain
// select, not a second popup to drive through. Every socket is drag-
// connectable, since None/Outro on one song can link to None/Intro on a
// *different* song (a plain click can't express which other song to link
// to); None/Intro/Outro additionally toggle on a plain click, for marking
// a song's own ending/starting style with no particular partner in mind
// (e.g. "this is the last song, it just has an outro"). Transition is
// drag-only — two songs only ever have a specific produced transition
// between them, never a generic one to click into existence. Nesting the
// Handle inside a `position: relative` row lets it center on *this row*
// (CSS resolves an absolutely-positioned element against its nearest
// positioned ancestor, not the whole node), so rows can stack via
// ordinary flexbox regardless of how many there are.
function SocketRow({ side, type, active, options, selectedEdgeId, remainingSec, onToggle, onSelectVariant }) {
  const isInput = side === 'left';
  return (
    <div className={'node-socket-row' + (isInput ? '' : ' node-socket-row-right') + (active ? ' node-socket-row-active' : '')}>
      <Handle
        type={isInput ? 'target' : 'source'} position={isInput ? Position.Left : Position.Right}
        id={side + '-' + type} isConnectable
        className={'node-socket node-socket-' + type + (active ? ' node-socket-active' : '') + (type === 'transition' ? ' node-socket-draggable' : ' node-socket-clickable')}
        onClick={type === 'transition' ? undefined : (e) => { e.stopPropagation(); onToggle(side, type); }}
      />
      <span className="node-socket-label">{SOCKET_TITLE[type]}</span>
      {active && options && options.length > 1 && (
        <select
          className="node-socket-select nodrag" value={selectedEdgeId || ''}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => onSelectVariant(side, e.target.value)}
        >
          {options.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
        </select>
      )}
      {active && remainingSec != null && <CountdownRing remainingSec={remainingSec} />}
    </div>
  );
}

function SocketList({ side, types, active, edgeId, options, remainingSec, onToggle, onSelectVariant }) {
  if (!types || types.length === 0) return null;
  return (
    <div className={'node-socket-side' + (side === 'right' ? ' node-socket-side-right' : '')}>
      {types.map((type) => (
        <SocketRow
          key={type} side={side} type={type} active={active === type}
          options={active === type ? options : null} selectedEdgeId={edgeId}
          remainingSec={active === type ? remainingSec : null}
          onToggle={onToggle} onSelectVariant={onSelectVariant}
        />
      ))}
    </div>
  );
}

// state is one of null | 'playing' | 'next' | 'later' — the only three
// highlight treatments the graph uses now (no badge, no black-fill-means-
// selected ambiguity).
export function SongNode({ data }) {
  const {
    song, state, dimmed, hovered, inCount, outCount, onEnter, onLeave, playing,
    leftTypes, rightTypes, leftActive, rightActive, leftEdgeId, rightEdgeId,
    leftOptions, rightOptions, rightCueSeconds, onToggleSocket, onSelectVariant,
  } = data;
  const nowPlaying = useContext(NowPlayingContext);
  const position = (playing && nowPlaying.nowPlayingId === song.id) ? nowPlaying : null;
  const cls = ['node-card', state && 'state-' + state, hovered && 'node-hovered', dimmed && 'node-dimmed'].filter(Boolean).join(' ');
  const onToggle = (side, type) => onToggleSocket(song.id, side, type);
  const onSelect = (side, edgeId) => onSelectVariant(song.id, side, edgeId);
  // Only the song actually playing has a live elapsed clock to count down
  // against — a wired-but-not-yet-playing outro/transition just shows its
  // dropdown with no ring, since "time left" means nothing until it starts.
  const rightRemainingSec = (position && rightCueSeconds != null) ? (rightCueSeconds - position.elapsed) : null;
  return (
    <div className={cls} onMouseEnter={onEnter} onMouseLeave={onLeave}>
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
      <div className="node-socket-section">
        <SocketList side="left" types={leftTypes} active={leftActive} edgeId={leftEdgeId} options={leftOptions} onToggle={onToggle} onSelectVariant={onSelect} />
        <SocketList side="right" types={rightTypes} active={rightActive} edgeId={rightEdgeId} options={rightOptions} remainingSec={rightRemainingSec} onToggle={onToggle} onSelectVariant={onSelect} />
      </div>
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
