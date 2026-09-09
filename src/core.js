// =====================================================================================
// Eskimo Studio — core data model & pure logic (no React here — plain JS, easy to unit
// test). A song is flat (no version sub-objects) — a remix is just another song.
// =====================================================================================
import { createClient } from '@supabase/supabase-js';
import { APP_CONFIG } from './config.js';
import { putLocalAudio } from './localAudioStore.js'; // generic IndexedDB blob store despite the name — see uploadCoverIfPossible below

export const END = '__end__';
// Purely a visual bookend on the graph canvas (see GraphNodes.jsx's
// StartNode) — unlike END, nothing ever gets queued "at" START; a set can
// start from any song, so there's no equivalent operational meaning to
// bolt on here. It exists so the canvas reads as a graph with a real
// entry point, symmetric with how END gives it a real exit point.
export const START = '__start__';
const STORAGE_KEY = 'djflow:v3';

// ---------------------------------------------------------------------------
// Real app state starts empty — no demo/sample data is ever loaded into the
// app on its own. This same fixture doubles as both realistic data for
// pure-logic unit tests and the guided "load an example graph" first-run
// feature (App.jsx's loadExample) — the app itself never calls these on its
// own initiative, only in direct response to that explicit click.
// ---------------------------------------------------------------------------
// Two real, recognizable tracklists (titles/durations only — plain factual
// metadata, no issue reproducing that) so the example graph actually looks
// like someone's library instead of five made-up placeholder songs. Cover
// art is deliberately NOT the real album photos: this fixture ships in
// committed source (this file is public on GitHub, and the built app
// deploys publicly too), so embedding an actual copyrighted photograph
// here would be redistributing it, not just using it privately the way
// ripping your own CDs into a personal library app would be. The two
// swatches below are simple original shapes inspired by each album's own
// color story (a flat purple field; an off-white field with a red accent
// block) — enough to demo the color-match feature without reproducing
// anyone's actual artwork. BPM/Key weren't supplied, so these are round
// illustrative placeholders, not verified figures — don't rely on them
// for actual mixing.
// One shared swatch per artist used to look flatly monochrome across a
// whole 16- or 10-song group (real per-song variety is exactly what the
// color-match feature exists to show off) — a small cycling palette per
// artist instead, each still a simple original flat-color/geometric
// shape, never a specific real cover redrawn, so the same "don't
// redistribute anyone's actual artwork" constraint above holds per swatch,
// not just for one shared one.
function swatchCover(bg, accent) {
  const accentRect = accent
    ? "%3Crect x='190' y='55' width='95' height='95' fill='" + encodeURIComponent(accent) + "' transform='rotate(10 237 102)'/%3E"
    : '';
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='"
    + encodeURIComponent(bg) + "'/%3E" + accentRect + "%3C/svg%3E";
}
const PIERRE4_COVERS = [
  swatchCover('#6a5490'), swatchCover('#7a4fa8'), swatchCover('#4f3a78'), swatchCover('#8a5fc2'),
  swatchCover('#5a4098'), swatchCover('#6a3a8a'), swatchCover('#8a70b8'), swatchCover('#3f2f68'),
];
const YEEZUS_COVERS = [
  swatchCover('#f0f0ee', '#d32f1e'), swatchCover('#f0f0ee', '#2f6ed3'), swatchCover('#f0f0ee', '#d3a02f'),
  swatchCover('#f0f0ee', '#2fa88a'), swatchCover('#f0f0ee', '#a82f8a'),
];
const WLR_COVERS = [
  swatchCover('#c41e3a'), swatchCover('#d4344f'), swatchCover('#a01530'), swatchCover('#e0455f'),
  swatchCover('#8f1029'), swatchCover('#b82840'),
];

