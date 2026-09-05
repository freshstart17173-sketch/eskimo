import React, { useMemo, useCallback, useEffect } from 'react';
import { ReactFlow, Background, BackgroundVariant, MarkerType, useNodesState } from '@xyflow/react';
import { END } from '../core.js';
import { NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import { SongNode, EndNode } from './GraphNodes.jsx';

const nodeTypes = { song: SongNode, end: EndNode };

const EDGE_COLOR = { base: '#c7c7c7', later: '#bcdcef', next: '#7fb3d9' };
const EDGE_WIDTH = { base: 1.5, later: 2, next: 3 };

export default function GraphPane({
  songs, positions, transitionEdges, stateFor, ioById,
  hoveredId, setHoveredId, matchIds, searchActive,
  onDragSongPosition, hoverCardFor, onStageEnd, endQueued,
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
      },
      style: { width: NODE_W },
    };
  }
  function endNodeFor() {
    const pos = positions[END] || { x: 1250, y: 20 };
    return {
      id: END, type: 'end', position: pos, draggable: true,
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
  }, [songs, positions, stateFor, ioById, hoveredId, matchIds, searchActive, hoverCardFor, endQueued]);

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
  const rfEdges = useMemo(() => transitionEdges.map(e => ({
    id: e.id, source: e.l, target: e.r, type: 'default',
    animated: e._tier === 'next',
    style: { stroke: EDGE_COLOR[e._tier], strokeWidth: EDGE_WIDTH[e._tier] },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e._tier], width: 10, height: 10 },
    zIndex: e._tier === 'base' ? 0 : e._tier === 'later' ? 1 : 2,
  })), [transitionEdges]);

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
