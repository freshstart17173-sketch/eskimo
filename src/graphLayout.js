import dagre from 'dagre';
import { END, START } from './core.js';

export const NODE_W = 208;
export const NODE_H = 165;
export const END_W = 132;
export const END_H = 64;
export const START_W = 132;
export const START_H = 64;

// Auto-arrange via dagre: left-to-right rank layout. Transitions rank two
// songs against each other; an outro edge ranks its song against the END
// sentinel so "songs that can close the set" naturally drift toward the
// far right, and (symmetrically) an intro edge ranks its song against the
// START sentinel so "songs that can open the set" drift toward the far
// left. Songs with neither just get whatever rank dagre gives an
// otherwise-unconnected node.
export function computeDagreLayout(songs, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  Object.keys(songs).forEach(id => g.setNode(id, { width: NODE_W, height: NODE_H }));
  g.setNode(END, { width: END_W, height: END_H });
  g.setNode(START, { width: START_W, height: START_H });

  edges.forEach(e => {
    if (e.type === 'transition' && e.l && e.r) g.setEdge(e.l, e.r);
    if (e.type === 'outro' && e.l) g.setEdge(e.l, END);
    if (e.type === 'intro' && e.r) g.setEdge(START, e.r);
  });

  dagre.layout(g);

  const positions = {};
  g.nodes().forEach(id => {
    const n = g.node(id);
    const w = id === END ? END_W : id === START ? START_W : NODE_W;
    const h = id === END ? END_H : id === START ? START_H : NODE_H;
    // dagre gives node centers; the app's node objects store top-left x/y
    positions[id] = { x: n.x - w / 2, y: n.y - h / 2 };
  });
  return positions;
}
