import React, { useMemo, useCallback, useEffect, useState, createContext, useContext } from 'react';
import { ReactFlow, Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, getBezierPath, useNodesState, ConnectionMode, useViewport } from '@xyflow/react';
import { END, START } from '../core.js';
import { NODE_W, NODE_H, END_W, END_H, START_W, START_H } from '../graphLayout.js';
import { SongNode, EndNode, StartNode, NowPlayingContext, HoveredNodeContext, SearchDimContext, MultiSelectionContext } from './GraphNodes.jsx';
import { useTheme } from '../theme.js';
import { usePalette } from './shared.jsx';

// Which edge (if any) the pointer is currently over, plus the setter — read
// by ActiveEdge to show its hover-✕ only then, rather than the button being
// permanently visible clutter. A separate context rather than plumbing it
// through `rfEdges`' own data so hovering doesn't force that whole memo
// (and every edge object in it) to recompute on every pointer move. The
// setter travels with the value so the button itself can also claim
// "hovered" on its own onMouseEnter — it's a separate DOM subtree from the
// edge path (rendered through EdgeLabelRenderer), so without this a mouse
// crossing the small gap between the line and the button would flicker it
// closed right as you reach for it.
const HoveredEdgeContext = createContext({ hoveredId: null, setHoveredId: () => {} });

const nodeTypes = { song: SongNode, end: EndNode, start: StartNode };
// Stable references — a fresh `{ width }` object every call is otherwise
// one more thing that changes identity on the once-a-second position tick
// for no reason, since the value itself never varies per node.
const SONG_STYLE = { width: NODE_W };
const END_STYLE = { width: END_W };
const START_STYLE = { width: START_W };
// Same story for React Flow's own options props: an inline object literal
// in JSX is a new reference every render, and GraphPane re-renders once a
// second (nowElapsedSec ticks while a set plays) even when our own
// `rfEdges`/`nodes` memoize away to no-ops — React Flow reacts to these
// specific prop identities changing by resyncing internal state, which was
// the actual source of edges (and the hover-✕ living in one) blinking out
// once a second, not anything in this file's own memoization.
const FIT_VIEW_OPTIONS = { padding: 0.25 };
const DEFAULT_EDGE_OPTIONS = { type: 'default' };
const PRO_OPTIONS = { hideAttribution: true };

// React Flow's edge stroke and the canvas's dot grid are plain SVG/canvas
// paint, not CSS — they can't pick up the page's CSS custom properties, so
// dark mode needs its own literal values here rather than just reusing
// var(--line) etc. Three arrow states now (see TODO.md's playlist-editor
// spec), no accent blue anywhere in this: a produced-but-unwired transition
// is always a thin grey dotted line; an active transition is a thick solid
// ink line; an active non-transition sequence link (any Outro/None/Intro/
// None pairing, with no produced edge backing it) is an ink dotted line —
// distinct dash rhythm from the grey one, not just a color difference, so
// all three still read at a zoomed-out scale.
const LINE_COLOR = { light: { grey: '#c7c7c7', ink: '#131313' }, dark: { grey: '#4b4d52', ink: '#f1f0ed' } };
const DOT_COLOR = { light: '#c8c8c8', dark: '#38393d' };

// Same control-point math React Flow's own bezier edge uses for fixed
// Right-source/Left-target handles (see @xyflow/system's getBezierPath) —
// reimplemented here because it isn't exported, so a fanned duplicate edge
// still leaves/enters each node the same way a normal one does.
function controlOffset(distance) { return distance >= 0 ? 0.5 * distance : 6.25 * Math.sqrt(-distance); }

