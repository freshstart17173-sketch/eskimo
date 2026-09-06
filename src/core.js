// =====================================================================================
// Eskimo Studio — core data model & pure logic (no React here — plain JS, easy to unit
// test). A song is flat (no version sub-objects) — a remix is just another song.
// =====================================================================================
import { createClient } from '@supabase/supabase-js';
import { APP_CONFIG } from './config.js';

export const END = '__end__';
const STORAGE_KEY = 'djflow:v3';

// ---------------------------------------------------------------------------
// Real app state starts empty — no demo/sample data is ever loaded into the app.
// These sample* functions exist purely so core.test.js (run via `npm test`)
// has some realistic data to exercise; nothing in the app itself calls them.
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
    { id: 'e6', type: 'transition', l: 'gs', r: 'lr', verified: false },
    { id: 'e13', type: 'transition', l: 'gs', r: 'wr', verified: true },
    { id: 'e14', type: 'outro', l: 'gs', verified: true },
  ];
}

export function emptySession() {
  return {
    nowPlayingId: null, startMethod: null,
    queue: [], timeLeft: 0, isPlaying: false, setEnded: false,
    endingChoice: 'cut', // how Now Playing will end if nothing more gets queued — 'cut' | 'outro'
    autoplay: false, // when true and nothing's manually queued, pickAutoplayNext chooses
    transitionOnly: false, // true = a dead end stops the set instead of cutting to a random song
    autoHistory: [], // songs autoplay has actually played, most recent last — for the bottom queue bar
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

// The one and only "no saved state yet" starting point — a genuinely empty
// library. Nothing is seeded; the person adds their own songs and audio.
export function freshState() { return { songs: {}, edges: [], session: emptySession(), venueName: '' }; }

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

// One hop of *built* transitions out of a specific song, excluding ids already
// used elsewhere in the current plan. This is the one primitive both the
// "Next" list (from Now Playing) and the "Later" list (from whatever's
// staged in Next) are built from.
export function oneHopReachable(visibleEdges, fromId, excludeIds) {
  const out = new Set();
  visibleEdges.filter(e => e.type === 'transition' && e.l === fromId).forEach(e => {
    if (!excludeIds.has(e.r)) out.add(e.r);
  });
  return out;
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
    return { ...prev, nowPlayingId: head.id, queue: prev.queue.slice(1), timeLeft: nextSong ? nextSong.durationSec : 210, endingChoice: 'cut' };
  }
  if (prev.autoplay) {
    const pick = pickAutoplayNext(songs, visibleEdges, prev.nowPlayingId, prev.transitionOnly);
    if (pick) {
      const nextSong = songs[pick.id];
      return {
        ...prev, nowPlayingId: pick.id, timeLeft: nextSong ? nextSong.durationSec : 210, endingChoice: 'cut',
        autoHistory: [...prev.autoHistory, { id: pick.id, mode: pick.mode }].slice(-40),
      };
    }
  }
  return { ...prev, isPlaying: false, setEnded: true, timeLeft: 0 };
}

// Removing a song must not leave dangling edges pointing at it.
export function removeSongCascade(songs, edges, songId) {
  const nextSongs = { ...songs };
  delete nextSongs[songId];
  const nextEdges = edges.filter(e => e.l !== songId && e.r !== songId);
  return { songs: nextSongs, edges: nextEdges };
}

// ---------------------------------------------------------------------------
// Reachability from the tail of the current queue (or Now Playing if the queue
// is empty). "tier1" is the Next list; the Later list is computed separately,
// live, from whichever song is staged (see oneHopReachable above).
// ---------------------------------------------------------------------------
export function computeReachability(songs, visibleEdges, nowPlayingId, queue) {
  const queueHasId = (id) => queue.some(q => q.id === id);
  const tail = queue.length ? queue[queue.length - 1] : null;
  const fromId = tail ? (tail.id === END ? null : tail.id) : nowPlayingId;

  const tier1 = new Set();
  if (fromId) {
    visibleEdges.filter(e => e.type === 'transition' && e.l === fromId).forEach(e => {
      if (e.r !== nowPlayingId && !queueHasId(e.r)) tier1.add(e.r);
    });
    visibleEdges.filter(e => e.type === 'intro').forEach(e => {
      if (e.r !== nowPlayingId && !queueHasId(e.r)) tier1.add(e.r);
    });
    if (!queueHasId(END)) tier1.add(END);
  }
  return { fromId, tier1 };
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
