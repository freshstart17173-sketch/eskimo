import React, { useMemo, useCallback, useEffect } from 'react';
import { ReactFlow, Background, BackgroundVariant, MarkerType, BaseEdge, useNodesState } from '@xyflow/react';
import { END } from '../core.js';
import { NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import { SongNode, EndNode } from './GraphNodes.jsx';
import { useTheme } from '../theme.js';

const nodeTypes = { song: SongNode, end: EndNode };

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

const edgeTypes = { fanned: FannedEdge };

export default function GraphPane({
  songs, positions, transitionEdgesRaw, activePlaylist, socketDataById, onToggleSocket, mixingEdgeId,
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
    const socketData = socketDataById[id] || { leftTypes: [], rightTypes: [], leftActive: 'none', rightActive: 'none', leftLabel: null, rightLabel: null };
    return {
      id, type: 'song', position: pos, draggable: true,
      data: {
        song: s, state, dimmed: searchActive && !matchIds.has(id),
        hovered: hoveredId === id, inCount: io.inCount, outCount: io.outCount,
        onEnter: () => setHoveredId(id), onLeave: () => setHoveredId(null),
        onToggleSocket, ...socketData, playing: state === 'playing',
        position: id === nowPlayingId ? { elapsed: nowElapsedSec, duration: nowDurationSec } : null,
      },
      style: { width: NODE_W },
    };
  }
  function endNodeFor() {
    const pos = positions[END] || { x: 1250, y: 20 };
    return {
      id: END, type: 'end', position: pos, draggable: true,
      data: { state: stateFor(END), queued: endQueued },
      style: { width: END_W },
    };
  }

  // Recompute node render-data (position/state/hover/etc.) whenever the
  // inputs that matter change — RF's own state (from useNodesState) still
  // owns the live position during an in-progress drag. nowElapsedSec ticks
  // every second so the Playing node's numeric position/length stays live.
  useEffect(() => {
    setNodes(prev => prev.map(n => (n.id === END ? endNodeFor() : nodeFor(n.id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, positions, stateFor, ioById, hoveredId, matchIds, searchActive, socketDataById, endQueued, nowPlayingId, nowElapsedSec, nowDurationSec]);

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
        type: offset === 0 ? 'default' : 'fanned',
        data: offset === 0 ? undefined : { offset },
        animated: isActive && mixingEdgeId === e.id,
        style: { stroke: color, strokeWidth: isActive ? 3 : 1.5, strokeDasharray: isActive ? undefined : '2 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
        zIndex: isActive ? 2 : 0,
      };
    });
    Object.keys(activePlaylist.nodes).forEach(songId => {
      const node = activePlaylist.nodes[songId];
      if (node.nextSongId && node.endMode !== 'transition') {
        edgesOut.push({
          id: 'link-' + songId, source: songId, target: node.nextSongId, type: 'default',
          style: { stroke: lineColor.ink, strokeWidth: 2, strokeDasharray: '5 3' },
          markerEnd: { type: MarkerType.ArrowClosed, color: lineColor.ink, width: 10, height: 10 },
          zIndex: 1,
        });
      }
    });
    return edgesOut;
  }, [transitionEdgesRaw, activePlaylist, lineColor, mixingEdgeId]);

  const onNodeDragStop = useCallback((_, node) => {
    if (node.id === END) return;
    onDragSongPosition(node.id, node.position.x, node.position.y);
  }, [onDragSongPosition]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.25}
      maxZoom={2.5}
      colorMode={isDark ? 'dark' : 'light'}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      defaultEdgeOptions={{ type: 'default' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={dotColor} />
    </ReactFlow>
  );
}
