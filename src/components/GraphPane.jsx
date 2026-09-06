import React, { useMemo, useCallback, useEffect } from 'react';
import { ReactFlow, Background, BackgroundVariant, MarkerType, BaseEdge, useNodesState } from '@xyflow/react';
import { END } from '../core.js';
import { NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import { SongNode, EndNode } from './GraphNodes.jsx';

const nodeTypes = { song: SongNode, end: EndNode };

const EDGE_COLOR = { base: '#c7c7c7', later: '#bcdcef', next: '#7fb3d9' };
const EDGE_WIDTH = { base: 1.5, later: 2, next: 3 };

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
  songs, positions, transitionEdges, stateFor, ioById,
  hoveredId, setHoveredId, matchIds, searchActive,
  onDragSongPosition, hoverCardFor, onRequestEndSet, endQueued,
  nowPlayingId, nowElapsedSec, nowDurationSec,
}) {
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
    return {
      id, type: 'song', position: pos, draggable: true,
      data: {
        song: s, state, dimmed: searchActive && !matchIds.has(id),
        hovered: hoveredId === id, inCount: io.inCount, outCount: io.outCount,
        onEnter: () => setHoveredId(id), onLeave: () => setHoveredId(null),
        hoverCard: hoverCardFor(id), playing: state === 'playing',
        position: id === nowPlayingId ? { elapsed: nowElapsedSec, duration: nowDurationSec } : null,
      },
      style: { width: NODE_W },
    };
  }
  function endNodeFor() {
    const pos = positions[END] || { x: 1250, y: 20 };
    return {
      id: END, type: 'end', position: pos, draggable: true,
      data: { state: stateFor(END), queued: endQueued, onClick: onRequestEndSet },
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
  }, [songs, positions, stateFor, ioById, hoveredId, matchIds, searchActive, hoverCardFor, endQueued, nowPlayingId, nowElapsedSec, nowDurationSec]);

  // songs/edges structurally changing (added/removed) needs a full rebuild,
  // not just a patch, so newly added nodes actually appear.
  useEffect(() => {
    setNodes(buildNodes());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(songs).join(','), transitionEdges.map(e => e.id).join(',')]);

  // No separate "committed path" overlay — the active connection is shown
  // by animating the actual edge (marching-ants dash) between whatever's
  // Playing and its Next candidates, on top of the tier coloring that
  // already marks what's connected to what. One line, animated, simple.
  // Multiple produced transitions between the same two songs would otherwise
  // render as fully overlapping lines — give each one after the first in a
  // source/target pair a growing perpendicular offset, alternating sides, so
  // they fan out and stay individually visible on the canvas regardless of
  // whether the two nodes happen to sit at the same height (a plain
  // curvature tweak on the default bezier doesn't separate those).
  const rfEdges = useMemo(() => {
    const seen = new Map();
    return transitionEdges.map(e => {
      const pairKey = e.l + '->' + e.r;
      const dupIndex = seen.get(pairKey) || 0;
      seen.set(pairKey, dupIndex + 1);
      const offset = dupIndex === 0 ? 0 : Math.ceil(dupIndex / 2) * 26 * (dupIndex % 2 === 1 ? 1 : -1);
      return {
        id: e.id, source: e.l, target: e.r,
        type: offset === 0 ? 'default' : 'fanned',
        data: offset === 0 ? undefined : { offset },
        animated: e._tier === 'next',
        style: { stroke: EDGE_COLOR[e._tier], strokeWidth: EDGE_WIDTH[e._tier] },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e._tier], width: 10, height: 10 },
        zIndex: e._tier === 'base' ? 0 : e._tier === 'later' ? 1 : 2,
      };
    });
  }, [transitionEdges]);

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
      defaultEdgeOptions={{ type: 'default' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#c8c8c8" />
    </ReactFlow>
  );
}
