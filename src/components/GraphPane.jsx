import React, { useMemo, useCallback, useEffect } from 'react';
import { ReactFlow, Background, BackgroundVariant, MarkerType, BaseEdge, EdgeLabelRenderer, getBezierPath, useNodesState } from '@xyflow/react';
import { END } from '../core.js';
import { NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import { SongNode, EndNode, NowPlayingContext } from './GraphNodes.jsx';
import { useTheme } from '../theme.js';

const nodeTypes = { song: SongNode, end: EndNode };
// Stable references — a fresh `{ width }` object every call is otherwise
// one more thing that changes identity on the once-a-second position tick
// for no reason, since the value itself never varies per node.
const SONG_STYLE = { width: NODE_W };
const END_STYLE = { width: END_W };
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
function fannedBezierPath({ sourceX, sourceY, targetX, targetY, offset }) {
  const c1x = sourceX + controlOffset(targetX - sourceX);
  const c2x = targetX - controlOffset(targetX - sourceX);
  const dx = targetX - sourceX, dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len; // unit vector perpendicular to source->target, works at any angle
  return `M${sourceX},${sourceY} C${c1x + px * offset},${sourceY + py * offset} ${c2x + px * offset},${targetY + py * offset} ${targetX},${targetY}`;
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
  let path, labelX, labelY;
  if (offset) {
    path = fannedBezierPath({ sourceX, sourceY, targetX, targetY, offset });
    labelX = (sourceX + targetX) / 2 + offset * 0.4;
    labelY = (sourceY + targetY) / 2 + offset * 0.4;
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} className={animated ? 'active-edge-animated' : undefined} />
      <EdgeLabelRenderer>
        <button
          className="edge-disconnect-btn" data-tooltip="Disconnect" data-tooltip-above
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(e) => { e.stopPropagation(); data.onDisconnect(); }}
        >×</button>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { fanned: FannedEdge, active: ActiveEdge };

export default function GraphPane({
  songs, positions, transitionEdgesRaw, activePlaylist, socketDataById, onToggleSocket, onSelectVariant, mixingEdgeId,
  onConnect, isValidConnection, onDisconnectSong,
  stateFor, ioById,
  hoveredId, setHoveredId, matchIds, searchActive,
  onDragSongPosition, endQueued,
  nowPlayingId, nowElapsedSec, nowDurationSec,
}) {
  const { isDark } = useTheme();
  const lineColor = isDark ? LINE_COLOR.dark : LINE_COLOR.light;
  const dotColor = isDark ? DOT_COLOR.dark : DOT_COLOR.light;

  const initialNodes = useMemo(() => buildNodes(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  function buildNodes() {
    const list = Object.values(songs).map(s => nodeFor(s.id));
    list.push(endNodeFor());
    return list;
  }
  function nodeFor(id) {
    const s = songs[id];
    const pos = positions[id] || { x: s.x, y: s.y };
    const io = ioById[id] || { inCount: 0, outCount: 0 };
    const state = stateFor(id);
    const socketData = socketDataById[id] || {
      leftTypes: [], rightTypes: [], leftActive: 'none', rightActive: 'none',
      leftEdgeId: null, rightEdgeId: null, leftOptions: [], rightOptions: [], rightCueSeconds: null,
    };
    return {
      id, type: 'song', position: pos, draggable: true,
      data: {
        song: s, state, dimmed: searchActive && !matchIds.has(id),
        hovered: hoveredId === id, inCount: io.inCount, outCount: io.outCount,
        onEnter: () => setHoveredId(id), onLeave: () => setHoveredId(null),
        onToggleSocket, onSelectVariant, ...socketData, playing: state === 'playing',
      },
      style: SONG_STYLE,
    };
  }
  function endNodeFor() {
    const pos = positions[END] || { x: 1250, y: 20 };
    return {
      id: END, type: 'end', position: pos, draggable: true,
      data: { state: stateFor(END), queued: endQueued },
      style: END_STYLE,
    };
  }

  // Recompute node render-data (position/state/hover/etc.) whenever the
  // inputs that matter change — RF's own state (from useNodesState) still
  // owns the live position during an in-progress drag. Deliberately NOT
  // including nowElapsedSec here (or anywhere `setNodes` gets called): that
  // ticks every second while a set plays, and calling React Flow's own
  // `setNodes` re-syncs its *entire* internal node registry — which, for
  // one tick, leaves every node's handle-bounds measurement stale until it
  // recomputes. Every edge in the graph reads its endpoints from that same
  // registry, so for that one tick *all* of them (not just ones touching
  // the playing node) briefly render as if their endpoints don't exist —
  // invisible for the line itself, but enough to unmount and remount the
  // hover-✕ button living in each active edge's EdgeLabelRenderer portal,
  // which is a visible flicker on every live set. The elapsed clock reaches
  // SongNode through NowPlayingContext instead (below), entirely outside
  // React Flow's node data, so ticking it never touches `setNodes` at all.
  useEffect(() => {
    setNodes(prev => prev.map(n => (n.id === END ? endNodeFor() : nodeFor(n.id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, positions, stateFor, ioById, hoveredId, matchIds, searchActive, socketDataById, endQueued, nowPlayingId]);

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
  const rfEdges = useMemo(() => {
    const seen = new Map();
    const edgesOut = transitionEdgesRaw.map(e => {
      const pairKey = e.l + '->' + e.r;
      const dupIndex = seen.get(pairKey) || 0;
      seen.set(pairKey, dupIndex + 1);
      const offset = dupIndex === 0 ? 0 : Math.ceil(dupIndex / 2) * 26 * (dupIndex % 2 === 1 ? 1 : -1);
      const sourceNode = activePlaylist.nodes[e.l];
      const isActive = !!sourceNode && sourceNode.endMode === 'transition' && sourceNode.endEdgeId === e.id;
      const color = isActive ? lineColor.ink : lineColor.grey;
      return {
        id: e.id, source: e.l, target: e.r,
        type: isActive ? 'active' : (offset === 0 ? 'default' : 'fanned'),
        data: offset === 0 && !isActive ? undefined : { offset, onDisconnect: () => onDisconnectSong(e.l) },
        animated: isActive && mixingEdgeId === e.id,
        style: { stroke: color, strokeWidth: isActive ? 3 : 1.5, strokeDasharray: isActive ? undefined : '2 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
      };
    });
    Object.keys(activePlaylist.nodes).forEach(songId => {
      const node = activePlaylist.nodes[songId];
      if (node.nextSongId && node.endMode !== 'transition') {
        edgesOut.push({
          id: 'link-' + songId, source: songId, target: node.nextSongId, type: 'active',
          data: { onDisconnect: () => onDisconnectSong(songId) },
          style: { stroke: lineColor.ink, strokeWidth: 2, strokeDasharray: '5 3' },
          markerEnd: { type: MarkerType.ArrowClosed, color: lineColor.ink, width: 10, height: 10 },
        });
      }
    });
    return edgesOut;
  }, [transitionEdgesRaw, activePlaylist, lineColor, mixingEdgeId, onDisconnectSong]);

  const onNodeDragStop = useCallback((_, node) => {
    if (node.id === END) return;
    onDragSongPosition(node.id, node.position.x, node.position.y);
  }, [onDragSongPosition]);

  const nowPlayingValue = useMemo(
    () => ({ nowPlayingId, elapsed: nowElapsedSec, duration: nowDurationSec }),
    [nowPlayingId, nowElapsedSec, nowDurationSec]
  );

  return (
    <NowPlayingContext.Provider value={nowPlayingValue}>
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodesConnectable
        elementsSelectable={false}
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
    </NowPlayingContext.Provider>
  );
}
