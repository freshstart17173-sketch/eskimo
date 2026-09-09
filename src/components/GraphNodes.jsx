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

// nowPlayingId/palette reach the playing node through context instead of
// through React Flow's own node `data` — see GraphPane.jsx's comment above
// its node-rebuild effect for why: routing a per-render value through
// `setNodes` was flickering the disconnect button on every active edge in
// the whole graph, not just ones touching the playing node. The actual
// elapsed/duration readout (NodePosition, below) deliberately does NOT live
// here — it used to, updated once a second, and went stale/frozen for the
// entire span of a real fragment (outro/transition clip) actually playing,
// since nothing about "elapsed into this song" is even a coherent question
// during that window (see NodePosition's own comment). It reads the
// engine's real clock every frame instead, via usePlaybackFrame,
// straight to a DOM ref — no context,
// no re-render, so it can't reintroduce the exact flicker this context
// exists to avoid.
export const NowPlayingContext = createContext({ nowPlayingId: null, palette: null, committedType: null });

// Search-dim state reaches SongNode through context, never through React
// Flow's own node `data`. It used to live in `data` and be recomputed by
// GraphPane's node-rebuild effect on every keystroke; that effect calls React
// Flow's `setNodes`, which re-syncs its *entire* internal node registry
// (every node's measured handle bounds get invalidated and recomputed), which
// is what caused the reported "hovering makes nodes jitter" — confirmed
// directly: a Playwright probe found node bounding boxes genuinely non-stable
// across frames while this was wired through `data`. Off context instead, a
// keystroke only re-renders the SongNodes that care, as an ordinary React
// re-render of their own DOM — it never touches React Flow's node graph.
//
// Hover used to sit here too, and that was still too much machinery: a
// context broadcast re-renders EVERY consumer, so pointing at one card
// re-rendered all fifty. It drove a single box-shadow, so it's plain CSS
// `:hover` now (styles.css) and no longer exists in React at all.
export const SearchDimContext = createContext({ searchActive: false, matchIds: null });
// How many nodes React Flow's own selection-box drag currently has
// selected — same context-not-data reasoning as the two above. React Flow
// already gives every custom node a `selected` prop for free (its own
// internal per-node flag, set true by a plain single click same as a
// multi-node box-drag), so SongNode only needs the *count* from here to
// tell the two apart: `selected && count > 1` is a real multi-selection
// ring; `selected && count === 1` is just this session's already-existing
// single-select cursor (`selectedId`/isSelected below), which must keep
// rendering exactly as it always has.
export const MultiSelectionContext = createContext({ count: 0 });

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
// Replaced the old live countdown ring on direct instruction: "get rid of
// the countdown circle and instead replace with a little indicator showing
// if a certain output is selected/active or not... so I can see at a
// glance if playback is gonna go with none or outro."
//
// A ring counting down to a cue answered a different question ("how long
// left") than the one actually being asked at a glance ("which of these
// is the one that's going to fire"). It also couldn't answer that second
// question honestly until the hop stopped being re-rolled every tick —
// with the decision now frozen when the song starts (commitHopFor,
// core.js) there IS a single true answer to point at, so this is a plain
// static dot rather than anything animated.
function SelectedOutputDot() {
  return <span className="socket-selected-dot" role="img" aria-label="selected — playback will take this output" />;
}