// A perpendicular offset added to both bezier control points, not just
// `curvature` (which only bends edges that already differ in x *and* y —
// two same-height nodes stay a dead-straight overlapping line no matter the
// curvature value). This actually separates them regardless of layout.
// Shared by the path itself and its true midpoint below, so the two never
// drift apart.
function fannedBezierPoints({ sourceX, sourceY, targetX, targetY, offset }) {
  const c1x = sourceX + controlOffset(targetX - sourceX);
  const c2x = targetX - controlOffset(targetX - sourceX);
  const dx = targetX - sourceX, dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len; // unit vector perpendicular to source->target, works at any angle
  return {
    p0: [sourceX, sourceY],
    p1: [c1x + px * offset, sourceY + py * offset],
    p2: [c2x + px * offset, targetY + py * offset],
    p3: [targetX, targetY],
  };
}
function fannedBezierPath(args) {
  const { p0, p1, p2, p3 } = fannedBezierPoints(args);
  return `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`;
}
// The disconnect button needs to sit exactly on the curve's midpoint, not
// a straight-line approximation between the endpoints — a cubic bezier
// bulges well past that line once a real fan offset is applied, which
// left the "✕" visibly off-center on any fanned wire. This evaluates the
// standard cubic bezier point formula at t=0.5 using the same control
// points the path itself draws through.
function fannedBezierMidpoint(args) {
  const { p0, p1, p2, p3 } = fannedBezierPoints(args);
  return [
    (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8,
    (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8,
  ];
}

function FannedEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, data }) {
  const path = fannedBezierPath({ sourceX, sourceY, targetX, targetY, offset: data.offset });
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

// Any *active* wire (a real transition or a plain wired sequence link) gets
// a small always-there "✕" at its midpoint instead of the wire itself
// being clickable — clicking the bare line was explicitly ruled out during
// design as a real hazard (a stray click destroying part of a built
// playlist), the same instinct behind every other deliberately-hard-to-
// hit destructive control in this app. `EdgeLabelRenderer` is React Flow's
// supported way to place ordinary HTML at a point on an edge, panning and
// zooming with the canvas like the line itself.
function ActiveEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, animated, data }) {
  const offset = data && data.offset;
  const { hoveredId, setHoveredId } = useContext(HoveredEdgeContext);
  // EdgeLabelRenderer content lives inside the same zoomed/panned viewport
  // as the edge itself, so without this the button's real on-screen size
  // (and the area a real mouse can actually land on) shrinks right along
  // with the canvas zoom — at a fairly ordinary zoomed-out level it was
  // measured at well under 7px on screen, small enough that ordinary hand
  // tremor while trying to hold the cursor over it reads as "flickering in
  // and out" even though nothing in the app logic is actually toggling it.
  // `scale(1/zoom)` on this element cancels the ancestor's zoom for its own
  // rendered size/position offset while leaving the label's actual
  // position (`labelX,labelY`, in canvas coordinates) to track the edge
  // normally — the standard fix for "keep this overlay a constant screen
  // size" in a zoomable canvas.
  const { zoom } = useViewport();
  let path, labelX, labelY;
  if (offset) {
    path = fannedBezierPath({ sourceX, sourceY, targetX, targetY, offset });
    [labelX, labelY] = fannedBezierMidpoint({ sourceX, sourceY, targetX, targetY, offset });
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  const visible = hoveredId === id;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} className={animated ? 'active-edge-animated' : undefined} />
      <EdgeLabelRenderer>
        <button
          className={'edge-disconnect-btn' + (visible ? ' edge-disconnect-btn-visible' : '')}
          data-tooltip="Disconnect" data-tooltip-above
          style={{ transform: `translate(${labelX}px, ${labelY}px) scale(${1 / zoom}) translate(-50%, -50%)` }}
          onClick={(e) => { e.stopPropagation(); data.onDisconnect(); }}
          onMouseEnter={() => setHoveredId(id)}
          onMouseLeave={() => setHoveredId(null)}
        >×</button>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { fanned: FannedEdge, active: ActiveEdge };

export default function GraphPane({
  songs, positions, transitionEdgesRaw, activePlaylist, socketDataById, onToggleSocket, onSelectVariant, mixingEdgeId,
  onConnect, isValidConnection, onDisconnectSong, onDisconnectTransition, onDisconnectStart,
  stateFor, ioById,
  hoveredId, setHoveredId, matchIds, searchActive,
  onDragSongPosition, endQueued, onSelectSong,
  nowPlayingId, nowElapsedSec, nowDurationSec,
  onPaneContextMenu, onNodeContextMenu, onSelectionContextMenu, onMultiSelectionChange, onPaneClick,
}) {
  const { isDark } = useTheme();
  const lineColor = isDark ? LINE_COLOR.dark : LINE_COLOR.light;
  const dotColor = isDark ? DOT_COLOR.dark : DOT_COLOR.light;

  const initialNodes = useMemo(() => buildNodes(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  // React Flow's own selection-box drag (selectionOnDrag, below) already
  // marks every node inside the box `selected: true` individually — real
  // per-node multi-select, not just a bounding outline — this just reads
  // that back out so the app can actually do something with it: a shared
  // accent ring (see .node-card.state-multi-selected) distinct from the
  // single `selectedId` cursor the detail pane follows, and a context menu
  // that applies its actions across the whole set (PerformPage.jsx). A
  // plain single click also fires this (with exactly one node), which is
  // why every consumer gates on `length > 1` — single-select's own
  // existing `selectedId`/detail-pane behavior must stay untouched.
  const [multiSelectedIds, setMultiSelectedIds] = useState([]);
  const onSelectionChange = useCallback(({ nodes: selected }) => {
    const ids = selected.map(n => n.id);
    setMultiSelectedIds(ids);
    if (onMultiSelectionChange) onMultiSelectionChange(ids);
  }, [onMultiSelectionChange]);

  function buildNodes() {
    const list = Object.values(songs).map(s => nodeFor(s.id));
    list.push(endNodeFor());
    list.push(startNodeFor());
    return list;
  }
  function nodeFor(id) {
    const s = songs[id];
    const pos = positions[id] || { x: s.x, y: s.y };
    const io = ioById[id] || { inCount: 0, outCount: 0 };
    const state = stateFor(id);
    const socketData = socketDataById[id] || {
      leftAvailable: { none: true, intro: false, transition: false },
      rightAvailable: { none: true, outro: false, transition: false },
      leftActive: 'none', rightActive: 'none',
      leftEdgeId: null, rightEdgeId: null, leftOptions: [], rightOptions: [], rightCueSeconds: null,
    };
    return {
      id, type: 'song', position: pos, draggable: true,
      data: {
        song: s, state, inCount: io.inCount, outCount: io.outCount,
        onEnter: () => setHoveredId(id), onLeave: () => setHoveredId(null), onSelect: () => onSelectSong(id),
        onToggleSocket, onSelectVariant, ...socketData, playing: state === 'active',
      },
      style: SONG_STYLE,
    };
  }
  function endNodeFor() {
    const pos = positions[END] || { x: 1250, y: 20 };
    return {
      id: END, type: 'end', position: pos, draggable: true,
      data: { queued: endQueued },
      style: END_STYLE,
    };
  }
  function startNodeFor() {
    const pos = positions[START] || { x: -170, y: 20 };
    const wiredSong = activePlaylist.startSongId ? songs[activePlaylist.startSongId] : null;
    return {
      id: START, type: 'start', position: pos, draggable: true,
      data: { wiredSongTitle: wiredSong ? wiredSong.title : null },
      style: START_STYLE,
    };
  }

  // Recompute node render-*data* (state/io-counts/sockets/etc.) whenever the
  // inputs that matter change — but never touch `position` here. Position
  // is RF's own live-owned field (via useNodesState): during an in-progress
  // drag it holds the current drag position, and stomping it from a stale
  // `positions[id]` on every one of these refreshes is exactly what caused
  // the reported "dragging snaps between the drag and panning the grid" —
  // this effect used to fire on every hover (hoveredId was a dependency),
  // so dragging node A while the pointer passed over node B mid-gesture
  // reset A's position back to wherever it was *before* the drag started.
  // Preserving `n.position` from the previous node object fixes that: only
  // RF's own onNodesChange (live drag) and the dedicated position-sync
  // effect below (real layout changes) ever set position now.
  //
  // Also deliberately NOT depending on hoveredId/matchIds/searchActive
  // anymore — those reach SongNode via HoveredNodeContext/SearchDimContext
  // instead (see GraphNodes.jsx), specifically so a hover or a search
  // keystroke never triggers this at all. Calling React Flow's `setNodes`
  // re-syncs its *entire* internal node registry — every node's measured
  // handle bounds go stale until it recomputes — and a Playwright probe
  // confirmed this was making node bounding boxes genuinely unstable across
  // frames while hoveredId still lived here, not just a cosmetic flicker:
  // it was also what made socket drag-connections fail to complete, since
  // a connection-in-progress gets read from the same registry being
  // resynced out from under it. nowElapsedSec was already kept out of this
  // list for the same reason (see NowPlayingContext); hoveredId/matchIds/
  // searchActive needed the same treatment.
  useEffect(() => {
    setNodes(prev => prev.map(n => {
      // A just-deleted song's node still sits in this array for this one
      // pass — `songs` (a dependency here) already changed, so this effect
      // and the structural-rebuild effect below both fire on the same
      // commit, in declaration order. Deferring to that one (which filters
      // stale ids out properly) rather than calling nodeFor on an id
      // `songs` no longer has avoids a crash reading the now-undefined
      // song's own x/y — confirmed directly: deleting a song while its
      // node was on screen threw "Cannot read properties of undefined
      // (reading 'x')" from exactly this line.
      if (n.id !== END && n.id !== START && !songs[n.id]) return n;
      const updated = n.id === END ? endNodeFor() : n.id === START ? startNodeFor() : nodeFor(n.id);
      // Preserve position AND React Flow's own multi-select flag the same
      // way — both are live, RF-owned state this effect must never stomp:
      // `selected` fed a drag-selection box built for exactly this (moving
      // several nodes together), and losing it mid-selection to the very
      // next data refresh (every playback tick, while a set is running)
      // would clear a box-select before a drag could ever use it.
      return { ...updated, position: n.position, selected: n.selected };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, stateFor, ioById, socketDataById, endQueued, activePlaylist.startSongId, nowPlayingId, onSelectSong]);

  // The one place `position` actually gets written from outside RF's own
  // drag handling: a real layout change (auto-arrange, or a song's stored
  // x/y changing after a drag commits). Kept separate from the data-only
  // effect above so data refreshes (which fire far more often) never risk
  // re-triggering a position write.
  useEffect(() => {
    setNodes(prev => prev.map(n => (positions[n.id] ? { ...n, position: positions[n.id] } : n)));
  }, [positions]);

  // songs/edges structurally changing (added/removed) needs a full rebuild,
  // not just a patch, so newly added nodes actually appear.
  useEffect(() => {
    setNodes(buildNodes());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(songs).join(','), transitionEdgesRaw.map(e => e.id).join(',')]);

  // Three arrow states (TODO.md's playlist-editor spec): every produced
  // transition is always a thin grey dotted arrow — structural, drawn
  // whether or not it's part of the current playlist — except the one
  // actually active in activePlaylist, which renders as a thick solid ink
  // arrow instead (and animates, marching-ants, only while that specific
  // transition is really in progress per the audio engine's own crossfade
  // window). A second, separate family of ink dotted arrows covers active
  // non-transition links (any Outro/None/Intro/None pairing) — these have
  // no produced edge behind them at all, so they're synthesized straight
  // from activePlaylist rather than filtered out of transitionEdgesRaw.
  // Multiple produced transitions between the same two songs would
  // otherwise render as fully overlapping lines — give each one after the
  // first in a source/target pair a growing perpendicular offset,
  // alternating sides, so they fan out and stay individually visible
  // regardless of whether the two nodes sit at the same height (a plain
  // curvature tweak on the default bezier doesn't separate those).
  // Every song now always shows all three sockets per side (None/Intro-
  // Outro/Transition — see GraphNodes.jsx), stacked at the *same* React
  // Flow `Position.Left`/`Position.Right`, distinguished only by `id`.
  // Without an explicit `sourceHandle`/`targetHandle` naming exactly which
  // row an edge leaves/enters from, React Flow has no way to know which of
  // the three to anchor to and the arrow visually starts/ends at the wrong
  // socket — every edge here MUST set both.
  const rfEdges = useMemo(() => {
    const seen = new Map();
    const edgesOut = transitionEdgesRaw.map(e => {
      const pairKey = e.l + '->' + e.r;
      const dupIndex = seen.get(pairKey) || 0;
      seen.set(pairKey, dupIndex + 1);
      const offset = dupIndex === 0 ? 0 : Math.ceil(dupIndex / 2) * 26 * (dupIndex % 2 === 1 ? 1 : -1);
      const sourceNode = activePlaylist.nodes[e.l];
      // A song can carry more than one simultaneous Transition now (see
      // addTransitionConnection, core.js) — check membership in the whole
      // set, not equality against a single endEdgeId, so autoconnect (or a
      // second manual drag) shows every wired one as active, not just
      // whichever happens to be "primary".
      const isActive = !!sourceNode && sourceNode.endMode === 'transition' && (
        (sourceNode.transitions && sourceNode.transitions.length)
          ? sourceNode.transitions.some(t => t.edgeId === e.id)
          : sourceNode.endEdgeId === e.id
      );
      const color = isActive ? lineColor.ink : lineColor.grey;
      return {
        id: e.id, source: e.l, target: e.r,
        sourceHandle: 'right-transition', targetHandle: 'left-transition',
        type: isActive ? 'active' : (offset === 0 ? 'default' : 'fanned'),
        // A hover-✕ on one active Transition line only ever removes that
        // specific edge — see onDisconnectTransition, unlike the synthetic
        // None/Outro link edges below, which still only ever have the one.
        data: offset === 0 && !isActive ? undefined : { offset, onDisconnect: () => (isActive ? onDisconnectTransition(e.l, e.id) : onDisconnectSong(e.l)) },
        animated: isActive && mixingEdgeId === e.id,
        style: { stroke: color, strokeWidth: isActive ? 3 : 1.5, strokeDasharray: isActive ? undefined : '2 4' },
      };
    });
    // Multiple *different* songs can each independently wire a plain None/
    // Outro link into the same destination's input (see core.js's
    // wireConnection — each source's own nextSongId/endMode is untouched
    // by another source separately wiring into the same target; only the
    // destination's own arrival-style choice, startMode/startEdgeId, is
    // shared between them, correctly, since "does this song play its own
    // intro when cut into" is a property of the destination, not of
    // whichever source happens to be the one currently leading into it).
    // Same overlap problem as the produced-transition fan-out above, just
    // keyed by shared *target* instead of a shared source/target pair.
    const seenTargets = new Map();
    Object.keys(activePlaylist.nodes).forEach(songId => {
      const node = activePlaylist.nodes[songId];
      if (node.nextSongId && node.endMode !== 'transition') {
        const dupIndex = seenTargets.get(node.nextSongId) || 0;
        seenTargets.set(node.nextSongId, dupIndex + 1);
        const offset = dupIndex === 0 ? 0 : Math.ceil(dupIndex / 2) * 26 * (dupIndex % 2 === 1 ? 1 : -1);
        const destNode = activePlaylist.nodes[node.nextSongId];
        const startMode = (destNode && destNode.startMode) || 'none';
        edgesOut.push({
          id: 'link-' + songId, source: songId, target: node.nextSongId,
          sourceHandle: 'right-' + node.endMode, targetHandle: 'left-' + startMode,
          type: 'active',
          data: { offset, onDisconnect: () => onDisconnectSong(songId) },
          style: { stroke: lineColor.ink, strokeWidth: 2, strokeDasharray: '5 3' },
        });
      }
    });
    if (activePlaylist.startSongId && songs[activePlaylist.startSongId]) {
      // Start's own arrival choice — activePlaylist.startMode, NOT the
      // destination song's node.startMode. They're deliberately independent
      // fields now (see wireStart's comment in core.js): a song can be fed
      // an Intro by some other song's Outro while Start still cuts straight
      // into it with None, or vice versa, without either wire clobbering
      // the other's own choice.
      const startMode = activePlaylist.startMode || 'none';
      edgesOut.push({
        id: 'link-start', source: START, target: activePlaylist.startSongId,
        sourceHandle: 'start-out', targetHandle: 'left-' + startMode,
        type: 'active',
        data: { onDisconnect: onDisconnectStart },
        style: { stroke: lineColor.ink, strokeWidth: 2, strokeDasharray: '5 3' },
      });
    }
    return edgesOut;
  }, [transitionEdgesRaw, activePlaylist, songs, lineColor, mixingEdgeId, onDisconnectSong, onDisconnectTransition, onDisconnectStart]);

  const onNodeDragStop = useCallback((_, node) => {
    onDragSongPosition(node.id, node.position.x, node.position.y);
  }, [onDragSongPosition]);
  // Dragging a multi-node selection box-move together only fires
  // onNodeDragStop for the one node the gesture actually grabbed — every
  // other node that rode along needs its own new position persisted too,
  // or it would snap back the moment anything else on the canvas triggers
  // the position-sync effect below.
  const onSelectionDragStop = useCallback((_, nodes) => {
    nodes.forEach(n => onDragSongPosition(n.id, n.position.x, n.position.y));
  }, [onDragSongPosition]);

  // The color-match feature (see dominantColor.js): derived once here, off
  // the playing song's own cover, and read by every node through context —
  // a next/later node needs the *playing* song's palette to mute toward,
  // not its own, and the playing node itself would otherwise decode the
  // same cover a second time for no reason.
  const nowSongForPalette = nowPlayingId ? songs[nowPlayingId] : null;
  const palette = usePalette(nowSongForPalette ? nowSongForPalette.coverUrl : null);
  const nowPlayingValue = useMemo(
    () => ({ nowPlayingId, elapsed: nowElapsedSec, duration: nowDurationSec, palette }),
    [nowPlayingId, nowElapsedSec, nowDurationSec, palette]
  );
  const hoveredNodeValue = useMemo(() => ({ hoveredId }), [hoveredId]);
  const searchDimValue = useMemo(() => ({ searchActive, matchIds }), [searchActive, matchIds]);

  const [hoveredEdgeId, setHoveredEdgeId] = useState(null);
  const hoveredEdgeValue = useMemo(() => ({ hoveredId: hoveredEdgeId, setHoveredId: setHoveredEdgeId }), [hoveredEdgeId]);
  const onEdgeMouseEnter = useCallback((_, edge) => setHoveredEdgeId(edge.id), []);
  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

  const multiSelectionValue = useMemo(() => ({ count: multiSelectedIds.length }), [multiSelectedIds.length]);

  return (
    <NowPlayingContext.Provider value={nowPlayingValue}>
      <HoveredNodeContext.Provider value={hoveredNodeValue}>
      <SearchDimContext.Provider value={searchDimValue}>
      <MultiSelectionContext.Provider value={multiSelectionValue}>
      <HoveredEdgeContext.Provider value={hoveredEdgeValue}>
        <ReactFlow
          nodes={nodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          onSelectionChange={onSelectionChange}
          onEdgeMouseEnter={onEdgeMouseEnter}
          onEdgeMouseLeave={onEdgeMouseLeave}
          onPaneClick={onPaneClick}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          nodesConnectable
          connectionMode={ConnectionMode.Loose}
          connectionRadius={40}
          elementsSelectable
          deleteKeyCode={null}
          // Left-drag on empty canvas draws a selection box by default (see
          // onSelectionDragStop above); panning moves to holding Shift while
          // dragging instead. Reported directly as a real usability bug: a
          // plain click-drag panning the canvas by default meant a stray
          // right-click-menu dismissal had "no way to undo it" — the pane's
          // own default gesture was fighting the menu instead of just
          // closing it. selectionKeyCode is turned off (null) since Shift's
          // one job here is panOnDrag's activation key, not also a second,
          // conflicting way to trigger the selection box.
          //
          // `[1]` (not `false`/`true`) — React Flow accepts an array of
          // mouse button indices here, so this means "plain left-drag
          // (button 0) still draws a selection box; middle-mouse-drag
          // (button 1) always pans, no modifier key needed." Additive
          // alongside the existing Shift+left-drag pan
          // (`panActivationKeyCode`, below) rather than a replacement for
          // it — a Blender node-editor audit flagged plain Shift-held-down
          // panning as mildly awkward for a long continuous pan gesture,
          // and MMB is unclaimed by anything else on this canvas (left
          // drags/selects, right opens context menus).
          panOnDrag={[1]}
          selectionOnDrag
          selectionKeyCode={null}
          panActivationKeyCode="Shift"
          minZoom={0.25}
          maxZoom={2.5}
          colorMode={isDark ? 'dark' : 'light'}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          proOptions={PRO_OPTIONS}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={dotColor} />
        </ReactFlow>
      </HoveredEdgeContext.Provider>
      </MultiSelectionContext.Provider>
      </SearchDimContext.Provider>
      </HoveredNodeContext.Provider>
    </NowPlayingContext.Provider>
  );
}
