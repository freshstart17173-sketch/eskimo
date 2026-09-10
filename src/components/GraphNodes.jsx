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

// The committed-output indicator, in answer to: "get rid of the countdown
// circle and instead replace with a little indicator showing if a certain
// output is selected/active or not... so I can see at a glance if playback is
// gonna go with none or outro."
//
// A ring counting down to a cue answered a different question ("how long
// left") than the one actually being asked at a glance ("which of these is the
// one that's going to fire"). It also couldn't answer that second question
// honestly until the hop stopped being re-rolled every tick — with the
// decision now frozen when the song starts (commitHopFor, core.js) there IS a
// single true answer to point at, so this is a plain static dot rather than
// anything animated.
function SelectedOutputDot() {
  return <span className="socket-selected-dot" role="img" aria-label="selected — playback will take this output" />;
}

// This song's own "elapsed / duration" readout — real position, read off the
// engine's own clock every frame (see usePlaybackFrame, docs/playback-model.md
// sec 7), not from a once-a-second `elapsed` React prop. That prior version
// froze for the entire span of a real fragment (an outro/transition clip)
// actually playing: "elapsed into this song" stops being a coherent question
// the instant the song's own master ends and a produced clip takes over — so
// it visibly stuck at the song's full duration for as long as the fragment
// kept playing, easy to mistake for "still playing the original song", and
// reported directly twice against real produced audio. Gated by the caller on
// "this is the currently-playing card" (mount/unmount, not a per-frame
// condition here), so a fragment phase always means *this* card's own
// fragment — nowPlayingId doesn't change until the fragment is done.
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

// ---------------------------------------------------------------------------
// Ports and flow lines — the card's whole connection surface.
//
// This replaced a six-row socket matrix (None/Intro/Transition down the left,
// None/Outro/Transition down the right) that every card rendered in full
// whether or not the rows carried anything. On the 50-node example graph that
// was ~300 rows of mostly-repeated words, and the word "None" alone appeared
// about a hundred times to label the *absence* of a thing. No other node
// editor surveyed does this (docs/design/node-editor-inspiration.pdf); the
// closest precedent, cables.gl, spends almost no space on ports at all.
//
// So a port is now a segment of a strip running along the card's top edge
// (inputs) and bottom edge (outputs). Colour carries the type — see the --ct-*
// tokens in styles.css — and position carries identity, so the type name never
// has to be printed. The strip segment IS the React Flow Handle, which makes
// the hit target substantially larger than the 9px circles it replaces even
// though it occupies far less of the card.
//
// Handles sit on Position.Top/Position.Bottom, so the graph flows top-to-bottom
// (graphLayout.js ranks TB to match). Handle *ids* are unchanged — still
// `left-<type>` / `right-<type>` — because isValidConnection and handleConnect
// in PerformPage.jsx parse them, and this is purely a presentation change.
//
// Interaction is preserved exactly: None/Intro/Outro toggle on a plain click,
// Transition is drag-only (two songs only ever have a specific produced
// transition between them, never a generic one to click into existence), and
// every available port is drag-connectable.
function PortStrip({ side, types, availability, activeTypes = [], committedType = null, onToggle, locked }) {
  const isInput = side === 'left';
  return (
    <div className={'node-ports' + (isInput ? ' node-ports-in' : ' node-ports-out')}>
      {types.map((type) => {
        const available = !!availability[type];
        const active = activeTypes.includes(type);
        const committed = !isInput && active && committedType === type;
        const clickable = available && type !== 'transition' && !!onToggle;
        return (
          <Handle
            key={type}
            type={isInput ? 'target' : 'source'}
            position={isInput ? Position.Top : Position.Bottom}
            id={side + '-' + type}
            isConnectable={available}
            data-tooltip={SOCKET_TITLE[type] + (available ? '' : ' — nothing produced yet')}
            className={[
              'node-port', 'node-port-' + type,
              available && 'node-port-available', active && 'node-port-active',
              committed && 'node-port-committed',
              available ? (type === 'transition' ? 'node-port-draggable' : 'node-port-clickable') : null,
            ].filter(Boolean).join(' ')}
            onClick={clickable ? (e) => { e.stopPropagation(); onToggle(side, type); } : undefined}
          />
        );
      })}
    </div>
  );
}

