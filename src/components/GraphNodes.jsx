import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { fmtTime, LEFT_SOCKET_TYPES, RIGHT_SOCKET_TYPES } from '../core.js';
import { engine } from '../audioEngine.js';
import { usePlaybackFrame } from '../playbackControls.js';
import { Icon, ICONS, AlbumArt } from './shared.jsx';

// A real spectrum reading off the master bus (engine.getLevels), not a
// canned CSS bounce — reads as a DAW-style live meter instead of always
// doing the same dance whether or not anything's actually sounding. Bars
// are updated by directly setting each span's inline `style.height` every
// animation frame (a ref per bar, no React state) — going through
// `setState`/re-render at ~60fps would be needless work for a value that
// only ever affects some small inline styles. A wider bar count than the
// original 5 — the row had a lot of unused space between the meter and the
// elapsed-time readout, and more/thinner bars reads more like a real
// spectrum than a few wide ones.
const WAVEFORM_BARS = 14;
function LiveWaveform() {
  const barRefs = useRef([]);
  useEffect(() => {
    let raf;
    function tick() {
      const levels = engine.getLevels(WAVEFORM_BARS);
      barRefs.current.forEach((el, i) => {
        if (!el) return;
        const pct = levels ? Math.round(15 + levels[i] * 85) : 15;
        el.style.height = pct + '%';
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="node-waveform">
      {Array.from({ length: WAVEFORM_BARS }, (_, i) => (
        <span key={i} ref={(el) => { barRefs.current[i] = el; }} />
      ))}
    </div>
  );
}

// The once-a-second elapsed clock reaches the playing node through context
// instead of through React Flow's own node `data` — seeGraphPane.jsx's
// comment above its node-rebuild effect for why: routing a per-second tick
// through `setNodes` was flickering the disconnect button on every active
// edge in the whole graph, not just ones touching the playing node.
export const NowPlayingContext = createContext({ nowPlayingId: null, elapsed: 0, duration: 0, palette: null });

// Hover and search-dim state reach SongNode the same way — through context,
// never through React Flow's own node `data`. Both used to live in `data`
// and be recomputed by GraphPane's node-rebuild effect on every mouse-enter/
// keystroke; that effect calls React Flow's `setNodes`, which re-syncs its
// *entire* internal node registry (every node's measured handle bounds get
// invalidated and recomputed), which is what actually caused the reported
// "hovering makes nodes jitter" — visible instability confirmed directly: a
// Playwright hover probe found node bounding boxes genuinely non-stable
// across frames while this was wired through `data`. Reading these two off
// context instead means a hover or a keystroke only re-renders the specific
// SongNode components that care, as an ordinary React re-render of their own
// DOM — it never touches React Flow's node graph at all.
export const HoveredNodeContext = createContext({ hoveredId: null });
export const SearchDimContext = createContext({ searchActive: false, matchIds: null });

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
// as "still plenty of time" until it actually needs attention. Sits right
// next to the label (not off past the dropdown) so scanning the row tells
// you the urgency before you even look at which edge is selected.
const RING_WARN_WINDOW_SEC = 20;
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
const RING_RADIUS = 2.5, RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// `cueOffsetSec` is the fixed cue point on `songId`'s own timeline (an
// edge's outSeconds) — the only thing that varies is how much of it is
// left, and that has to come from the engine's own clock every frame, the
// same way the bottom scrub bar does (see usePlaybackFrame,
// docs/playback-model.md sec 7), not from a once-a-second `elapsed` React
// prop the way this used to work — that was the same 1Hz-stepping cause
// as the old progress bar, just on a ring instead of a fill width. Written
// straight to the SVG's own attributes through refs, never setState, so a
// caller mounting/unmounting this (socket wiring changes, a hop happens)
// is the only thing that ever triggers a real re-render.
function CountdownRing({ cueOffsetSec, songId }) {
  const svgRef = useRef(null);
  const circleRef = useRef(null);
  usePlaybackFrame((pos) => {
    const remainingSec = (pos.phase === 'main' && pos.songId === songId) ? cueOffsetSec - pos.elapsedSec : null;
    if (remainingSec == null) return;
    const pct = clamp01(remainingSec / RING_WARN_WINDOW_SEC);
    const hue = 120 * pct;
    const dash = RING_CIRCUMFERENCE * pct;
    if (circleRef.current) {
      circleRef.current.setAttribute('stroke', `hsl(${hue}, 75%, 45%)`);
      circleRef.current.setAttribute('stroke-dasharray', `${dash} ${RING_CIRCUMFERENCE}`);
    }
    if (svgRef.current) svgRef.current.setAttribute('aria-label', 'cue in ' + fmtTime(Math.max(0, Math.round(remainingSec))));
  });
  return (
    <svg ref={svgRef} className="socket-countdown-ring" width={6} height={6} viewBox="0 0 7 7" role="img" aria-label="cue">
      <circle cx="3.5" cy="3.5" r={RING_RADIUS} className="socket-countdown-track" fill="none" />
      <circle
        ref={circleRef} cx="3.5" cy="3.5" r={RING_RADIUS} fill="none" strokeLinecap="round" strokeWidth="1"
        transform="rotate(-90 3.5 3.5)"
      />
    </svg>
  );
}

// One row: a colored socket dot (a real React Flow `Handle`) plus its
// fixed type label — "Transition"/"Intro"/"Outro" never renames itself to
// whichever specific edge is wired underneath it, since that read as the
// socket changing kind rather than just a choice under a stable one.
// Every song shows the same three rows per side, always in the same order
// (None, Intro/Outro, Transition) — a row this particular song can't use
// (no produced edge) still renders, just greyed out and non-interactive,
// so every node card has the same scannable shape instead of a variable
// number of rows. Available dots (whether active or not) render the same
// way — solid, filled with the type's color — with only a ring/glow added
// for the active one; unavailable dots are flat grey. One dot style, one
// position rule (straddling the card edge, same offset for every row),
// applied everywhere, is the whole point — no socket looks like an
// exception. Every *available* socket is drag-connectable, since
// None/Outro on one song can link to None/Intro on a *different* song (a
// plain click can't express which other song to link to); None/Intro/
// Outro additionally toggle on a plain click, for marking a song's own
// ending/starting style with no particular partner in mind (e.g. "this is
// the last song, it just has an outro"). Transition is drag-only — two
// songs only ever have a specific produced transition between them, never
// a generic one to click into existence. Nesting the Handle inside a
// `position: relative` row lets it center on *this row* (CSS resolves an
// absolutely-positioned element against its nearest positioned ancestor,
// not the whole node), so rows can stack via ordinary flexbox regardless
// of how many there are.
function SocketRow({ side, type, available, active, cueOffsetSec, songId, onToggle }) {
  const isInput = side === 'left';
  const cls = [
    'node-socket-row', !isInput && 'node-socket-row-right',
    active && 'node-socket-row-active', !available && 'node-socket-row-unavailable',
  ].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <Handle
        type={isInput ? 'target' : 'source'} position={isInput ? Position.Left : Position.Right}
        id={side + '-' + type} isConnectable={available}
        className={[
          'node-socket', 'node-socket-' + type,
          available && 'node-socket-available', active && 'node-socket-active',
          available ? (type === 'transition' ? 'node-socket-draggable' : 'node-socket-clickable') : null,
        ].filter(Boolean).join(' ')}
        onClick={(!available || type === 'transition') ? undefined : (e) => { e.stopPropagation(); onToggle(side, type); }}
      />
      <span className="node-socket-label">{SOCKET_TITLE[type]}</span>
      {active && cueOffsetSec != null && songId != null && <CountdownRing cueOffsetSec={cueOffsetSec} songId={songId} />}
    </div>
  );
}

function SocketList({ side, types, availability, active, onToggle, cueOffsetSec, songId }) {
  return (
    <div className={'node-socket-side' + (side === 'right' ? ' node-socket-side-right' : '')}>
      {types.map((type) => (
        <SocketRow
          key={type} side={side} type={type} available={!!availability[type]} active={active === type}
          cueOffsetSec={active === type ? cueOffsetSec : null} songId={active === type ? songId : null} onToggle={onToggle}
        />
      ))}
    </div>
  );
}

// The dropdown for switching between 2+ candidates on an active slot —
// deliberately NOT squeezed into its column's half-width; Blender's own
// socket dropdowns run the node's full width, which is what actually
// makes a long transition/fragment name readable instead of truncated.
// Renders below the two columns, one line per side that currently needs
// one. A custom listbox, not a native `<select>`, specifically so the
// *closed* candidates can carry their own live countdown ring too — a
// native `<option>` can only ever hold plain text, which would hide
// exactly the information ("which of these is coming up soonest") this
// picker exists to surface at a glance.
function SocketDropdown({ typeLabel, options, selectedEdgeId, songId, onSelectVariant }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);
  const selected = options.find(o => o.id === selectedEdgeId) || options[0];
  return (
    <div className="node-socket-dropdown-row nodrag" ref={rootRef}>
      <span className="node-socket-dropdown-caption">{typeLabel}</span>
      <div className="node-socket-select-wrap">
        <button
          type="button" className="node-socket-select"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        >
          <span className="node-socket-select-label">{selected ? selected.label : ''}</span>
          {selected && songId != null && selected.outSeconds != null && (
            <CountdownRing cueOffsetSec={selected.outSeconds} songId={songId} />
          )}
          <span className="node-socket-select-chevron">▾</span>
        </button>
        {open && (
          <div className="node-socket-listbox" onMouseDown={(e) => e.stopPropagation()}>
            {options.map((opt) => (
              <button
                key={opt.id} type="button"
                className={'node-socket-option' + (opt.id === selectedEdgeId ? ' node-socket-option-selected' : '')}
                onClick={() => { onSelectVariant(opt.id); setOpen(false); }}
              >
                <span className="node-socket-option-label">{opt.label}</span>
                {songId != null && opt.outSeconds != null && <CountdownRing cueOffsetSec={opt.outSeconds} songId={songId} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// state is one of null | 'active' | 'selected' — Active is whatever's
// really playing; Selected is purely "what was last clicked". No more
// Playing/Next/Later: a node either is or isn't currently sounding, and
// either is or isn't what the right-side detail pane is showing.
export function SongNode({ data }) {
  const {
    song, state, inCount, outCount, onEnter, onLeave, playing, onSelect,
    leftAvailable, rightAvailable, leftActive, rightActive, leftEdgeId, rightEdgeId,
    leftOptions, rightOptions, rightCueSeconds, onToggleSocket, onSelectVariant,
  } = data;
  const nowPlaying = useContext(NowPlayingContext);
  const { hoveredId } = useContext(HoveredNodeContext);
  const { searchActive, matchIds } = useContext(SearchDimContext);
  const hovered = hoveredId === song.id;
  const dimmed = searchActive && matchIds && !matchIds.has(song.id);
  const position = (playing && nowPlaying.nowPlayingId === song.id) ? nowPlaying : null;
  const cls = ['node-card', state && 'state-' + state, hovered && 'node-hovered', dimmed && 'node-dimmed'].filter(Boolean).join(' ');
  // Color match (dominantColor.js) only ever applies to the Active card now
  // — Selected is a plain UI cursor, not a performance state, so it gets a
  // plain CSS accent border/background (see .node-card.state-selected)
  // rather than a cover-derived tint.
  const palette = nowPlaying.palette;
  const dynamicStyle = (state === 'active' && palette) ? { background: palette.playing, borderColor: palette.playing } : undefined;
  const onToggle = (side, type) => onToggleSocket(song.id, side, type);
  // Only the song actually playing has a live elapsed clock to count down
  // against — a wired-but-not-yet-playing outro/transition just shows its
  // dropdown with no ring, since "time left" means nothing until it starts.
  // `position` (nowPlayingId === this song) gates that; CountdownRing
  // itself reads the actual live remaining time off the engine's own
  // clock every frame (see its own comment) rather than a value computed
  // here from `position.elapsed`, which only updates once a second.
  const ringSongId = position ? song.id : null;
  return (
    <div className={cls} style={dynamicStyle} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={onSelect}>
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
          <LiveWaveform />
          {position && <div className="node-position mono-num">{fmtTime(position.elapsed)} / {fmtTime(position.duration)}</div>}
        </div>
      )}
      <div className="node-socket-section">
        <div className="node-socket-columns">
          <SocketList side="left" types={LEFT_SOCKET_TYPES} availability={leftAvailable} active={leftActive} onToggle={onToggle} />
          <SocketList side="right" types={RIGHT_SOCKET_TYPES} availability={rightAvailable} active={rightActive} onToggle={onToggle} cueOffsetSec={rightCueSeconds} songId={ringSongId} />
        </div>
        {leftOptions.length > 1 && (
          <SocketDropdown
            typeLabel={SOCKET_TITLE[leftActive]} options={leftOptions} selectedEdgeId={leftEdgeId}
            onSelectVariant={(edgeId) => onSelectVariant(song.id, 'left', edgeId)}
          />
        )}
        {rightOptions.length > 1 && (
          <SocketDropdown
            typeLabel={SOCKET_TITLE[rightActive]} options={rightOptions} selectedEdgeId={rightEdgeId}
            songId={ringSongId}
            onSelectVariant={(edgeId) => onSelectVariant(song.id, 'right', edgeId)}
          />
        )}
      </div>
    </div>
  );
}

// Purely informational on the canvas — shows where End Set sits in the plan
// (highlighted next/later like any other hop) but isn't itself clickable:
// the real trigger lives in the toolbar, deliberately apart from the graph
// so panning/clicking around the canvas can't end the set by accident. Its
// one input socket reuses the same dot style as every other socket (was
// previously invisible — a bare `Handle` with no `.node-socket` class
// inherits the canvas-wide "hide all raw React Flow handles" rule) so the
// graph doesn't have one card whose socket looks like an entirely
// different control.
export function EndNode({ data }) {
  const { queued } = data;
  return (
    <div className="end-node">
      <div className="node-socket-row">
        <Handle
          type="target" position={Position.Left} id="left-none"
          className="node-socket node-socket-none node-socket-available node-socket-draggable"
          isConnectable
        />
      </div>
      <div className="end-node-title"><Icon path={<rect x="5" y="5" width="14" height="14" />} filled size={11} /> End Set</div>
      <div className="end-node-hint">{queued ? 'part of your plan' : 'not queued'}</div>
    </div>
  );
}

// The graph's other bookend — purely informational and undraggable-into
// like End Set, giving the canvas a real entry point to match End Set's
// real exit point. Unlike End Set, nothing ever gets "queued" at Start:
// a set can begin from any song (there's no equivalent operational
// meaning to invent here), so its hint just reflects whether one already
// has.
export function StartNode({ data }) {
  const { wiredSongTitle } = data;
  return (
    <div className="end-node start-node">
      <div className="node-socket-row node-socket-row-right">
        <Handle
          type="source" position={Position.Right} id="start-out"
          className="node-socket node-socket-none node-socket-available node-socket-draggable"
          isConnectable
        />
      </div>
      <div className="end-node-title"><Icon path={<polygon points="6,4 20,12 6,20" />} filled size={11} /> Start Set</div>
      <div className="end-node-hint">{wiredSongTitle ? `wired to ${wiredSongTitle} — use the toolbar's Start set button` : 'drag to a song’s Intro/None to set the entry point'}</div>
    </div>
  );
}
