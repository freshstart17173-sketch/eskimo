// Plain node-footprint constants, split out of graphLayout.js so they can
// be imported without pulling dagre along — graphLayout.js's own
// `computeDagreLayout` is the only thing that actually needs dagre, but
// these dimensions are needed unconditionally (GraphPane.jsx's rendering,
// App.jsx's collision-avoiding placement) by code that's never lazy about
// loading, so importing them FROM graphLayout.js directly would have
// pulled dagre into whichever bundle did that even when Autoarrange is
// never clicked.
export const NODE_W = 208;
export const NODE_H = 165;
export const END_W = 132;
export const END_H = 64;
export const START_W = 132;
export const START_H = 64;
