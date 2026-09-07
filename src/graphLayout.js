import dagre from 'dagre';
import { END, START } from './core.js';

export const NODE_W = 208;
export const NODE_H = 165;
export const END_W = 132;
export const END_H = 64;
export const START_W = 132;
export const START_H = 64;

// Auto-arrange via dagre: left-to-right rank layout, built from the graph's
// ACTUAL live wiring (activePlaylist) rather than every produced transition
// that structurally *could* exist. A library with several produced
// transitions between the same pair of songs (common — see TODO.md's
// multi-transition picker) used to turn "Arrange for me" into a genuinely
// tangled mess of every possible link at once; wiring is normally far
// sparser than the full structural edge set, so this alone does most of
// the "minimize crossings/clutter" work simply by giving dagre a much
// smaller, tree-like graph to lay out instead of a dense one. A song with
// no wiring at all just gets whatever rank dagre gives an otherwise-
// unconnected node. `nodesep`/`ranksep` widened a bit past dagre's default
// spacing for the same declutter goal — more breathing room between nodes
// that aren't actually connected.
export function computeDagreLayout(songs, activePlaylist) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 110, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  Object.keys(songs).forEach(id => g.setNode(id, { width: NODE_W, height: NODE_H }));
  g.setNode(END, { width: END_W, height: END_H });
  g.setNode(START, { width: START_W, height: START_H });

  Object.keys(activePlaylist.nodes).forEach(id => {
    const node = activePlaylist.nodes[id];
    if (node.nextSongId && songs[id] !== undefined) g.setEdge(id, node.nextSongId);
  });
  if (activePlaylist.startSongId && songs[activePlaylist.startSongId]) g.setEdge(START, activePlaylist.startSongId);

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
