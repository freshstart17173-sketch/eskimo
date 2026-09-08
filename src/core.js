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

export function sampleSongsForTests() {
  // The Life of Pi'erre 4 — Pi'erre Bourne. All 16 tracks, transitioning
  // into each other in tracklist order (see sampleEdgesForTests).
  const pierre4 = [
    ['Poof', 183], ['Try Again', 147], ['Feds', 188], ['Be Mine', 258],
    ['Ballad', 181], ['Routine', 166], ['Lovers', 184], ['How High', 250],
    ['Romeo Must Die', 161], ['Racer', 295], ['Stereotypes', 188], ['Doublemint', 188],
    ['Horoscopes', 147], ['Juice', 143], ['Guillotine', 180], ['Speed Dial', 151],
  ];
  // Yeezus — Kanye West. All 10 tracks, placed on the canvas unwired (no
  // transitions specified between them) — a second library's worth of
  // songs to wire up by hand or with Autoconnect.
  const yeezus = [
    ['On Sight', 156], ['Black Skinhead', 188], ['I Am a God', 231], ['New Slaves', 256],
    ['Hold My Liquor', 326], ['I’m In It', 234], ['Blood on the Leaves', 360], ['Guilt Trip', 243],
    ['Send It Up', 178], ['Bound 2', 229],
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
  return songs;
}
export function sampleEdgesForTests() {
  const edges = [
    { id: 'e-p-intro', type: 'intro', r: 'p1', verified: true },
    { id: 'e-p-outro', type: 'outro', l: 'p16', verified: true },
  ];
  for (let i = 1; i < 16; i++) {
    edges.push({ id: 'e-p' + i + '-' + (i + 1), type: 'transition', l: 'p' + i, r: 'p' + (i + 1), verified: true });
  }
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
  return playlist.nodes[songId] || { startMode: 'none', startEdgeId: null, endMode: 'none', endEdgeId: null, nextSongId: null, transitions: [] };
}

// Wires one full connection — a Transition drag (endEdgeId names the
// produced edge, toId is just edge.r) and a None/Outro/Intro drag (toId is
// whatever node the DJ dropped on, endEdgeId is the outro edge if any, the
// destination's startEdgeId is its intro edge if any) both resolve through
// this same function, always updating both ends together so the playlist
// can never end up with a dangling half-wire only one side knows about.
export function wireConnection(playlist, fromId, toId, endMode, endEdgeId, startMode, startEdgeId) {
  const nodes = { ...playlist.nodes };
  nodes[fromId] = { ...playlistNode(playlist, fromId), endMode, endEdgeId: endEdgeId || null, nextSongId: toId };
  nodes[toId] = { ...playlistNode(playlist, toId), startMode, startEdgeId: startEdgeId || null };
  return { ...playlist, nodes };
}

// Disconnects songId's ENTIRE outgoing wire — every simultaneous
// transition it carries (see addTransitionConnection below) included, not
// just one — clearing whatever it pointed to back to 'none' rather than
// leaving that node silently claiming a connection that's no longer
// there. Use removeTransitionConnection instead when only one specific
// transition among several should go.
export function unwireOutput(playlist, songId) {
  const node = playlistNode(playlist, songId);
  const hasTransitions = node.endMode === 'transition' && node.transitions && node.transitions.length > 0;
  if (!node.nextSongId && !hasTransitions) return playlist;
  const nodes = { ...playlist.nodes };
  const destIds = hasTransitions ? node.transitions.map(t => t.targetId) : (node.nextSongId ? [node.nextSongId] : []);
  nodes[songId] = { ...node, endMode: 'none', endEdgeId: null, nextSongId: null, transitions: [] };
  destIds.forEach(destId => {
    if (nodes[destId]) nodes[destId] = { ...nodes[destId], startMode: 'none', startEdgeId: null };
  });
  return { ...playlist, nodes };
}

// A song can carry more than one simultaneous Transition now — dragging a
// second one in adds to the set rather than silently replacing the first
// (this is also what "Autoconnect" below wires up in bulk). Which one
// actually plays is picked at random each time (playlistNextHop) until a
// real weighting system exists; the graph itself still shows every wired
// candidate as a solid active line, so nothing about what's *possible* is
// hidden the way a blind shuffle would. A no-op if this exact edge is
// already wired.
export function addTransitionConnection(playlist, fromId, toId, edgeId) {
  const node = playlistNode(playlist, fromId);
  const existing = node.endMode === 'transition' ? (node.transitions || []) : [];
  if (existing.some(t => t.edgeId === edgeId)) return playlist;
  const transitions = [...existing, { edgeId, targetId: toId }];
  const nodes = { ...playlist.nodes };
  nodes[fromId] = { ...node, endMode: 'transition', endEdgeId: edgeId, nextSongId: toId, transitions };
  // Input stays single-choice (v1) — if more than one song ends up wiring a
  // transition into the same destination, whichever wrote last wins here,
  // same as any other pre-existing wiring collision on a shared socket.
  nodes[toId] = { ...playlistNode(playlist, toId), startMode: 'transition', startEdgeId: edgeId };
  return { ...playlist, nodes };
}

// Removes exactly one transition from a song's set, leaving any others it
// carries untouched — the counterpart to addTransitionConnection, and
// what a hover-✕ on one specific transition edge (or unchecking one
// candidate) should call instead of the blanket unwireOutput.
export function removeTransitionConnection(playlist, fromId, edgeId) {
  const node = playlistNode(playlist, fromId);
  if (node.endMode !== 'transition') return playlist;
  const current = node.transitions || (node.endEdgeId ? [{ edgeId: node.endEdgeId, targetId: node.nextSongId }] : []);
  const removed = current.find(t => t.edgeId === edgeId);
  if (!removed) return playlist;
  const transitions = current.filter(t => t.edgeId !== edgeId);
  const nodes = { ...playlist.nodes };
  nodes[fromId] = transitions.length === 0
    ? { ...node, endMode: 'none', endEdgeId: null, nextSongId: null, transitions: [] }
    : { ...node, endEdgeId: transitions[0].edgeId, nextSongId: transitions[0].targetId, transitions };
  const dest = nodes[removed.targetId];
  if (dest && dest.startEdgeId === edgeId) nodes[removed.targetId] = { ...dest, startMode: 'none', startEdgeId: null };
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
// touches songId in one action: its own outgoing wire(s), whichever other
// songs (there can be more than one now, if they each wired a different
// Transition here) point their own output at songId, and Start Set's wire
// if that's what points here. A non-transition source pointing at songId
// gets its whole output unwired (it only ever has the one); a transition
// source only loses the specific transition(s) that targeted songId,
// leaving any others it carries alone.
export function disconnectAllWires(playlist, songId) {
  let next = unwireOutput(playlist, songId);
  Object.keys(next.nodes).forEach(id => {
    const n = next.nodes[id];
    if (n.endMode === 'transition' && n.transitions && n.transitions.length) {
      n.transitions.filter(t => t.targetId === songId).forEach(t => { next = removeTransitionConnection(next, id, t.edgeId); });
    } else if (n.nextSongId === songId) {
      next = unwireOutput(next, id);
    }
  });
  if (next.startSongId === songId) next = unwireStart(next);
  return next;
}

// Switches which produced edge a socket that's already active is using,
// without touching endMode/startMode/nextSongId — the "Transition" (or
// Intro/Outro) row stays put, only the specific candidate underneath it
// changes. A Transition's edge is picked on the output side only (the
// same "one direction of truth" as wireConnection), so switching it also
// updates the destination's mirrored startEdgeId; Intro/Outro are each a
// single song's own fragment choice with no other side to keep in sync.
export function setEndVariant(playlist, songId, edgeId) {
  const node = playlistNode(playlist, songId);
  const nodes = { ...playlist.nodes, [songId]: { ...node, endEdgeId: edgeId } };
  if (node.endMode === 'transition' && node.nextSongId) {
    nodes[node.nextSongId] = { ...playlistNode(playlist, node.nextSongId), startEdgeId: edgeId };
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
    if (node.endMode === 'transition' && node.transitions && node.transitions.length) {
      const transitions = node.transitions.filter(t => t.targetId !== songId);
      nodes[id] = transitions.length === node.transitions.length ? node
        : transitions.length === 0 ? { ...node, endMode: 'none', endEdgeId: null, nextSongId: null, transitions: [] }
        : { ...node, endEdgeId: transitions[0].edgeId, nextSongId: transitions[0].targetId, transitions };
    } else {
      nodes[id] = node.nextSongId === songId ? { ...node, endMode: 'none', endEdgeId: null, nextSongId: null } : node;
    }
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
export function playlistNextHop(playlist, songId) {
  const node = playlist.nodes[songId];
  if (!node || !node.nextSongId) return null;
  if (node.endMode === 'transition') {
    // A song can carry more than one simultaneous Transition (see
    // addTransitionConnection) — picked uniformly at random each time,
    // until a real weighting system exists. Falls back to the singular
    // endEdgeId/nextSongId for a playlist wired before this existed, so
    // nothing already saved breaks.
    const options = (node.transitions && node.transitions.length) ? node.transitions
      : (node.endEdgeId ? [{ edgeId: node.endEdgeId, targetId: node.nextSongId }] : []);
    if (options.length === 0) return null;
    const pick = options[Math.floor(Math.random() * options.length)];
    return { id: pick.targetId, mode: 'transition', edgeId: pick.edgeId };
  }
  const destNode = playlist.nodes[node.nextSongId];
  return {
    id: node.nextSongId, mode: 'cut',
    ending: node.endMode === 'outro' ? 'outro' : 'cut',
    // The outro clip's own edgeId, so transitionTriggerElapsed (below) can
    // hand off at *its* real cue point the same way a transition already
    // does — without this, an outro-ending hop had no way to find its own
    // outSeconds and fell all the way back to the full song duration,
    // meaning the main song played out completely before the outro clip
    // started from its own beginning, which (per the "render with the
    // original still attached" upload convention) duplicates whatever tail
    // portion the outro clip overlaps with.
    edgeId: node.endMode === 'outro' ? node.endEdgeId : null,
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

export function pseudoCuePoints(leftId, rightId) {
  const h = hashString((leftId || '_') + '|' + (rightId || '_'));
  const out = 90 + (h % 90); // 90s..180s "out" point on the left song
  const inp = 3 + ((h >> 5) % 20); // 3s..23s "in" point on the right song
  return { outSeconds: out, inSeconds: inp };
}

// Stands in for real audio-fingerprint detection: turns a filename+size into a
// deterministic pick of one or two songs from the library, so "uploading" a file
// consistently "detects" the same match every time you try it.
export function pickDetectedSongs(songIds, seedText, count) {
  const h = hashString(seedText || 'x');
  const picks = [];
  for (let i = 0; i < count; i++) {
    if (songIds.length === 0) break;
    const idx = (h + i * 2654435761) % songIds.length;
    const id = songIds[Math.abs(idx) % songIds.length];
    if (!picks.includes(id)) picks.push(id);
  }
  let j = 0;
  while (picks.length < count && j < songIds.length) {
    if (!picks.includes(songIds[j])) picks.push(songIds[j]);
    j++;
  }
  return picks;
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
// the whole song plays out. Falls back to the full duration for a Cut or a
// transition/outro edge that doesn't carry a cue point yet.
//
// An outro ending needs exactly the same early handoff a transition
// already gets, for exactly the same reason: the outro clip is uploaded
// with the song's own tail still attached (so detection can splice it),
// which means the clip's own t=0 already corresponds to `outSeconds` in
// the song's timeline. Letting the main song play its full recorded
// duration first — the old behavior here, since only `mode === 'transition'`
// was ever checked — meant the outro clip then started over from its own
// beginning, replaying whatever tail material it overlaps with a second
// time before ever reaching its actually-new content.
export function transitionTriggerElapsed(queueHead, edges, nowSongDurationSec) {
  if (queueHead && queueHead.mode === 'transition' && queueHead.edgeId) {
    const edge = edges.find(e => e.id === queueHead.edgeId);
    if (edge && edge.outSeconds != null) return edge.outSeconds;
  }
  if (queueHead && queueHead.ending === 'outro' && queueHead.edgeId) {
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
  const val = (r) => sortKey === 'bpm' ? r.bpmNum : sortKey === 'artist' ? r.artist.toLowerCase() : sortKey === 'key' ? r.key : r.title.toLowerCase();
  rows.sort((a, b) => { const av = val(a), bv = val(b); const c = av < bv ? -1 : av > bv ? 1 : 0; return sortDir === 'asc' ? c : -c; });
  return rows;
}