// One line of "where this connection actually goes", sitting inside the card
// between a port strip and the main content — placed there by direct
// instruction. It's what makes the strips affordable: collapsing the ports to
// colour alone would otherwise have thrown away the destination name, which
// was the one genuinely load-bearing thing the old rows displayed.
//
// A line with two or more produced candidates doubles as its own variant
// picker (the same listbox the old active row carried, just relocated), so
// choosing between e.g. "Fast cut" and "Slow blend" to the same song stays a
// single click on the card.
function FlowLine({ dir, type, label, options = [], selectedEdgeId, committed, onSelectVariant, locked }) {
  const hasPicker = !!(options && options.length > 1 && !locked);
  const [open, setOpen] = useState(false);
  const rowRef = useRef(null);
  useEffect(() => { if (!hasPicker) setOpen(false); }, [hasPicker]);
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (rowRef.current && !rowRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);

  const picked = (options || []).find(o => o.id === selectedEdgeId) || (options || [])[0];
  // The destination always wins the line. When several produced clips lead to
  // the same place, the chosen one's own name rides alongside it in muted
  // text rather than replacing it — the old rows showed the variant INSTEAD
  // of the destination, which was survivable when a separate socket label
  // still named the target, and isn't now that this line is the only place
  // the destination appears at all.
  const variantName = (options && options.length > 1 && picked) ? picked.label : null;

  return (
    <div
      className={'node-flow-line node-flow-' + type + (hasPicker ? ' node-flow-pick nodrag' : '')}
      ref={rowRef}
      role={hasPicker ? 'button' : undefined} tabIndex={hasPicker ? 0 : undefined}
      onMouseDown={hasPicker ? (e) => e.stopPropagation() : undefined}
      onClick={hasPicker ? (e) => { e.stopPropagation(); setOpen(o => !o); } : undefined}
      onKeyDown={hasPicker ? (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); e.stopPropagation(); setOpen(o => !o);
      } : undefined}
    >
      <span className="node-flow-arrow">{dir === 'in' ? '↓' : '→'}</span>
      <span className="node-flow-label">{label}</span>
      {variantName && <span className="node-flow-variant">{variantName}</span>}
      {committed && <SelectedOutputDot />}
      {hasPicker && <span className="node-flow-caret">▾</span>}
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
    leftOptions, rightOptionsByType, rightEdgeIdByType, onToggleSocket, onSelectVariant, locked,
    rightTargetLabelByType = {}, sourceLabel = null, badges = null,
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
  // Every active output, in the order the strip shows them, so the lines under
  // the card body read in the same order as the ports above them.
  const outLines = RIGHT_SOCKET_TYPES.filter(t => rightActiveTypes.includes(t)).map(type => ({
    type,
    label: rightTargetLabelByType[type] || SOCKET_TITLE[type],
    options: rightOptionsByType[type],
    selectedEdgeId: rightEdgeIdByType[type],
    committed: committedType === type,
  }));
  const hasIn = leftActive && leftActive !== 'none' ? true : !!sourceLabel;

  return (
    <div className={cls} style={dynamicStyle} onClick={onSelect}>
      <PortStrip
        side="left" types={LEFT_SOCKET_TYPES} availability={leftAvailable}
        activeTypes={leftActive === 'none' ? [] : [leftActive]}
        onToggle={onToggle} locked={locked}
      />
      {hasIn && (
        <div className="node-flow node-flow-in">
          <FlowLine
            dir="in" type={leftActive === 'none' ? 'none' : leftActive}
            label={leftFilledLabel || sourceLabel || SOCKET_TITLE[leftActive]}
            options={leftOptions} selectedEdgeId={leftEdgeId} locked={locked}
            onSelectVariant={(edgeId) => onSelectVariant(song.id, 'left', leftActive, leftEdgeId, edgeId)}
          />
        </div>
      )}

      <div className="node-body">
        <AlbumArt className="node-art" url={song.coverUrl} />
        <div className="node-meta">
          <div className="node-title">{song.title}</div>
          <div className="node-artist">{song.artist}</div>
          <div className="node-tags">
            <span className="tag tag-accent">{song.bpm}</span>
            <span className="tag tag-good">{song.key}</span>
            <span className="node-io">{inCount}/{outCount}</span>
          </div>
        </div>
        {/* Status as marks rather than words — Houdini's badge row, which is
            how it fits four independent facts under a name without the card
            growing (docs/design/node-editor-inspiration.pdf). */}
        {badges && badges.length > 0 && (
          <div className="node-badges">
            {badges.map(b => (
              <span key={b.key} className={'node-badge node-badge-' + b.key} data-tooltip={b.title} />
            ))}
          </div>
        )}
      </div>

      {playing && (
        <div className="node-playing-row">
          <LiveWaveform />
          {isNowPlayingHere && <NodePosition songId={song.id} />}
        </div>
      )}

      {outLines.length > 0 && (
        <div className="node-flow node-flow-out">
          {outLines.map(l => (
            <FlowLine
              key={l.type} dir="out" type={l.type} label={l.label}
              options={l.options} selectedEdgeId={l.selectedEdgeId}
              committed={l.committed} locked={locked}
              onSelectVariant={(edgeId) => onSelectVariant(song.id, 'right', l.type, l.selectedEdgeId, edgeId)}
            />
          ))}
        </div>
      )}

      <PortStrip
        side="right" types={RIGHT_SOCKET_TYPES} availability={rightAvailable}
        activeTypes={rightActiveTypes} committedType={committedType}
        onToggle={onToggle} locked={locked}
      />
    </div>
  );
}

// Purely informational on the canvas — shows where End Set sits in the plan
// (highlighted next/later like any other hop) but isn't itself clickable:
// the real trigger lives in the toolbar, deliberately apart from the graph
// so panning/clicking around the canvas can't end the set by accident. Its
// one input port reuses the same edge-strip style as every song card (a bare
// `Handle` with no port class inherits the canvas-wide "hide all raw React
// Flow handles" rule and would be invisible) so the graph doesn't have one
// card whose connector looks like an entirely different control.
export function EndNode({ data }) {
  const { queued } = data;
  return (
    <div className="end-node">
      <div className="node-ports node-ports-in">
        <Handle
          type="target" position={Position.Top} id="left-none"
          className="node-port node-port-none node-port-available node-port-draggable"
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
      <div className="node-ports node-ports-out">
        <Handle
          type="source" position={Position.Bottom} id="start-out"
          className="node-port node-port-none node-port-available node-port-draggable"
          isConnectable
        />
      </div>
    </div>
  );
}