export function sampleSongsForTests() {
  // The Life of Pi'erre 4 — Pi'erre Bourne. All 16 tracks, transitioning
  // into each other in tracklist order (see sampleEdgesForTests).
  const pierre4 = [
    ['Poof', 183], ['Try Again', 147], ['Feds', 188], ['Be Mine', 258],
    ['Ballad', 181], ['Routine', 166], ['Lovers', 184], ['How High', 250],
    ['Romeo Must Die', 161], ['Racer', 295], ['Stereotypes', 188], ['Doublemint', 188],
    ['Horoscopes', 147], ['Juice', 143], ['Guillotine', 180], ['Speed Dial', 151],
  ];
  // Yeezus — Kanye West. All 10 tracks.
  const yeezus = [
    ['On Sight', 156], ['Black Skinhead', 188], ['I Am a God', 231], ['New Slaves', 256],
    ['Hold My Liquor', 326], ['I’m In It', 234], ['Blood on the Leaves', 360], ['Guilt Trip', 243],
    ['Send It Up', 178], ['Bound 2', 229],
  ];
  // Whole Lotta Red — Playboi Carti. All 24 tracks (standard edition) — the
  // third artist added to roughly double the example set's size, asked for
  // directly to stress-test multi-input/output wiring and Autoarrange at a
  // scale actually worth testing against (see sampleEdgesForTests below for
  // the bridge/branch/convergence/loop wiring across all three artists).
  const wholeLottaRed = [
    ['Rockstar Made', 233], ['Go2DaMoon', 143], ['Stop Breathing', 181], ['Beno!', 176],
    ['JumpOutTheHouse', 153], ['New Tank', 135], ['Teen X', 217], ['Slay3r', 186],
    ['Vamp Anthem', 135], ['New N3on', 194], ['Punk Monk', 203], ['On That Time', 146],
    ['M3tamorphosis', 233], ['Not Playing', 195], ['Sky', 187], ['Meh', 149],
    ['Die4Guy', 207], ['Place', 188], ['ILoveUIHateU', 194], ['Over', 153],
    ['King Vamp', 185], ['Control', 216], ['Panel Kant', 161], ['F33l Lik3 Dyin', 255],
  ];
  const songs = {};
  const cols = 8, colSpacing = 260, rowSpacing = 220;
  pierre4.forEach(([title, durationSec], i) => {
    songs['p' + (i + 1)] = {
      id: 'p' + (i + 1), title, artist: "Pi'erre Bourne",
      x: 40 + (i % cols) * colSpacing, y: 40 + Math.floor(i / cols) * rowSpacing,
      bpm: 140, key: 'F min', durationSec, coverUrl: PIERRE4_COVERS[i % PIERRE4_COVERS.length],
    };
  });
  yeezus.forEach(([title, durationSec], i) => {
    songs['y' + (i + 1)] = {
      id: 'y' + (i + 1), title, artist: 'Kanye West',
      x: 40 + (i % 5) * colSpacing, y: 520 + Math.floor(i / 5) * rowSpacing,
      bpm: 110, key: 'C min', durationSec, coverUrl: YEEZUS_COVERS[i % YEEZUS_COVERS.length],
    };
  });
  wholeLottaRed.forEach(([title, durationSec], i) => {
    songs['c' + (i + 1)] = {
      id: 'c' + (i + 1), title, artist: 'Playboi Carti',
      x: 40 + (i % cols) * colSpacing, y: 1020 + Math.floor(i / cols) * rowSpacing,
      bpm: 145, key: 'G min', durationSec, coverUrl: WLR_COVERS[i % WLR_COVERS.length],
    };
  });
  return songs;
}
export function sampleEdgesForTests() {
  const edges = [
    { id: 'e-p-intro', type: 'intro', r: 'p1', verified: true },
    { id: 'e-p-outro', type: 'outro', l: 'p16', verified: true },
    { id: 'e-c-outro', type: 'outro', l: 'c24', verified: true },
  ];
  for (let i = 1; i < 16; i++) {
    edges.push({ id: 'e-p' + i + '-' + (i + 1), type: 'transition', l: 'p' + i, r: 'p' + (i + 1), verified: true });
  }
  for (let i = 1; i < 10; i++) {
    edges.push({ id: 'e-y' + i + '-' + (i + 1), type: 'transition', l: 'y' + i, r: 'y' + (i + 1), verified: true });
  }
  for (let i = 1; i < 24; i++) {
    edges.push({ id: 'e-c' + i + '-' + (i + 1), type: 'transition', l: 'c' + i, r: 'c' + (i + 1), verified: true });
  }
  // Cross-artist wiring — bridges the three chains into one graph and
  // deliberately exercises every scenario asked for in the same pass that
  // fixed them, rather than leaving that to chance:
  //  - p16 (end of the Pi'erre chain) gets a SECOND transition target
  //    alongside its existing outro — a real multi-output fan-out, the
  //    exact shape Autoarrange used to mis-place (see graphLayout.js).
  //  - c1 (start of the Carti chain) receives from both p16 and y10 — a
  //    real multi-input convergence, the exact shape that used to lose
  //    its first wire the moment a second one was dragged in (see
  //    addTransitionConnection, core.js).
  //  - p8 also transitions directly into c12, a second, unrelated
  //    multi-input example away from the chain seams.
  //  - c24 transitions back to p1, closing all three artists into one
  //    loop — transition-only autoplay can run through it forever, and
  //    Autoarrange needs to render that closing edge as a clean curve,
  //    not a diagonal mess (see graphLayout.js's own cycle handling).
  edges.push(
    { id: 'e-bridge-p16-y1', type: 'transition', l: 'p16', r: 'y1', verified: true },
    { id: 'e-bridge-p16-c1', type: 'transition', l: 'p16', r: 'c1', verified: true },
    { id: 'e-bridge-y10-c1', type: 'transition', l: 'y10', r: 'c1', verified: true },
    { id: 'e-multiinput-p8-c12', type: 'transition', l: 'p8', r: 'c12', verified: true },
    { id: 'e-loop-c24-p1', type: 'transition', l: 'c24', r: 'p1', verified: true },
  );
  return edges;
}

export function emptySession() {
  return {
    nowPlayingId: null, startMethod: null,
    queue: [], timeLeft: 0, isPlaying: false, setEnded: false,
    // The one control for what the manual Next list offers and how Now
    // Playing would end if nothing more gets queued: 'transition' shows
    // only built transitions (an outgoing transition already carries its
    // own ending); 'cut' or 'outro' show every other song, and decide
    // whether Now Playing hard-cuts or plays its outro fragment first.
    nextMode: 'transition', // 'transition' | 'cut' | 'outro'
    autoplay: false, // when true and nothing's manually queued, pickAutoplayNext chooses
    transitionOnly: false, // true = a dead end stops the set instead of cutting to a random song
    autoHistory: [], // songs autoplay has actually played, most recent last — for the bottom queue bar
    // Every song Now Playing has actually been on this session, most
    // recent last — what the Back button pops from. Separate from
    // autoHistory above: that one is display-only and autoplay-specific;
    // this one is pushed on *every* nowPlayingId change regardless of how
    // it happened (a wired hop, a manual commit, autoplay), since Back has
    // to work no matter which of those got you here.
    history: [],
    activePlaylist: emptyActivePlaylist(), // the graph's live, always-editable wiring — see TODO.md
    // Start/End's own dragged canvas position — null means "use the
    // default spawn spot". These aren't songs, so they have nowhere else
    // to persist a manual drag the way a song's own x/y already does; kept
    // here (not activePlaylist, which is about wiring, not layout) purely
    // because this is the one already-persisted bucket both PerformPage
    // and GraphPane already share.
    startPos: null, endPos: null,
    // Which songs actually have a node placed on the graph canvas — null
    // means "not migrated yet" (PerformPage seeds it from every song that
    // already exists, once, on first load) rather than "empty", so an
    // existing library's graph isn't wiped the moment this field ships.
    // Once set, it's authoritative: a song added later via Upload/Library
    // does NOT automatically get a node here too — a library is meant to
    // hold far more songs than any one set actually uses, and dumping every
    // one of them onto the canvas at once was reported directly as making
    // it impossible to build a readable playlist. Placing a song (the
    // canvas's "Add node here") or removing one just drops/adds its id.
    canvasIds: null,
  };
}

// The graph-as-playlist-editor's live wiring (TODO.md has the full spec).
// A sparse map keyed by songId — most songs in a library won't participate.
// One direction of truth: an ordinary connection is always written from its
// source's `nextSongId`/`endMode`/`endEdgeId`, and the destination's
// `startMode`/`startEdgeId` are kept in sync by the same write, never set
// independently. `startSongId`/`startMode`/`startEdgeId` are Start Set's own,
// entirely separate fields — it has no `endMode`/`nextSongId` (it isn't a
// song, nothing ever plays "from" it in the queue sense), and critically it
// does NOT share the destination song's `startMode`/`startEdgeId` the way an
// earlier version of this once did. This is a genuinely non-linear editor —
// a song can just as easily be reached by Start jumping straight to it as by
// some other song's Outro/Transition leading into it, and those two paths
// can legitimately want different arrival styles (Start cutting straight in
// vs. another song's outro flowing into this one's own intro). Sharing one
// field between them meant wiring Start to a song silently overwrote (or got
// silently overwritten by) whatever a completely unrelated incoming wire
// into that same song had already chosen — reported directly as a bug: wire
// Start to song A's None, separately wire song B's Outro to A's Intro, and
// the two "fight" over A's one shared field instead of both simply working.
export function emptyActivePlaylist() { return { id: null, name: '', nodes: {}, startSongId: null, startMode: 'none', startEdgeId: null }; }

