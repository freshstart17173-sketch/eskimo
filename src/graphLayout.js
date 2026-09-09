import dagre from 'dagre';
import { END, START, allDestinationIds } from './core.js';
// Re-exported for backward compatibility — everything that only needs the
// plain dimensions (not the actual dagre layout function) should import
// them from graphConstants.js directly instead, so it doesn't pull dagre
// in along with them. See that file's own comment for why this split
// exists at all.
import { NODE_W, NODE_H, END_W, END_H, START_W, START_H } from './graphConstants.js';
export { NODE_W, NODE_H, END_W, END_H, START_W, START_H };

// Auto-arrange via dagre: left-to-right rank layout, built from the graph's
// ACTUAL live wiring (activePlaylist) rather than every produced transition
// that structurally *could* exist. A library with several produced
// transitions between the same pair of songs (common — see TODO.md's
// multi-transition picker) used to turn "Arrange for me" into a genuinely
// tangled mess of every possible link at once; wiring is normally far
// sparser than the full structural edge set, so this alone does most of
// the "minimize crossings/clutter" work simply by giving dagre a much
// smaller, tree-like graph to lay out instead of a dense one.
// `nodesep`/`ranksep` widened a bit past dagre's default spacing for the
// same declutter goal — more breathing room between nodes that aren't
// actually connected.
export function computeDagreLayout(songs, activePlaylist) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 110, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  // Only feed dagre songs that actually participate in some real wiring
  // (a source or destination of a connection, or the Start node's own
  // entry point). A song dagre has no edge for isn't something it can
  // rank at all — every such singleton "component" was landing at the
  // very same rank, one directly below the next, so a library with more
  // songs sitting in the canvas than are currently wired into a sequence
  // (the ordinary case — most songs, most of the time) turned the entire
  // canvas into one long vertical line regardless of how the wired part
  // itself was actually shaped (reported directly). The wired portion
  // still gets dagre's real tree layout exactly as before; every
  // unwired song is packed into its own grid afterward instead (below),
  // which is what dagre's own ranking has no mechanism for.
  const wiredSongIds = new Set();
  Object.keys(activePlaylist.nodes).forEach(id => {
    if (songs[id] === undefined) return;
    const node = activePlaylist.nodes[id];
    // Every destination, not just node.nextSongId (only ever the most-
    // recently-wired one) — a node's other transition(s) used to be
    // completely invisible here, leaving that destination with no
    // positional relationship to its real source at all. See
    // allDestinationIds's own comment (core.js) for the exact bug this
    // produced (a huge, pointless diagonal line clear across the graph).
    // END counts as a real destination here (a wire to End Set is a
    // genuine connection, not a dead end to ignore) even though it isn't
    // one of `songs` — only an actually-stale/nonexistent id gets dropped.
    const dests = allDestinationIds(node).filter(d => d === END || songs[d] !== undefined);
    if (dests.length > 0) { wiredSongIds.add(id); dests.forEach(d => { if (d !== END) wiredSongIds.add(d); }); }
  });
  if (activePlaylist.startSongId && songs[activePlaylist.startSongId]) wiredSongIds.add(activePlaylist.startSongId);

  wiredSongIds.forEach(id => g.setNode(id, { width: NODE_W, height: NODE_H }));
  g.setNode(END, { width: END_W, height: END_H });
  g.setNode(START, { width: START_W, height: START_H });

  Object.keys(activePlaylist.nodes).forEach(id => {
    if (!wiredSongIds.has(id)) return;
    allDestinationIds(activePlaylist.nodes[id]).forEach(destId => {
      if (wiredSongIds.has(destId) || destId === END) g.setEdge(id, destId);
    });
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

  // Wrap a long single-file chain into multiple rows instead of one
  // ever-widening horizontal strip. A real DJ set is normally a long,
  // mostly-linear run of songs — dagre's rank layout has no concept of a
  // maximum row width, so a 30/50/100-song sequence turned Autoarrange
  // into one line clear across the canvas (reported directly), even
  // though the ranking itself was correct. Every node dagre placed at the
  // same x in this LR layout is the same rank; regroup ranks into bands
  // capped at a fixed width and stack the bands, snaking alternate rows
  // back the other direction (like text wrapping) so a wire crossing a
  // row boundary only ever has to drop straight down to continue, not
  // jump back across the whole canvas.
  const RANKS_PER_ROW = 8;
  const rankGroups = new Map();
  g.nodes().forEach(id => {
    const x = Math.round(g.node(id).x);
    if (!rankGroups.has(x)) rankGroups.set(x, []);
    rankGroups.get(x).push(id);
  });
  const ranks = [...rankGroups.keys()].sort((a, b) => a - b).map(x => rankGroups.get(x));
  let maxX = 0, maxY = 0;
  if (ranks.length > RANKS_PER_ROW) {
    let rowTop = 20;
    for (let rowStart = 0; rowStart < ranks.length; rowStart += RANKS_PER_ROW) {
      const rowRanks = ranks.slice(rowStart, rowStart + RANKS_PER_ROW);
      const snakeBack = (rowStart / RANKS_PER_ROW) % 2 === 1;
      let rowMinY = Infinity, rowMaxY = -Infinity;
      rowRanks.forEach(ids => ids.forEach(id => {
        const h = id === END ? END_H : id === START ? START_H : NODE_H;
        rowMinY = Math.min(rowMinY, positions[id].y);
        rowMaxY = Math.max(rowMaxY, positions[id].y + h);
      }));
      rowRanks.forEach((ids, i) => {
        const col = snakeBack ? (rowRanks.length - 1 - i) : i;
        ids.forEach(id => {
          const w = id === END ? END_W : id === START ? START_W : NODE_W;
          positions[id] = { x: 20 + col * (NODE_W + 110), y: rowTop + (positions[id].y - rowMinY) };
          maxX = Math.max(maxX, positions[id].x + w);
        });
      });
      rowTop += (rowMaxY - rowMinY) + 90;
    }
    maxY = rowTop;
  } else {
    g.nodes().forEach(id => {
      const w = id === END ? END_W : id === START ? START_W : NODE_W;
      const h = id === END ? END_H : id === START ? START_H : NODE_H;
      maxX = Math.max(maxX, positions[id].x + w);
      maxY = Math.max(maxY, positions[id].y + h);
    });
  }

  // Every song with no wiring at all — a real grid, sized to roughly the
  // wired section's own width so the whole canvas still reads as one
  // arrangement, placed below it rather than interleaved (keeps the
  // wired portion's own tree shape legible on its own).
  const unwiredIds = Object.keys(songs).filter(id => !wiredSongIds.has(id));
  if (unwiredIds.length > 0) {
    // Match the wired section's own width when there is one wide enough to
    // matter; otherwise (nothing wired at all — the ordinary state of a
    // freshly-built library) fall back to a roughly square grid instead of
    // the single column a small `maxX` would otherwise force this into.
    const cols = Math.max(Math.round(maxX / (NODE_W + 50)), Math.ceil(Math.sqrt(unwiredIds.length)), 1);
    const gridTop = maxY + 110;
    unwiredIds.forEach((id, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      positions[id] = { x: 20 + col * (NODE_W + 50), y: gridTop + row * (NODE_H + 50) };
    });
  }

  return positions;
}
