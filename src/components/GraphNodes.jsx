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
// Real analyser reads jump around frame to frame (that's what "live"
// audio data actually looks like) — snapping each bar straight to its
// raw reading every frame read as flicker rather than motion. A per-bar
// smoothed value chases the raw target each frame instead of jumping to
// it, with a faster attack than decay (a real VU meter's own convention)
// so a hit still reads as instant while the settle afterward looks like
// motion, not a twitch.
const WAVEFORM_ATTACK = 0.55, WAVEFORM_DECAY = 0.18;
function LiveWaveform() {
  const barRefs = useRef([]);
  const smoothedRef = useRef(new Float32Array(WAVEFORM_BARS));
  useEffect(() => {
    let raf;
    function tick() {
      const levels = engine.getLevels(WAVEFORM_BARS);
      const smoothed = smoothedRef.current;
      barRefs.current.forEach((el, i) => {
        if (!el) return;
        const target = levels ? levels[i] : 0;
        const rate = target > smoothed[i] ? WAVEFORM_ATTACK : WAVEFORM_DECAY;
        smoothed[i] += (target - smoothed[i]) * rate;
        el.style.height = Math.round(15 + smoothed[i] * 85) + '%';
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

// One row: a colored socket dot (a real React Flow `Handle`) plus a label
// — normally the fixed type title ("Intro"/"Outro"/"Transition"), so a
// row this particular song can't use (no produced edge) still renders,
// just greyed out and non-interactive, giving every node card the same
// scannable shape instead of a variable number of rows. Available dots
// (whether active or not) render the same way — solid, filled with the
// type's color — with only a ring/glow added for the active one;
// unavailable dots are flat grey. One dot style, one position rule
// (straddling the card edge, same offset for every row), applied
// everywhere, is the whole point — no socket looks like an exception.
// Every *available* socket is drag-connectable, since None/Outro on one
// song can link to None/Intro on a *different* song (a plain click can't
// express which other song to link to); None/Intro/Outro additionally
// toggle on a plain click, for marking a song's own ending/starting style
// with no particular partner in mind (e.g. "this is the last song, it
// just has an outro"). Transition is drag-only — two songs only ever have
// a specific produced transition between them, never a generic one to
// click into existence. Nesting the Handle inside a `position: relative`
// row lets it center on *this row* (CSS resolves an absolutely-positioned
// element against its nearest positioned ancestor, not the whole node),
// so rows can stack via ordinary flexbox regardless of how many there are.
//
// The *active* row for a slot with 2+ produced candidates (see
// `*Options`) doubles as its own variant picker — the label swaps from
// the fixed type title to the currently-picked candidate's own name (the
// only case where a row's text isn't the fixed title: this is the same
// name a separate trigger button used to show below the columns, just
// relocated onto the row itself now that that trigger is gone), and
// clicking the row (not the dot — the dot keeps its own toggle-click)
// opens a listbox of the other candidates. A Transition row's dot has no
// click handler at all, so the row's own click can't conflict with it.
function SocketRow({ side, type, available, active, cueOffsetSec, songId, onToggle, options = [], selectedEdgeId, onSelectVariant }) {
  const isInput = side === 'left';
  const hasPicker = !!(active && options.length > 1);
  const [open, setOpen] = useState(false);
  const rowRef = useRef(null);
  useEffect(() => {
    if (!hasPicker) setOpen(false);
  }, [hasPicker]);
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (rowRef.current && !rowRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);
  const selected = hasPicker ? (options.find(o => o.id === selectedEdgeId) || options[0]) : null;
  const cls = [
    'node-socket-row', !isInput && 'node-socket-row-right',
    active && 'node-socket-row-active', !available && 'node-socket-row-unavailable',
    hasPicker && 'node-socket-row-picker nodrag',
  ].filter(Boolean).join(' ');
  return (
    <div
      className={cls} ref={rowRef}
      role={hasPicker ? 'button' : undefined} tabIndex={hasPicker ? 0 : undefined}
      onMouseDown={hasPicker ? (e) => e.stopPropagation() : undefined}
      onClick={hasPicker ? (e) => { e.stopPropagation(); setOpen(o => !o); } : undefined}
      onKeyDown={hasPicker ? (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); e.stopPropagation(); setOpen(o => !o);
      } : undefined}
    >
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
      <span className="node-socket-label">{hasPicker ? selected.label : SOCKET_TITLE[type]}</span>
      {active && cueOffsetSec != null && songId != null && <CountdownRing cueOffsetSec={cueOffsetSec} songId={songId} />}
      {open && (
        <div className="node-socket-listbox" onMouseDown={(e) => e.stopPropagation()}>
          {options.map((opt) => (
            <button
              key={opt.id} type="button"
              className={'node-socket-option' + (opt.id === selectedEdgeId ? ' node-socket-option-selected' : '')}
              onClick={(e) => { e.stopPropagation(); onSelectVariant(opt.id); setOpen(false); }}
            >
              <span className="node-socket-option-label">{opt.label}</span>
              {opt.occludedTitles && opt.occludedTitles.length > 0 && (
                <span
                  className="node-socket-option-warn"
                  data-tooltip={'Would hide already-built transition' + (opt.occludedTitles.length > 1 ? 's' : '') + ': ' + opt.occludedTitles.join(', ')}
                >!</span>
              )}
              {songId != null && opt.outSeconds != null && <CountdownRing cueOffsetSec={opt.outSeconds} songId={songId} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SocketList({ side, types, availability, active, onToggle, cueOffsetSec, songId, options, selectedEdgeId, onSelectVariant }) {
  return (
    <div className={'node-socket-side' + (side === 'right' ? ' node-socket-side-right' : '')}>
      {types.map((type) => (
        <SocketRow
          key={type} side={side} type={type} available={!!availability[type]} active={active === type}
          cueOffsetSec={active === type ? cueOffsetSec : null} songId={active === type ? songId : null} onToggle={onToggle}
          options={active === type ? options : undefined} selectedEdgeId={active === type ? selectedEdgeId : undefined}
          onSelectVariant={active === type ? onSelectVariant : undefined}
        />
      ))}
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
  // plain CSS accent background (see .node-card.state-selected) rather
  // than a cover-derived tint. No borderColor here any more — the card's
  // borderless/shadow-elevated (see .node-card), so a border color would
  // have nothing to color.
  const palette = nowPlaying.palette;
  const dynamicStyle = (state === 'active' && palette) ? { background: palette.playing } : undefined;
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
          <SocketList
            side="left" types={LEFT_SOCKET_TYPES} availability={leftAvailable} active={leftActive} onToggle={onToggle}
            songId={ringSongId} options={leftOptions} selectedEdgeId={leftEdgeId}
            onSelectVariant={(edgeId) => onSelectVariant(song.id, 'left', edgeId)}
          />
          <SocketList
            side="right" types={RIGHT_SOCKET_TYPES} availability={rightAvailable} active={rightActive} onToggle={onToggle}
            cueOffsetSec={rightCueSeconds} songId={ringSongId} options={rightOptions} selectedEdgeId={rightEdgeId}
            onSelectVariant={(edgeId) => onSelectVariant(song.id, 'right', edgeId)}
          />
        </div>
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