// Wires Start Set to `songId` — v1 single-slot, same as every other socket:
// dragging a new connection from Start silently replaces whichever song
// was wired before. Deliberately never touches `nodes[songId]` — Start's
// own arrival style lives entirely on the playlist's own startMode/
// startEdgeId fields (see emptyActivePlaylist's comment above) so it can
// never collide with an unrelated ordinary wire into the same song.
export function wireStart(playlist, songId, startMode, startEdgeId) {
  return { ...playlist, startSongId: songId, startMode, startEdgeId: startEdgeId || null };
}
// Disconnects Start Set. Nothing to clean up on any song's own node entry —
// Start never wrote to one (see wireStart) — just clear Start's own pointer.
export function unwireStart(playlist) {
  if (!playlist.startSongId) return playlist;
  return { ...playlist, startSongId: null, startMode: 'none', startEdgeId: null };
}

function playlistNode(playlist, songId) {
  return playlist.nodes[songId] || { startMode: 'none', startEdgeId: null, outputs: [] };
}

// A node's outgoing wiring, unified: `outputs` is a flat list of
// { type: 'none'|'outro'|'transition', edgeId, targetId } entries, and a
// node can carry active entries of MORE THAN ONE TYPE AT ONCE now — a song
// can simultaneously have an active None wire to one place, an active
// Outro wire to another, and one-or-more active Transitions to others,
// with the random hop below picking a type first, then a destination
// within it (reported directly, from a screenshot showing exactly this:
// two differently-typed lines both leaving one song at once, asking for
// the earlier "one active endMode" design to become "several, at once").
// At most one None entry and one Outro entry per node — dragging a new
// one of either replaces the old one of that SAME type only, same
// single-slot-per-type behavior none/outro always had; Transition alone
// can carry several simultaneously (addTransitionConnection below),
// unchanged from before this rework. A destination's own arrival
// (startMode/startEdgeId) stays single-slot — out of scope here by
// direct instruction ("multiple intros/outros/transitions per destination
// should be off the table for now").
//
// `nodeOutputs` also carries the fallback for data saved before `outputs`
// existed (the old singular endMode/endEdgeId/nextSongId, with
// `transitions` only ever populated when endMode==='transition') — new
// writes always populate `outputs` directly and never re-create the old
// fields, so this fallback only ever fires for a node untouched since
// before this rework.
export function nodeOutputs(node) {
  if (node.outputs) return node.outputs;
  if (node.endMode === 'transition') {
    if (node.transitions && node.transitions.length) return node.transitions.map(t => ({ type: 'transition', edgeId: t.edgeId, targetId: t.targetId }));
    return node.endEdgeId ? [{ type: 'transition', edgeId: node.endEdgeId, targetId: node.nextSongId }] : [];
  }
  if ((node.endMode === 'none' || node.endMode === 'outro') && node.nextSongId) {
    return [{ type: node.endMode, edgeId: node.endEdgeId || null, targetId: node.nextSongId }];
  }
  return [];
}

// Every destination a node's own outgoing wiring actually reaches, across
// every active type at once. graphLayout.js's Autoarrange needs this same
// "every one, not just the first" view for its own dagre edges — a node's
// other output(s) used to be completely invisible to it, leaving that
// destination with no positional relationship to its real source at all
// and dumping it wherever dagre parks an otherwise-disconnected node
// (reported directly as Autoarrange drawing a huge, pointless diagonal
// line back across the whole graph).
export function allDestinationIds(node) {
  return nodeOutputs(node).map(o => o.targetId).filter(Boolean);
}

// Wires one full connection for a given output `type` — a Transition drag
// (edgeId names the produced edge, toId is just edge.r) and a None/Outro
// drag (toId is whatever node the DJ dropped on, edgeId is the outro edge
// if any, the destination's startEdgeId is its intro edge if any) both
// resolve through this same function, always updating both ends together
// so the playlist can never end up with a dangling half-wire only one
// side knows about. Replaces whichever entry of this SAME `type` already
// existed on `fromId` (None/Outro's single-slot-per-type rule) — every
// other type's own entries are carried forward untouched, which is the
// whole point of this rework. Use addTransitionConnection instead for a
// Transition drag, which adds rather than replaces.
export function wireConnection(playlist, fromId, toId, type, edgeId, startMode, startEdgeId) {
  const node = playlistNode(playlist, fromId);
  const outputs = nodeOutputs(node).filter(o => o.type !== type);
  outputs.push({ type, edgeId: edgeId || null, targetId: toId });
  const nodes = { ...playlist.nodes };
  nodes[fromId] = { startMode: node.startMode, startEdgeId: node.startEdgeId, outputs };
  nodes[toId] = { ...playlistNode(playlist, toId), startMode, startEdgeId: startEdgeId || null };
  return { ...playlist, nodes };
}

// Disconnects songId's ENTIRE outgoing wire — every active type and every
// simultaneous transition within it, not just one — clearing every
// destination it pointed to back to 'none' rather than leaving any of
// them silently claiming a connection that's no longer there. Use
// removeOutput instead when only one specific type/edge among several
// active ones should go.
export function unwireOutput(playlist, songId) {
  const node = playlistNode(playlist, songId);
  const outputs = nodeOutputs(node);
  if (outputs.length === 0) return playlist;
  const nodes = { ...playlist.nodes };
  nodes[songId] = { startMode: node.startMode, startEdgeId: node.startEdgeId, outputs: [] };
  outputs.forEach(o => {
    if (o.targetId && nodes[o.targetId]) nodes[o.targetId] = { ...nodes[o.targetId], startMode: 'none', startEdgeId: null };
  });
  return { ...playlist, nodes };
}

// A song can carry more than one simultaneous Transition — dragging a
// second one in adds to the set rather than replacing the first (this is
// also what "Autoconnect" below wires up in bulk), and leaves any active
// None/Outro entries on the same node alone too. Which one actually plays
// is picked at random each time (playlistNextHop) until a real weighting
// system exists; the graph itself still shows every wired candidate as a
// solid active line, so nothing about what's *possible* is hidden the way
// a blind shuffle would. A no-op if this exact edge is already wired.
export function addTransitionConnection(playlist, fromId, toId, edgeId) {
  const node = playlistNode(playlist, fromId);
  const outputs = nodeOutputs(node);
  if (outputs.some(o => o.type === 'transition' && o.edgeId === edgeId)) return playlist;
  const nodes = { ...playlist.nodes };
  nodes[fromId] = { startMode: node.startMode, startEdgeId: node.startEdgeId, outputs: [...outputs, { type: 'transition', edgeId, targetId: toId }] };
  // Input stays single-choice (v1) — if more than one song ends up wiring a
  // transition into the same destination, whichever wrote last wins here,
  // same as any other pre-existing wiring collision on a shared socket.
  nodes[toId] = { ...playlistNode(playlist, toId), startMode: 'transition', startEdgeId: edgeId };
  return { ...playlist, nodes };
}

