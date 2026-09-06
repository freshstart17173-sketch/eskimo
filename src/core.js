// =====================================================================================
// Eskimo Studio — core data model & pure logic (no React here — plain JS, easy to unit
// test). A song is flat (no version sub-objects) — a remix is just another song.
// =====================================================================================
import { createClient } from '@supabase/supabase-js';
import { APP_CONFIG } from './config.js';

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
export function sampleSongsForTests() {
  return {
    hd: { id: 'hd', title: 'Horizon Drift', artist: 'Nomi Sato', x: 40, y: 360, bpm: 124, key: 'A min', durationSec: 214 },
    cb: { id: 'cb', title: 'Concrete Bloom', artist: 'Ledger', x: 320, y: 300, bpm: 128, key: 'F# min', durationSec: 198 },
    gs: { id: 'gs', title: 'Glass Static', artist: 'Rook & Vale', x: 620, y: 440, bpm: 126, key: 'G min', durationSec: 231 },
    lr: { id: 'lr', title: 'Late Return', artist: 'Nomi Sato', x: 900, y: 480, bpm: 120, key: 'D min', durationSec: 205 },
    wr: { id: 'wr', title: 'Wire & Rust', artist: 'Rook & Vale', x: 900, y: 600, bpm: 129, key: 'D min', durationSec: 187 },
  };
}
export function sampleEdgesForTests() {
  return [
    { id: 'e1', type: 'intro', r: 'hd', verified: true },
    { id: 'e2', type: 'transition', l: 'hd', r: 'cb', verified: true },
    { id: 'e4', type: 'transition', l: 'cb', r: 'gs', verified: true },
    { id: 'e5', type: 'outro', l: 'cb', verified: true },
    { id: 'e6', type: 'transition', l: 'gs', r: 'lr', verified: true },
    { id: 'e13', type: 'transition', l: 'gs', r: 'wr', verified: true },
    { id: 'e14', type: 'outro', l: 'gs', verified: true },
  ];
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
    activePlaylist: emptyActivePlaylist(), // the graph's live, always-editable wiring — see TODO.md
  };
}

// The graph-as-playlist-editor's live wiring (TODO.md has the full spec).
// A sparse map keyed by songId — most songs in a library won't participate.
// One direction of truth: a connection is always written from its source's
// `nextSongId`/`endMode`/`endEdgeId`, and the destination's `startMode`/
// `startEdgeId` are kept in sync by the same write, never set independently.
export function emptyActivePlaylist() { return { id: null, name: '', nodes: {} }; }

function playlistNode(playlist, songId) {
  return playlist.nodes[songId] || { startMode: 'none', startEdgeId: null, endMode: 'none', endEdgeId: null, nextSongId: null };
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

// Disconnects songId's outgoing wire, clearing whatever it pointed to back
// to 'none' rather than leaving that node silently claiming a connection
// that's no longer there.
export function unwireOutput(playlist, songId) {
  const node = playlistNode(playlist, songId);
  if (!node.nextSongId) return playlist;
  const nodes = { ...playlist.nodes };
  const destId = node.nextSongId;
  nodes[songId] = { ...node, endMode: 'none', endEdgeId: null, nextSongId: null };
  if (nodes[destId]) nodes[destId] = { ...nodes[destId], startMode: 'none', startEdgeId: null };
  return { ...playlist, nodes };
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
    nodes[id] = node.nextSongId === songId ? { ...node, endMode: 'none', endEdgeId: null, nextSongId: null } : node;
  }
  return { ...playlist, nodes };
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
  if (node.endMode === 'transition' && node.endEdgeId) {
    return { id: node.nextSongId, mode: 'transition', edgeId: node.endEdgeId };
  }
  const destNode = playlist.nodes[node.nextSongId];
  return {
    id: node.nextSongId, mode: 'cut',
    ending: node.endMode === 'outro' ? 'outro' : 'cut',
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
  const workerUrl = APP_CONFIG.UPLOAD_WORKER_URL;
  if (!workerUrl || !file || !file.name) return { name: file && file.name, size: file && file.size, audioUrl: null };
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

// Cover art upload: same worker endpoint as audio when one's configured
// (it doesn't care about content type), but — unlike a full audio master —
// a small cover thumbnail is cheap enough to fall back to storing directly
// as a data URL when there's no worker, so real cover art works with zero
// backend setup instead of staying a placeholder until R2 is wired up.
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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

// The two candidate lists the manual Next picker can show, gated by the
// Playing card's single ending-mode toggle — Transition mode offers each
// *produced transition* as its own candidate (a song with two transitions
// built to it shows as two candidates, not one grouped item); Cut/Outro
// mode offers every other song in the library, since a hard cut or an
// outro can reach anywhere, not just what's been produced. Shared between
// building the real Next list and previewing what a hover would lead to.
export function transitionCandidates(visibleEdges, fromId, excludeIds) {
  return visibleEdges.filter(e => e.type === 'transition' && e.l === fromId && !excludeIds.has(e.r));
}
export function cutCandidates(songs, excludeIds) {
  return Object.keys(songs).filter(id => !excludeIds.has(id));
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
export function leftSocketAvailability(visibleEdges, songId) {
  return {
    none: true,
    intro: introEdgesFor(visibleEdges, songId).length > 0,
    transition: transitionEdgesTo(visibleEdges, songId).length > 0,
  };
}
export function rightSocketAvailability(visibleEdges, songId) {
  return {
    none: true,
    outro: outroEdgesFor(visibleEdges, songId).length > 0,
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
// End Set, or a transition edge that doesn't carry a cue point yet.
export function transitionTriggerElapsed(queueHead, edges, nowSongDurationSec) {
  if (queueHead && queueHead.mode === 'transition' && queueHead.edgeId) {
    const edge = edges.find(e => e.id === queueHead.edgeId);
    if (edge && edge.outSeconds != null) return edge.outSeconds;
  }
  return nowSongDurationSec;
}

export function advanceSession(prev, songs, visibleEdges) {
  if (!prev.nowPlayingId) return prev;
  const head = prev.queue[0];
  if (head) {
    if (head.id === END) return { ...prev, isPlaying: false, setEnded: true, queue: [], timeLeft: 0 };
    const nextSong = songs[head.id];
    return { ...prev, nowPlayingId: head.id, queue: prev.queue.slice(1), timeLeft: nextSong ? nextSong.durationSec : 210 };
  }
  if (prev.autoplay) {
    const pick = pickAutoplayNext(songs, visibleEdges, prev.nowPlayingId, prev.transitionOnly);
    if (pick) {
      const nextSong = songs[pick.id];
      return {
        ...prev, nowPlayingId: pick.id, timeLeft: nextSong ? nextSong.durationSec : 210,
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

// What the Next list is reachable *from* — the tail of whatever's already
// queued, or Now Playing itself when nothing's queued yet. null once an
// End Set is queued (there's nothing to plan past it).
export function queueTailId(nowPlayingId, queue) {
  const tail = queue.length ? queue[queue.length - 1] : null;
  return tail ? (tail.id === END ? null : tail.id) : nowPlayingId;
}

export function hopEndingLabel(e) { return e === 'outro' ? 'outro' : 'cut'; }
export function hopStartingLabel(s) { return s === 'intro' ? 'intro' : 'cut'; }
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