// This song's own "elapsed / duration" readout — real position, read off
// the engine's own clock every frame (see usePlaybackFrame,
// docs/playback-model.md sec 7), not from a once-a-second `elapsed` React
// prop. That prior version froze for the entire span of a real fragment
// (an outro/transition clip) actually playing: "elapsed into this song"
// stops being a coherent question the instant the song's own master ends
// and a produced clip takes over — there IS no later position on the
// song's own timeline for a once-a-second `duration - timeLeft` derivation
// to (wrongly) keep counting up against, so it visibly stuck at the song's
// own full duration for as long as the fragment kept playing, reading as
// "frozen" (and easy to mistake for "still playing the original song") —
// reported directly, twice, against real produced audio. `getPlaybackPosition`'s
// phase model already has the right shape for this: while `songId`'s own
// main deck is sounding, show its real elapsed/duration; the moment a
// fragment takes over, switch to *its* real elapsed/duration instead — the
// same "coming up next" progress the fixed Add Audio/Library preview
// players already show, now live during an actual set too. Gated by the
// caller on "this is the currently-playing card" (mount/unmount, not a
// per-frame condition here), so a fragment phase always means *this* card's
// own fragment — nowPlayingId doesn't change to anything else until the
// fragment's done (see syncSessionFromFiredPlan).
function NodePosition({ songId }) {
  const spanRef = useRef(null);
  usePlaybackFrame((pos) => {
    if (!spanRef.current) return;
    if (pos.phase === 'fragment' || (pos.phase === 'main' && pos.songId === songId)) {
      spanRef.current.textContent = fmtTime(pos.elapsedSec) + ' / ' + fmtTime(pos.durationSec);
    }
  });
  return <span className="node-position mono-num" ref={spanRef} />;
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
function SocketRow({ side, type, available, active, committed, onToggle, options = [], selectedEdgeId, filledLabel, onSelectVariant, locked }) {
  const isInput = side === 'left';
  // A locked row still shows which variant is selected, it just can't be
  // changed — the choice is already scheduled (see lockedIds, PerformPage.jsx).
  const hasPicker = !!(active && options.length > 1 && !locked);
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
  // With the picker suppressed the row would otherwise fall back to the
  // generic type name and appear to lose the variant the DJ actually chose.
  const lockedLabel = (locked && active && options.length > 1)
    ? ((options.find(o => o.id === selectedEdgeId) || options[0]).label) : null;
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
        onClick={(!available || type === 'transition' || !onToggle) ? undefined : (e) => { e.stopPropagation(); onToggle(side, type); }}
      />
      {/* Only ever show the bare type name ("None"/"Intro"/"Outro"/
          "Transition") for an empty slot. Once something's actually
          selected to play through this socket, name that instead — the
          picker's own variant label when there's a real choice among
          several built pieces (already distinguishes them, e.g. "Fast
          cut" vs "Slow blend" to the very same song), otherwise the real
          song this socket's audio actually connects to (filledLabel, see
          socketDataById/PerformPage.jsx) — a plain type name told you
          nothing once a slot had something real playing through it
          (reported directly). */}
      <span className="node-socket-label">{hasPicker ? selected.label : (lockedLabel || filledLabel || SOCKET_TITLE[type])}</span>
      {committed && <SelectedOutputDot />}
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// `activeTypes` is a *set* now, not a single mode — a node's right/output
// side can have more than one type active at once (None to one place,
// Outro to another, one-or-more Transitions to others, all
// simultaneously — reported directly, exactly this shape). The left/
// arrival side still only ever has zero or one active type (out of scope
// to change, by direct instruction), so it's just always passed as a
// one-or-zero-element array here for one shared interface instead of two.
// `optionsByType`/`selectedEdgeIdByType` are keyed by type for the same
// reason — each active type gets its own independent dropdown data now,
// not one shared value gated on a single "which type is active" check.
// `committedType` is the one output this song has actually committed to
// firing (session.committedHop, see commitHopFor in core.js) — null for
// every node that isn't currently playing.
function SocketList({ side, types, availability, activeTypes = [], onToggle, committedType = null, optionsByType = {}, selectedEdgeIdByType = {}, filledLabelByType = {}, onSelectVariant, locked }) {
  return (
    <div className={'node-socket-side' + (side === 'right' ? ' node-socket-side-right' : '')}>
      {types.map((type) => {
        const isActive = activeTypes.includes(type);
        return (
          <SocketRow
            key={type} side={side} type={type} available={!!availability[type]} active={isActive}
            committed={isActive && committedType === type} onToggle={onToggle} locked={locked}
            options={isActive ? optionsByType[type] : undefined} selectedEdgeId={isActive ? selectedEdgeIdByType[type] : undefined}
            filledLabel={isActive ? filledLabelByType[type] : null}
            onSelectVariant={(edgeId) => onSelectVariant(type, selectedEdgeIdByType[type], edgeId)}
          />
        );
      })}
    </div>
  );
}

// `state` is 'active' or null — whether this song is really playing right
// now (session.nowPlayingId), driving the full color-matched fill/pulse.
// `isSelected` is a completely independent boolean — purely "what was
// last clicked, so the detail pane is showing it" — driving a separate
// accent ring (see .node-selected-ring below). They used to be a single
// exclusive `state` value ('active' XOR 'selected'), which meant a node
// that was both playing AND the one just clicked showed no selection
// ring at all — reported directly, exactly this gap. Keeping them
// independent is what makes "active AND selected at once" a real,
// representable case instead of one silently winning over the other.
export function SongNode({ data, selected }) {
  const {
    song, state, isSelected, inCount, outCount, playing, onSelect,
    leftAvailable, rightAvailable, leftActive, rightActiveTypes, leftEdgeId, leftFilledLabel,
    leftOptions, rightOptionsByType, rightEdgeIdByType, rightFilledLabelByType, onToggleSocket, onSelectVariant, locked,
  } = data;
  const nowPlaying = useContext(NowPlayingContext);
  const { searchActive, matchIds } = useContext(SearchDimContext);
  const { count: multiSelectedCount } = useContext(MultiSelectionContext);
  const dimmed = searchActive && matchIds && !matchIds.has(song.id);
  const isNowPlayingHere = playing && nowPlaying.nowPlayingId === song.id;
  // A real multi-node box-drag selection (React Flow's own `selected`,
  // gated on more than one node actually being selected — see
  // MultiSelectionContext above) gets the same accent ring the single
  // `selectedId` cursor already uses (see .node-multi-selected below)
  // rather than a second competing visual language for "this is part of
  // what I clicked".
  const multiSelected = selected && multiSelectedCount > 1;
  const cls = [
    'node-card', state && 'state-' + state, dimmed && 'node-dimmed',
    isSelected && 'node-selected-ring', multiSelected && 'node-multi-selected',
    locked && 'node-locked',
  ].filter(Boolean).join(' ');
  // Color match (dominantColor.js) only ever applies to the Active card —
  // Selected is a plain UI cursor, not a performance state, so it only
  // ever gets the accent ring (.node-selected-ring below), independent of
  // whatever fill this card already has for other reasons.
  const palette = nowPlaying.palette;
  const dynamicStyle = (state === 'active' && palette) ? { background: palette.playing } : undefined;
  // A locked card's rows are display-only — the handlers in PerformPage
  // refuse them anyway, but a row that still looks clickable and then does
  // nothing reads as a bug rather than as "this is decided already".
  const onToggle = locked ? null : ((side, type) => onToggleSocket(song.id, side, type));
  // Only the song actually playing has committed to one of its outputs
  // (session.committedHop — see commitHopFor, core.js). Every other card
  // shows its rows with no selected dot, because nothing is decided for
  // them yet: "which one fires" is a question that only has an answer
  // once a song is actually the one playing.
  const committedType = isNowPlayingHere ? (nowPlaying.committedType || null) : null;
  return (
    <div className={cls} style={dynamicStyle} onClick={onSelect}>
      <div className="node-title-row">
        <div>
          <div className="node-title">{song.title}</div>
          <div className="node-artist">{song.artist}</div>
          {song.contributedBy && <div className="node-contributor" data-tooltip="Added by">{song.contributedBy}</div>}
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
          {isNowPlayingHere && <NodePosition songId={song.id} />}
        </div>
      )}
      <div className="node-socket-section">
        <div className="node-socket-columns">
          <SocketList
            side="left" types={LEFT_SOCKET_TYPES} availability={leftAvailable} activeTypes={leftActive === 'none' ? [] : [leftActive]} onToggle={onToggle} locked={locked}
            optionsByType={{ [leftActive]: leftOptions }} selectedEdgeIdByType={{ [leftActive]: leftEdgeId }}
            filledLabelByType={{ [leftActive]: leftFilledLabel }}
            onSelectVariant={(type, oldEdgeId, edgeId) => onSelectVariant(song.id, 'left', type, oldEdgeId, edgeId)}
          />
          <SocketList
            side="right" types={RIGHT_SOCKET_TYPES} availability={rightAvailable} activeTypes={rightActiveTypes} onToggle={onToggle} locked={locked}
            committedType={committedType} optionsByType={rightOptionsByType} selectedEdgeIdByType={rightEdgeIdByType}
            filledLabelByType={rightFilledLabelByType}
            onSelectVariant={(type, oldEdgeId, edgeId) => onSelectVariant(song.id, 'right', type, oldEdgeId, edgeId)}
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
  const { wiredSongTitle, canPlay, onPlay } = data;
  // The play button is ALWAYS rendered now — `canPlay` no longer gates it
  // on "no set is running yet", which made it vanish the moment you used
  // it once ("the play node loses its play button after clicking it the
  // first time when it should always be there", reported directly).
  // Restarting the set from the top is a real thing to want mid-set, and
  // it's also the way to re-roll a shuffled output (starting a song is
  // what draws its hop — see commitHopFor, core.js). It still greys out
  // when there's no wired entry point, matching every other
  // not-yet-usable control on this canvas rather than disappearing.
  return (
    <div className="end-node start-node">
      <div className="node-socket-row node-socket-row-right">
        <Handle
          type="source" position={Position.Right} id="start-out"
          className="node-socket node-socket-none node-socket-available node-socket-draggable"
          isConnectable
        />
      </div>
      <div className="end-node-title-row">
        <div className="end-node-title"><Icon path={<polygon points="6,4 20,12 6,20" />} filled size={11} /> Start Set</div>
        {canPlay && (
          <button
            className="start-node-play-btn" disabled={!wiredSongTitle}
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            data-tooltip={wiredSongTitle ? 'Start playing from ' + wiredSongTitle : 'Wire a song to Start first'}
          >
            <Icon path={ICONS.play} filled size={12} />
          </button>
        )}
      </div>
      <div className="end-node-hint">{wiredSongTitle ? (canPlay ? `wired to ${wiredSongTitle} — click play, or use the toolbar` : `wired to ${wiredSongTitle}`) : 'drag to a song’s Intro/None to set the entry point'}</div>
    </div>
  );
}