// Removes exactly one output entry — identified by its `type` plus
// `edgeId` (None's is always null, Outro's is its one produced clip,
// Transition's picks out one of possibly several) — leaving every other
// active output on this node, of any type, untouched. Replaces the old
// per-transition-only removeTransitionConnection: None/Outro's single
// slot and Transition's multi-slot list are the same kind of thing now
// (one entry in `outputs`), so removing one of either is the same
// operation. What a hover-✕ on one specific line (or unchecking one
// candidate) calls, instead of the blanket unwireOutput.
export function removeOutput(playlist, songId, type, edgeId) {
  const node = playlistNode(playlist, songId);
  const outputs = nodeOutputs(node);
  const removed = outputs.find(o => o.type === type && o.edgeId === (edgeId || null));
  if (!removed) return playlist;
  const nodes = { ...playlist.nodes };
  nodes[songId] = { startMode: node.startMode, startEdgeId: node.startEdgeId, outputs: outputs.filter(o => o !== removed) };
  const dest = removed.targetId && nodes[removed.targetId];
  // Only clear the destination's shared arrival field if it's still
  // pointing at exactly the entry being removed — some other active
  // output (from this node or another) may have since claimed it, and
  // that claim isn't ours to erase.
  if (dest && dest.startMode === type && dest.startEdgeId === (edgeId || null)) {
    nodes[removed.targetId] = { ...dest, startMode: 'none', startEdgeId: null };
  }
  return { ...playlist, nodes };
}

// The node context menu's "Autoconnect transitions" — wires every REAL
// produced Transition edge already leading out of this song at once,
// instead of dragging each one in by hand. Deliberately narrower than
// autoconnecting None/Intro/Outro too: a produced Transition is a
// specific, deliberate pairing between two real songs (there's a real
// audio asset behind it), so wiring "every one that exists" produces a
// meaningful graph shape — you can see exactly what's allowed to play
// after this song. None/Intro/Outro don't pair two songs together the
// same way, so autoconnecting those instead would just produce an
// arbitrary chain with no real information in it, indistinguishable from
// a random shuffle — not offered here on purpose.
export function autoconnectNodeTransitions(visibleEdges, playlist, songId) {
  let next = playlist;
  visibleEdges.filter(e => e.type === 'transition' && e.l === songId).forEach(e => {
    next = addTransitionConnection(next, songId, e.r, e.id);
  });
  return next;
}
// The canvas context menu's "Autoconnect all transitions" — the same
// thing, for every song currently on the graph.
export function autoconnectFullGraph(visibleEdges, playlist, songIds) {
  let next = playlist;
  songIds.forEach(id => { next = autoconnectNodeTransitions(visibleEdges, next, id); });
  return next;
}

// The node context menu's "Disconnect all wires" — clears every wire that
// touches songId in one action: its own outgoing wire(s) of every active
// type, whichever other songs (there can be more than one now, across
// any mix of types) point their own output at songId, and Start Set's
// wire if that's what points here. Only the specific output entries that
// actually targeted songId are removed from each other node — any of its
// own other active outputs, of any type, are left alone.
export function disconnectAllWires(playlist, songId) {
  let next = unwireOutput(playlist, songId);
  Object.keys(next.nodes).forEach(id => {
    nodeOutputs(next.nodes[id]).filter(o => o.targetId === songId).forEach(o => { next = removeOutput(next, id, o.type, o.edgeId); });
  });
  if (next.startSongId === songId) next = unwireStart(next);
  return next;
}

// Switches which produced edge one specific active output entry is
// using, without touching startMode/targetId or any other active
// output on this node — the row stays put, only the candidate under it
// changes. Identified by {type, oldEdgeId} rather than just `type` since
// a node can now carry several Transition entries at once (one per
// destination) — None has no real edgeId (always null, and has no
// candidates to switch between in the first place), Outro and each
// Transition destination each pick their variant independently. A
// Transition's edge is picked on the output side only (the same "one
// direction of truth" as wireConnection), so switching it also updates
// the destination's mirrored startEdgeId — but only if that destination
// hadn't already been reclaimed by some other active output since (same
// "don't erase a claim that isn't ours" rule as removeOutput).
export function setEndVariant(playlist, songId, type, oldEdgeId, newEdgeId) {
  const node = playlistNode(playlist, songId);
  const outputs = nodeOutputs(node);
  const idx = outputs.findIndex(o => o.type === type && o.edgeId === oldEdgeId);
  if (idx === -1) return playlist;
  const target = outputs[idx].targetId;
  const nodes = {
    ...playlist.nodes,
    [songId]: { startMode: node.startMode, startEdgeId: node.startEdgeId, outputs: outputs.map((o, i) => (i === idx ? { ...o, edgeId: newEdgeId } : o)) },
  };
  const dest = target && nodes[target];
  if (dest && dest.startMode === type && dest.startEdgeId === oldEdgeId) {
    nodes[target] = { ...dest, startEdgeId: newEdgeId };
  }
  return { ...playlist, nodes };
}
export function setStartVariant(playlist, songId, edgeId) {
  const node = playlistNode(playlist, songId);
  return { ...playlist, nodes: { ...playlist.nodes, [songId]: { ...node, startEdgeId: edgeId } } };
}

// Drops every reference to songId — both its own entry and any other
// node's connection pointing at it — so deleting a song can never leave a
// playlist quietly wired to something that no longer exists.
export function removeSongFromPlaylist(playlist, songId) {
  const nodes = {};
  for (const id of Object.keys(playlist.nodes)) {
    if (id === songId) continue;
    const node = playlist.nodes[id];
    const outputs = nodeOutputs(node).filter(o => o.targetId !== songId);
    nodes[id] = { startMode: node.startMode, startEdgeId: node.startEdgeId, outputs };
  }
  const wasStart = playlist.startSongId === songId;
  const startSongId = wasStart ? null : playlist.startSongId;
  const startMode = wasStart ? 'none' : playlist.startMode;
  const startEdgeId = wasStart ? null : playlist.startEdgeId;
  return { ...playlist, nodes, startSongId, startMode, startEdgeId };
}

