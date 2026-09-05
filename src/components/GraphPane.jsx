import React, { useMemo, useCallback } from 'react';
import { ReactFlow, MarkerType, useNodesState } from '@xyflow/react';
import { useEffect } from 'react';
import { END } from '../core.js';
import { NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import { SongNode, EndNode } from './GraphNodes.jsx';

const nodeTypes = { song: SongNode, end: EndNode };

const EDGE_COLOR = { base: '#c7c7c7', later: '#c9bfe0', next: '#8b7bb8', plan: '#131313' };
const EDGE_WIDTH = { base: 1.5, later: 2.5, next: 3.5, plan: 4 };

export default function GraphPane({
  songs, positions, transitionEdges, planSegments, stateFor, ioById,
  hoveredId, setHoveredId, matchIds, searchActive,
  layoutMode, onDragSongPosition, hoverCardFor, onStageEnd, endQueued,
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
    return {
      id, type: 'song', position: pos, draggable: layoutMode === 'manual',
      data: {
        song: s, state: stateFor(id), dimmed: searchActive && !matchIds.has(id),
        hovered: hoveredId === id, inCount: io.inCount, outCount: io.outCount,
        onEnter: () => setHoveredId(id), onLeave: () => setHoveredId(null),
        hoverCard: hoverCardFor(id),
      },
      style: { width: NODE_W },
    };
  }
  function endNodeFor() {
    const pos = positions[END] || { x: 1250, y: 20 };
    return {
      id: END, type: 'end', position: pos, draggable: false,
      data: { state: stateFor(END), queued: endQueued, onClick: onStageEnd },
      style: { width: END_W },
    };
  }

  // Recompute node render-data (position/state/hover/etc.) whenever the
  // inputs that matter change — RF's own state (from useNodesState) still
  // owns the live position during an in-progress drag.
  useEffect(() => {
    setNodes(prev => prev.map(n => (n.id === END ? endNodeFor() : nodeFor(n.id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, positions, stateFor, ioById, hoveredId, matchIds, searchActive, layoutMode, hoverCardFor, endQueued]);

  // songs/edges structurally changing (added/removed) needs a full rebuild,
  // not just a patch, so newly added nodes actually appear.
  useEffect(() => {
    setNodes(buildNodes());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(songs).join(','), transitionEdges.map(e => e.id).join(',')]);

  const rfEdges = useMemo(() => {
    const base = transitionEdges.map(e => ({
      id: e.id, source: e.l, target: e.r, type: 'default',
      style: { stroke: EDGE_COLOR[e._tier], strokeWidth: EDGE_WIDTH[e._tier] },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e._tier], width: 16, height: 16 },
      zIndex: e._tier === 'base' ? 0 : e._tier === 'later' ? 1 : 2,
    }));
    const plan = planSegments.map((seg, i) => ({
      id: 'plan-' + i, source: seg.from, target: seg.to, type: 'straight',
      style: { stroke: EDGE_COLOR.plan, strokeWidth: seg.width },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR.plan, width: 18, height: 18 },
      zIndex: 3,
    }));
    return [...base, ...plan];
  }, [transitionEdges, planSegments]);

  const onNodeDragStop = useCallback((_, node) => {
    if (node.id === END || layoutMode !== 'manual') return;
    onDragSongPosition(node.id, node.position.x, node.position.y);
  }, [onDragSongPosition, layoutMode]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodeTypes={nodeTypes}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.25}
      maxZoom={2.5}
      defaultEdgeOptions={{ type: 'default' }}
      proOptions={{ hideAttribution: true }}
    />
  );
}
