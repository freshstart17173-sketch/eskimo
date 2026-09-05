// How long can this graph play seamlessly (transitions only) before it has
// to repeat a song?
//
// The exact answer is the longest simple path in a directed graph — NP-hard
// in general (equivalent to Hamiltonian path; see Wikipedia's "Longest path
// problem"), and *counting* how many such orderings exist is #P-complete —
// there is no efficient exact algorithm for either, and none can exist
// unless P = NP. So this doesn't try to compute an exact number. Instead:
//
// 1. Find strongly-connected components (Tarjan's algorithm, O(V+E)) — any
//    SCC with more than one song (or a self-loop) is a closed loop: once
//    you're in it, transition-only playback can continue forever without
//    running out of *moves*, though it may have to repeat songs already
//    played within that loop to keep going.
// 2. Contract each SCC to a single node (the "condensation") — this is
//    always a DAG, so its longest path is solvable exactly in linear time
//    (standard topological-order DP, no NP-hardness here).
// 3. Weight each condensation node by its SCC's song count and take the
//    longest weighted path — an optimistic upper bound on how many
//    *distinct* songs a seamless run could visit before either dead-ending
//    (no loop reachable) or being forced to repeat (stuck wandering a loop
//    already fully visited). It's an upper bound, not a guarantee, because
//    actually visiting every song in a multi-song SCC without repeating is
//    itself a Hamiltonian-path question inside that SCC.

function stronglyConnectedComponents(nodeIds, adjacency) {
  let index = 0;
  const indices = new Map(), lowlink = new Map(), onStack = new Set();
  const stack = [];
  const components = [];

  function strongConnect(v) {
    indices.set(v, index); lowlink.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of (adjacency.get(v) || [])) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop(); onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      components.push(comp);
    }
  }

  for (const v of nodeIds) if (!indices.has(v)) strongConnect(v);
  return components;
}

export function estimateSeamlessLength(songs, edges) {
  const nodeIds = Object.keys(songs);
  if (nodeIds.length === 0) return { upperBound: 0, loopSongs: [], hasLoop: false, totalSongs: 0 };

  const adjacency = new Map(nodeIds.map(id => [id, []]));
  edges.forEach(e => {
    if (e.type === 'transition' && e.verified && e.l && e.r && adjacency.has(e.l)) adjacency.get(e.l).push(e.r);
  });

  const components = stronglyConnectedComponents(nodeIds, adjacency);
  const compOf = new Map();
  components.forEach((comp, i) => comp.forEach(id => compOf.set(id, i)));

  // a loop = an SCC with >1 song, or a single song with a self-transition
  const loopComponents = components.filter(comp =>
    comp.length > 1 || adjacency.get(comp[0]).includes(comp[0])
  );
  const loopSongs = loopComponents.flat();

  // condensation DAG: edge between component A -> B if any song in A
  // transitions to any song in B (A !== B)
  const condAdj = new Map(components.map((_, i) => [i, new Set()]));
  edges.forEach(e => {
    if (e.type !== 'transition' || !e.verified || !e.l || !e.r) return;
    if (!compOf.has(e.l) || !compOf.has(e.r)) return;
    const a = compOf.get(e.l), b = compOf.get(e.r);
    if (a !== b) condAdj.get(a).add(b);
  });

  // longest weighted path in a DAG via memoized DFS (weights = component size)
  const memo = new Map();
  function longestFrom(i) {
    if (memo.has(i)) return memo.get(i);
    let best = 0;
    for (const j of condAdj.get(i)) best = Math.max(best, longestFrom(j));
    const total = components[i].length + best;
    memo.set(i, total);
    return total;
  }
  let upperBound = 0;
  for (let i = 0; i < components.length; i++) upperBound = Math.max(upperBound, longestFrom(i));

  return { upperBound, loopSongs, hasLoop: loopSongs.length > 0, totalSongs: nodeIds.length };
}