// The tick loop's deterministic auto-continue: what activePlaylist says
// happens after `songId`, expressed as the exact same shape a manual
// Next-list commit already produces — so App.jsx's tick can push it
// through the same commitTransition/commitCutOrOutro path, and the real
// audio engine never needs to know whether a hop came from a click or a
// wired connection.
//
// Two-stage random now that a song can end several different ways at
// once (reported directly, exactly this shape: a song with an active
// None wire to one place AND an active Transition to another,
// simultaneously) — first pick which TYPE fires among whichever are
// actually active, uniformly, then pick a destination within that type
// (only Transition can have more than one candidate there; None/Outro
// each have exactly one, so that second draw is a no-op for them). This
// is a real generalization of the old single-type "pick a Transition
// destination at random" — with only one type ever active, picking a
// type first and then its one destination is exactly the old behavior.
export function playlistNextHop(playlist, songId) {
  const node = playlist.nodes[songId];
  if (!node) return null;
  const outputs = nodeOutputs(node).filter(o => o.targetId);
  if (outputs.length === 0) return null;
  const types = [];
  outputs.forEach(o => { if (!types.includes(o.type)) types.push(o.type); });
  const chosenType = types[Math.floor(Math.random() * types.length)];
  const candidates = outputs.filter(o => o.type === chosenType);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (chosenType === 'transition') {
    return { id: pick.targetId, mode: 'transition', edgeId: pick.edgeId };
  }
  const destNode = playlist.nodes[pick.targetId];
  return {
    id: pick.targetId, mode: 'cut',
    ending: chosenType === 'outro' ? 'outro' : 'cut',
    // The outro clip's own edgeId — so findOutroEdgeFor (audioEngine.js)
    // resolves the specific outro variant actually wired here, not just
    // "the first outro on this song", the moment a song has more than one
    // outro to choose from. The main deck itself always plays to its own
    // full natural duration for an outro (see transitionTriggerElapsed);
    // this edgeId is for finding the right clip and its own clipStartSec,
    // not for an early cue point on the main song.
    edgeId: chosenType === 'outro' ? pick.edgeId : null,
    starting: (destNode && destNode.startMode === 'intro') ? 'intro' : 'cut',
  };
}

// ---------------------------------------------------------------------------
// Persistence. localStorage is always the source of truth for the current
// tab (instant, works offline). When config has Supabase credentials,
// pushRemote/pullRemote best-effort sync a single JSON blob per (anonymous)
// user in the background — see TODO.md for how to turn this on fully
// (anonymous sign-ins need enabling in the Supabase dashboard). Nothing
// about the local-only path below changes when sync is off.
// ---------------------------------------------------------------------------
export const Store = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      console.warn('Eskimo Studio: could not read saved data, starting fresh.', e);
      return null;
    }
  },
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('Eskimo Studio: could not save — storage may be full or disabled.', e);
      return false;
    }
  },
  clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  },
};

// ---------------------------------------------------------------------------
// Optional Supabase sync. Entirely inert until config has SUPABASE_URL and
// SUPABASE_ANON_KEY. Uses anonymous auth so cross-device sync works without
// building a login screen yet — one row per anonymous user in a `library`
// table, RLS-scoped to auth.uid() (see supabase/schema.sql).
// ---------------------------------------------------------------------------
const supaConfigured = !!(APP_CONFIG.SUPABASE_URL && APP_CONFIG.SUPABASE_ANON_KEY);
const supa = supaConfigured ? createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY) : null;

async function ensureSupaUser() {
  if (!supa) return null;
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session && session.user) return session.user;
    const { data, error } = await supa.auth.signInAnonymously();
    if (error) { console.warn('Eskimo Studio: Supabase anonymous sign-in failed (enable it in Auth -> Providers)', error); return null; }
    return data.user;
  } catch (e) {
    console.warn('Eskimo Studio: Supabase auth unreachable', e);
    return null;
  }
}

Store.pullRemote = async function pullRemote() {
  if (!supa) return null;
  const user = await ensureSupaUser();
  if (!user) return null;
  const { data, error } = await supa.from('library').select('data').eq('user_id', user.id).maybeSingle();
  if (error) { console.warn('Eskimo Studio: Supabase load failed', error); return null; }
  return data ? data.data : null;
};
Store.pushRemote = async function pushRemote(data) {
  if (!supa) return;
  const user = await ensureSupaUser();
  if (!user) return;
  const { error } = await supa.from('library').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() });
  if (error) console.warn('Eskimo Studio: Supabase save failed', error);
};
export const isSyncConfigured = supaConfigured;

// ---------------------------------------------------------------------------
// Optional audio upload. Inert until config has UPLOAD_WORKER_URL (see
// worker/upload-worker.js + TODO.md). The file is POSTed straight to your
// deployed Cloudflare Worker, which writes it into R2 via its bucket
// binding and hands back a public URL — no R2 credentials, presigning, or
// AWS SDK ever touch the client. Without a worker configured this just
// returns the file's name/size, exactly like before.
// ---------------------------------------------------------------------------
export const isUploadConfigured = !!APP_CONFIG.UPLOAD_WORKER_URL;

