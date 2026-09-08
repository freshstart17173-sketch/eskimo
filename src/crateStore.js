// Shared live crates — a DJ shares a link, producer friends open the real
// editor and contribute songs/audio directly into the same pool. See
// docs/live-crate-collab-design.md for the full spec this implements
// ("W1": the song/edge pool is shared and live-synced; graph wiring and
// playback session are never stored here — App.jsx keeps those entirely
// local per browser, which is what makes it structurally impossible for a
// collaborator's edit to ever touch anyone's live performance state).
//
// Deliberately its own Supabase client and its own table set, separate
// from core.js's `Store`/`library` (personal, auth.uid()-scoped) — a
// crate has no per-user identity at all, RLS-wise: the crate id itself is
// the credential, same "anyone with the link" model the already-public R2
// audio objects use (see the migration's own comment for the trade-off).
import { createClient } from '@supabase/supabase-js';
import { APP_CONFIG } from './config.js';

const crateSupaConfigured = !!(APP_CONFIG.SUPABASE_URL && APP_CONFIG.SUPABASE_ANON_KEY);
const supa = crateSupaConfigured ? createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY) : null;
export const isCrateSyncConfigured = crateSupaConfigured;

function randomCrateId() {
  // 22 url-safe chars (~131 bits) — unguessable enough that "the id is the
  // credential" is a reasonable model, same order of magnitude as a nanoid.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  for (let i = 0; i < 22; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

export async function createCrate() {
  if (!supa) return null;
  const id = randomCrateId();
  const { error } = await supa.from('crates').insert({ id });
  if (error) { console.warn('Eskimo Studio: could not create a shared crate', error); return null; }
  return id;
}

// --- row <-> app-object shape mapping -------------------------------------
function songFromRow(row) {
  return {
    id: row.song_id, title: row.title || '', artist: row.artist || '',
    bpm: row.bpm, key: row.key, durationSec: row.duration_sec,
    audioUrl: row.audio_url, coverUrl: row.cover_url, x: row.x, y: row.y,
  };
}
function songToRow(crateId, song) {
  return {
    crate_id: crateId, song_id: song.id, title: song.title || '', artist: song.artist || '',
    bpm: song.bpm, key: song.key, duration_sec: song.durationSec,
    audio_url: song.audioUrl || null, cover_url: song.coverUrl || null,
    x: song.x, y: song.y, updated_at: new Date().toISOString(),
  };
}
function edgeFromRow(row) {
  return {
    id: row.edge_id, type: row.type, l: row.l || undefined, r: row.r || undefined,
    inSeconds: row.in_seconds == null ? undefined : row.in_seconds,
    outSeconds: row.out_seconds == null ? undefined : row.out_seconds,
    verified: row.verified,
  };
}
function edgeToRow(crateId, edge) {
  return {
    crate_id: crateId, edge_id: edge.id, type: edge.type, l: edge.l || null, r: edge.r || null,
    in_seconds: edge.inSeconds == null ? null : edge.inSeconds,
    out_seconds: edge.outSeconds == null ? null : edge.outSeconds,
    verified: !!edge.verified, updated_at: new Date().toISOString(),
  };
}

// One-time load of everything currently in the crate — the realtime
// subscription below only ever delivers *changes* from this point forward.
export async function fetchCrateLibrary(crateId) {
  if (!supa) return null;
  const [songsRes, edgesRes] = await Promise.all([
    supa.from('crate_songs').select('*').eq('crate_id', crateId),
    supa.from('crate_edges').select('*').eq('crate_id', crateId),
  ]);
  if (songsRes.error || edgesRes.error) {
    console.warn('Eskimo Studio: could not load shared crate', songsRes.error || edgesRes.error);
    return null;
  }
  const songs = {};
  songsRes.data.forEach(row => { songs[row.song_id] = songFromRow(row); });
  const edges = edgesRes.data.map(edgeFromRow);
  return { songs, edges };
}

export async function pushCrateSong(crateId, song) {
  if (!supa) return;
  const { error } = await supa.from('crate_songs').upsert(songToRow(crateId, song));
  if (error) console.warn('Eskimo Studio: could not save song to shared crate', error);
}
export async function deleteCrateSong(crateId, songId) {
  if (!supa) return;
  const { error } = await supa.from('crate_songs').delete().eq('crate_id', crateId).eq('song_id', songId);
  if (error) console.warn('Eskimo Studio: could not remove song from shared crate', error);
}
export async function pushCrateEdge(crateId, edge) {
  if (!supa) return;
  const { error } = await supa.from('crate_edges').upsert(edgeToRow(crateId, edge));
  if (error) console.warn('Eskimo Studio: could not save audio piece to shared crate', error);
}
export async function deleteCrateEdge(crateId, edgeId) {
  if (!supa) return;
  const { error } = await supa.from('crate_edges').delete().eq('crate_id', crateId).eq('edge_id', edgeId);
  if (error) console.warn('Eskimo Studio: could not remove audio piece from shared crate', error);
}

// Incremental change events only (Postgres CDC via Supabase Realtime) —
// never a wholesale re-fetch-and-replace on this path, which is what would
// reintroduce the exact "remote update stomps local state" risk the whole
// design exists to avoid (see the design doc's requirement 10). Returns an
// unsubscribe function.
export function subscribeCrateLibrary(crateId, { onSong, onSongDelete, onEdge, onEdgeDelete }) {
  if (!supa) return () => {};
  const channel = supa
    .channel('crate:' + crateId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'crate_songs', filter: 'crate_id=eq.' + crateId }, (payload) => {
      if (payload.eventType === 'DELETE') onSongDelete(payload.old.song_id);
      else onSong(songFromRow(payload.new));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'crate_edges', filter: 'crate_id=eq.' + crateId }, (payload) => {
      if (payload.eventType === 'DELETE') onEdgeDelete(payload.old.edge_id);
      else onEdge(edgeFromRow(payload.new));
    })
    .subscribe();
  return () => { supa.removeChannel(channel); };
}