export async function uploadAudioIfConfigured(file) {
  if (!file || !file.name) return { name: file && file.name, size: file && file.size, audioUrl: null };
  const workerUrl = APP_CONFIG.UPLOAD_WORKER_URL;
  // No Cloudflare/R2 worker configured — store the real bytes locally
  // (IndexedDB, see localAudioStore.js) instead of only keeping the file's
  // name/size, so playback, previews, and detection all actually work with
  // zero backend setup, not just once a worker is deployed.
  if (!workerUrl) {
    try {
      const marker = await putLocalAudio(file);
      return { name: file.name, size: file.size, audioUrl: marker };
    } catch (e) {
      console.warn('Eskimo Studio: local audio storage failed, keeping metadata only', e);
      return { name: file.name, size: file.size, audioUrl: null };
    }
  }
  try {
    const res = await fetch(workerUrl + '/upload?filename=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    const { url } = await res.json();
    return { name: file.name, size: file.size, audioUrl: url };
  } catch (e) {
    console.warn('Eskimo Studio: audio upload failed, keeping metadata only', e);
    return { name: file.name, size: file.size, audioUrl: null };
  }
}

// A song's "extra files" — stems, the original project file (.flp/.als/...),
// reference notes, anything a collaborator wants attached beyond the master
// itself, purely so whoever builds the next transition has more to work
// with. Same upload path as the master (worker when configured, IndexedDB
// otherwise via putLocalAudio, which despite its name stores any Blob) —
// deliberately not folded into uploadAudioIfConfigured itself, since that
// function's whole contract is keyed on the specific `audioUrl` field a
// song/edge already has; this one hands back a plain {id, name, size, url}
// entry meant to be pushed onto song.extraFiles.
export async function uploadExtraFileIfPossible(file) {
  if (!file || !file.name) return null;
  const workerUrl = APP_CONFIG.UPLOAD_WORKER_URL;
  if (!workerUrl) {
    try {
      const marker = await putLocalAudio(file);
      return { id: uid('f'), name: file.name, size: file.size, url: marker };
    } catch (e) {
      console.warn('Eskimo Studio: could not store extra file locally', e);
      return null;
    }
  }
  try {
    const res = await fetch(workerUrl + '/upload?filename=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    const { url } = await res.json();
    return { id: uid('f'), name: file.name, size: file.size, url };
  } catch (e) {
    console.warn('Eskimo Studio: extra file upload failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// A lightweight per-browser identity, used only for attribution — "who
// contributed this song/audio piece" on a shared crate. Deliberately not a
// real account system (no login, no password, nothing server-side to get
// wrong): just a display name this browser stamps onto whatever it adds,
// so producer friends dropping songs into a shared crate show up as
// themselves instead of an anonymous blob. Solo/local use never needs this
// at all — a name tag only ever renders when contributedBy is actually set
// (see SongNode/LibraryRow), so leaving this unset costs nothing.
// ---------------------------------------------------------------------------
const PROFILE_NAME_KEY = 'eskimo:profileName';
export function getProfileName() {
  try {
    return (localStorage.getItem(PROFILE_NAME_KEY) || '').trim() || null;
  } catch (e) { return null; }
}
export function setProfileName(name) {
  try {
    const trimmed = (name || '').trim();
    if (trimmed) localStorage.setItem(PROFILE_NAME_KEY, trimmed);
    else localStorage.removeItem(PROFILE_NAME_KEY);
  } catch (e) { /* private-browsing/quota — attribution is best-effort only */ }
}

// Downscales an image file to a small JPEG thumbnail — a raw phone-camera
// photo can run several MB, and a cover art thumbnail never needs to be
// bigger than it'll ever actually be drawn (a few dozen px in the UI).
function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
    img.src = url;
  });
}

// Cover art upload: same worker endpoint as audio when one's configured
// (it doesn't care about content type). Without a worker, a cover used to
// fall back to a raw base64 data: URL saved straight into localStorage —
// fine for a genuinely small thumbnail, but a real phone photo can run
// several MB, and localStorage's ~5-10MB per-origin quota is shared with
// literally everything else the app saves (songs, edges, the whole active
// playlist). One large cover was enough to blow that quota — Store.save
// caught the resulting error and only logged a console warning, so every
// save silently failed afterward and a reload lost the entire library, not
// just the cover. Downscaling to a thumbnail first and storing the actual
// bytes in IndexedDB (same no-backend path as song audio, see
// localAudioStore.js) fixes both: a `local:` marker is a few dozen bytes
// in localStorage regardless of how big the original photo was.
export async function uploadCoverIfPossible(file) {
  if (!file) return null;
  const workerUrl = APP_CONFIG.UPLOAD_WORKER_URL;
  if (workerUrl) {
    try {
      const res = await fetch(workerUrl + '/upload?filename=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error('upload failed: ' + res.status);
      const { url } = await res.json();
      return url;
    } catch (e) {
      console.warn('Eskimo Studio: cover upload failed, falling back to local storage', e);
    }
  }
  try {
    const thumb = await downscaleImage(file, 480, 0.85);
    return await putLocalAudio(thumb);
  } catch (e) {
    console.warn('Eskimo Studio: local cover storage failed', e);
    return null;
  }
}

// The one and only "no saved state yet" starting point — a genuinely empty
// library. Nothing is seeded; the person adds their own songs and audio.
export function freshState() { return { songs: {}, edges: [], session: emptySession(), venueName: '', playlists: [] }; }

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------
export function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// A new song's canvas position used to be a pure formula
// (`60 + (existingCount*47) % 1180`) with no awareness of where songs
// already placed actually sit — for a large-enough library the modulo
// wraps and a new song can land exactly on top of an existing one.
// Spirals outward from the seed point in NODE_W/NODE_H-sized steps until
// it finds a spot that doesn't overlap anything already placed, so a
// growing library never silently stacks nodes. `positions` is a plain
// {id: {x,y}} map (whatever's already on the canvas); NODE_W/NODE_H come
// from graphLayout.js's own constants so this always matches the node's
// real rendered footprint.
export function findFreePosition(positions, seedX, seedY, nodeW, nodeH) {
  const existing = Object.values(positions || {});
  const overlaps = (x, y) => existing.some(p => Math.abs(p.x - x) < nodeW && Math.abs(p.y - y) < nodeH);
  if (!overlaps(seedX, seedY)) return { x: seedX, y: seedY };
  const stepX = nodeW + 24, stepY = nodeH + 24;
  for (let ring = 1; ring <= 40; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // only the ring's own perimeter
        const x = seedX + dx * stepX, y = seedY + dy * stepY;
        if (!overlaps(x, y)) return { x, y };
      }
    }
  }
  return { x: seedX, y: seedY }; // exhausted a generous search radius — fall back rather than loop forever
}
export function fmtTime(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); const sec = s % 60; return m + ':' + (sec < 10 ? '0' : '') + sec; }
export function fmtSignedBpm(n) { if (n == null) return ''; return (n > 0 ? '+' : '') + n + ' BPM'; }
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Deterministic mock track length until real audio analysis (see TODO.md)
// can read the actual duration off the file. 150s-260s.
export function mockDuration(seed) { return 150 + (hashString(seed || 'x') % 110); }

// A short, deterministic pseudo-cue-point pair derived from two song ids, so the
// "detected" cue markers in Add Audio vary per pair instead of always looking identical.
// A long intro/outro variant is really an alternate mix of the song
// (rendered with the original still attached, per the upload workflow) that
// can start diverging from the plain master well before the clip's own
// edge — "consuming" part of the song's own timeline a transition's cue
// point might sit inside. Only one ending/start method is ever active on a
// song at a time (endMode/startMode) so this can't silently corrupt a live
// wire the way a genuine mid-set collision would; the value here is
// surfacing the conflict at build time (Add Audio, Library) so whoever's
// producing the graph can see it before picking this variant as the live
// choice, not filtering a socket's dropdown that doesn't cross-list outro
// and transition candidates together in the first place.
export function occludedTransitions(edges, clipEdge) {
  if (!clipEdge) return [];
  if (clipEdge.type === 'outro') {
    if (clipEdge.outSeconds == null) return [];
    return edges.filter(e => e.type === 'transition' && e.l === clipEdge.l && e.outSeconds != null && e.outSeconds > clipEdge.outSeconds);
  }
  if (clipEdge.type === 'intro') {
    if (clipEdge.inSeconds == null) return [];
    return edges.filter(e => e.type === 'transition' && e.r === clipEdge.r && e.inSeconds != null && e.inSeconds < clipEdge.inSeconds);
  }
  return [];
}


// ---------------------------------------------------------------------------
// Song / edge helpers shared by multiple pages
// ---------------------------------------------------------------------------
export function inOutCounts(edges, songId) {
  const inCount = edges.filter(e => e.verified && e.type !== 'outro' && e.r === songId).length;
  const outCount = edges.filter(e => e.verified && e.type !== 'intro' && e.l === songId).length;
  return { inCount, outCount };
}
export function getVisibleEdges(edges) { return edges.filter(e => e.verified); }

// Every produced transition off `fromId` — each one its own candidate (a
// song with two transitions built to it shows as two, not one grouped
// item), used both for the availability check below and for building a
// manual Next commit.
export function transitionCandidates(visibleEdges, fromId, excludeIds) {
  return visibleEdges.filter(e => e.type === 'transition' && e.l === fromId && !excludeIds.has(e.r));
}

// ---------------------------------------------------------------------------
// Graph socket helpers (the playlist editor — see TODO.md). Every song
// shows the same fixed three rows per side (None/Intro/Transition on the
// left, None/Outro/Transition on the right) — a variable row count read as
// visual noise and made it harder to scan several nodes at a glance.
// *Available maps say which of those a song can actually use (a produced
// edge exists); the type still appears when unavailable, just greyed out
// and non-interactive, the same way Blender leaves an unwired socket in
// place rather than removing it.
// ---------------------------------------------------------------------------
// Plural — every produced intro/outro fragment for this song, not just
// one. A song can have several (e.g. a short vs. long intro edit); the
// socket itself stays a single fixed "Intro"/"Outro" row regardless of
// how many exist, with a dropdown next to it when there's more than one
// to pick from (see setStartVariant/setEndVariant above).
export function introEdgesFor(visibleEdges, songId) { return visibleEdges.filter(e => e.type === 'intro' && e.r === songId); }
export function outroEdgesFor(visibleEdges, songId) { return visibleEdges.filter(e => e.type === 'outro' && e.l === songId); }
export function introEdgeFor(visibleEdges, songId) { return introEdgesFor(visibleEdges, songId)[0] || null; }
export function outroEdgeFor(visibleEdges, songId) { return outroEdgesFor(visibleEdges, songId)[0] || null; }
export function transitionEdgesTo(visibleEdges, songId) { return visibleEdges.filter(e => e.type === 'transition' && e.r === songId); }
export function transitionEdgesBetween(visibleEdges, fromId, toId) {
  return visibleEdges.filter(e => e.type === 'transition' && e.l === fromId && e.r === toId);
}
export const LEFT_SOCKET_TYPES = ['none', 'intro', 'transition'];
export const RIGHT_SOCKET_TYPES = ['none', 'outro', 'transition'];
// Intro/Outro are always connectable, whether or not a produced fragment
// exists yet for this specific song — a wire there states the DJ's intent
// ("this song starts/ends this way"), which is meaningful on its own (see
// wireStart's own comment on the same point) even before real audio is
// attached, and gating it on "already produced" made it flatly impossible
// to wire an outro into a song that doesn't have a produced intro yet —
// reported directly as a bug, since there's nothing semantically wrong
// with that pairing (the destination just plays a cold cut for now, and
// silently upgrades to using the real intro once one exists). Transition
// stays gated: unlike None/Intro/Outro, a transition IS a specific
// produced edge — with none built between two particular songs there's
// nothing for that wire to reference at all.
export function leftSocketAvailability(visibleEdges, songId) {
  return {
    none: true,
    intro: true,
    transition: transitionEdgesTo(visibleEdges, songId).length > 0,
  };
}
export function rightSocketAvailability(visibleEdges, songId) {
  return {
    none: true,
    outro: true,
    transition: transitionCandidates(visibleEdges, songId, new Set()).length > 0,
  };
}

// Autoplay's picking policy: prefer a random *built* transition out of the
// current song. In transition-only mode, a dead end (no outgoing
// transition) means true seamless play genuinely can't continue — return
// null rather than fake it. Outside that mode, a dead end just means "the
// song runs out" — cut cold to a random other song and keep the playlist
// going (near-seamless, not seamless, since that hop has no built audio).
export function pickAutoplayNext(songs, visibleEdges, currentId, transitionOnly) {
  const transitionEdges = visibleEdges.filter(e => e.type === 'transition' && e.l === currentId);
  if (transitionEdges.length > 0) {
    const pick = transitionEdges[Math.floor(Math.random() * transitionEdges.length)];
    return { id: pick.r, mode: 'transition' };
  }
  if (transitionOnly) return null;
  const others = Object.keys(songs).filter(id => id !== currentId);
  const pool = others.length > 0 ? others : Object.keys(songs);
  if (pool.length === 0) return null;
  return { id: pool[Math.floor(Math.random() * pool.length)], mode: 'cut' };
}

// The single "what happens when it's time to move on" rule — used both by
// the set-clock's automatic tick (timeLeft hits 0) and by a manual "Next
// song" button, so a click and a natural countdown always do the same
// thing rather than two hand-maintained copies of this branching.
// How many seconds before the actual handoff the Playing card starts
// showing "mixing into" the next song, Spotify-crossfade-style.
export const CROSSFADE_LOOKAHEAD_SEC = 8;

// Now Playing should hand off exactly at the committed transition's real
// cue point (edge.outSeconds) when one was built and chosen — not after
// the whole song plays out. Falls back to the full duration for a Cut, an
// outro ending, or a transition/outro edge that doesn't carry a cue point
// yet.
//
// An outro's own real splice point (edge.outSeconds) is exactly where the
// clip's own new material begins — the same instant edge.clipStartSec
// marks on the CLIP's own timeline (both come out of one
// detectSpliceForKnownSongs scan against the same audio, see
// audioDetect.js — not two independently-measured points that could
// disagree). Cutting the main deck there and starting the clip at
// clipStartSec splices with no gap and no duplicated material — the same
// mechanic a Transition already uses, just against an outro's own cue
// instead of a transition edge's. Falls back to the full song duration
// only when there's no confident detected outSeconds to cut at (no
// reference master to detect against, or detection genuinely found
// nothing) — same graceful "play the whole clip" degradation used
// wherever else a detected value might be missing.
export function transitionTriggerElapsed(queueHead, edges, nowSongDurationSec) {
  if (queueHead && queueHead.mode === 'transition' && queueHead.edgeId) {
    const edge = edges.find(e => e.id === queueHead.edgeId);
    if (edge && edge.outSeconds != null) return edge.outSeconds;
  }
  // playlistNextHop (the only place that ever constructs `ending: 'outro'`)
  // always sets `edgeId` to that same outro's own id right alongside it —
  // never null — so a plain id lookup is enough here, same as the
  // Transition branch above; no separate "or scan for any outro off this
  // song" fallback needed.
  if (queueHead && queueHead.mode === 'cut' && queueHead.ending === 'outro' && queueHead.edgeId) {
    const edge = edges.find(e => e.id === queueHead.edgeId);
    if (edge && edge.outSeconds != null) return edge.outSeconds;
  }
  return nowSongDurationSec;
}

export function advanceSession(prev, songs, visibleEdges) {
  if (!prev.nowPlayingId) return prev;
  // Every real hop — however it happened (wired, manually queued, a
  // forced-cut skip) — pushes onto `history`, so Back always has
  // somewhere to return to regardless of which path got you here. Not
  // pushed on the END branches below since nowPlayingId doesn't change.
  const history = [...prev.history, prev.nowPlayingId].slice(-50);
  const head = prev.queue[0];
  if (head) {
    if (head.id === END) return { ...prev, isPlaying: false, setEnded: true, queue: [], timeLeft: 0 };
    const nextSong = songs[head.id];
    return { ...prev, nowPlayingId: head.id, queue: prev.queue.slice(1), timeLeft: nextSong ? nextSong.durationSec : 210, history };
  }
  if (prev.autoplay) {
    const pick = pickAutoplayNext(songs, visibleEdges, prev.nowPlayingId, prev.transitionOnly);
    if (pick) {
      const nextSong = songs[pick.id];
      return {
        ...prev, nowPlayingId: pick.id, timeLeft: nextSong ? nextSong.durationSec : 210, history,
        autoHistory: [...prev.autoHistory, { id: pick.id, mode: pick.mode }].slice(-40),
      };
    }
  }
  return { ...prev, isPlaying: false, setEnded: true, timeLeft: 0 };
}

// Removing one specific hop from the middle of the queue, keeping whatever
// was planned after it — the queue bar's "remove from here on" already
// truncates the tail, but that's not the same as skipping a single planned
// song without losing the rest of the plan. The hop right after the
// removed one no longer starts from the same song, so it's recomputed
// against the new predecessor: a built transition if one exists between
// them, otherwise a cut (matching what choosing that pair manually would
// produce). Whatever was queued for that hop's own destination edge choice
// is not preserved — there's no UI yet to reconsider it, so it defaults
// like a fresh pick would.
export function removeQueueItem(queue, index, nowPlayingId, visibleEdges) {
  if (index < 0 || index >= queue.length) return queue;
  const prevId = index === 0 ? nowPlayingId : queue[index - 1].id;
  const rest = [...queue.slice(0, index), ...queue.slice(index + 1)];
  const nextItem = rest[index];
  if (!nextItem || nextItem.id === END) return rest;
  const transitionEdge = visibleEdges.find(e => e.type === 'transition' && e.l === prevId && e.r === nextItem.id);
  rest[index] = transitionEdge
    ? { id: nextItem.id, mode: 'transition', edgeId: transitionEdge.id }
    : { id: nextItem.id, mode: 'cut', ending: 'cut', starting: 'cut' };
  return rest;
}

// Removing a song must not leave dangling edges pointing at it.
export function removeSongCascade(songs, edges, songId) {
  const nextSongs = { ...songs };
  delete nextSongs[songId];
  const nextEdges = edges.filter(e => e.l !== songId && e.r !== songId);
  return { songs: nextSongs, edges: nextEdges };
}

// Display labels only — the underlying mode/ending/starting values stay
// 'cut' internally (renaming those would ripple through every hop object
// in session/queue state for no real benefit); "cut" read as a leftover
// pre-rename word here specifically because these two feed user-visible
// text (the player bar's hop-type readout, hopSummary below) and never
// got the same None rename the socket labels themselves already had.
export function hopEndingLabel(e) { return e === 'outro' ? 'outro' : 'none'; }
export function hopStartingLabel(s) { return s === 'intro' ? 'intro' : 'none'; }
export function hopSummary(hop) {
  if (hop.id === END) return hopEndingLabel(hop.ending);
  if (hop.mode === 'transition') return 'transition';
  return hopEndingLabel(hop.ending) + ' → ' + hopStartingLabel(hop.starting);
}
// width-only weighting now that every edge/segment renders solid (no dashing):
// built transitions and fully-fragmented hops draw thicker than a raw cut.
export function hopWidth(hop, isEndHop) {
  if (isEndHop) return hop.ending === 'outro' ? 3.5 : 2;
  if (hop.mode === 'transition') return 4;
  const eOk = hop.ending === 'outro', sOk = hop.starting === 'intro';
  return (eOk && sOk) ? 3.5 : (eOk || sOk) ? 3 : 2;
}

// ---------------------------------------------------------------------------
// Library list sort/filter
// ---------------------------------------------------------------------------
export function libraryRows(songs, edges, search, sortKey, sortDir) {
  const q = search.trim().toLowerCase();
  let rows = Object.keys(songs).map(id => {
    const s = songs[id];
    const { inCount, outCount } = inOutCounts(edges, id);
    return { id, title: s.title, artist: s.artist, bpmNum: s.bpm, bpm: s.bpm + ' BPM', key: s.key, inCount, outCount, isDeadEnd: outCount === 0 };
  });
  if (q) rows = rows.filter(r => r.title.toLowerCase().includes(q) || r.artist.toLowerCase().includes(q));
  // 'added' sorts by id — uid() embeds a base36 Date.now() prefix, so a
  // plain string comparison of ids already reflects creation order with
  // no separate createdAt field needed. 'deadend' sorts dead ends first
  // (false < true, so this pair inverts the boolean to put `true` first).
  const val = (r) => (
    sortKey === 'bpm' ? r.bpmNum
    : sortKey === 'artist' ? r.artist.toLowerCase()
    : sortKey === 'key' ? r.key
    : sortKey === 'added' ? r.id
    : sortKey === 'deadend' ? !r.isDeadEnd
    : r.title.toLowerCase()
  );
  rows.sort((a, b) => { const av = val(a), bv = val(b); const c = av < bv ? -1 : av > bv ? 1 : 0; return sortDir === 'asc' ? c : -c; });
  return rows;
}
