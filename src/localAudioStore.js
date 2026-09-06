// Local, no-backend audio storage — IndexedDB, not localStorage: the actual
// audio bytes (multi-MB masters/fragments) would blow past localStorage's
// ~5-10MB per-origin quota almost immediately, and can't be stored there at
// all without a lossy base64 round-trip anyway. IndexedDB stores real Blobs
// natively with a much larger quota, which is what makes "just works locally,
// no Cloudflare/R2 setup" actually true for real audio, not just metadata.
//
// A song/edge's persisted `audioUrl` holds a stable marker string
// (`local:<key>`) instead of a real URL, since the real thing — a `blob:`
// object URL — only exists for the lifetime of the current page and can't
// be serialized into the saved state. `resolveAudioUrl` turns a marker back
// into a live, fetchable `blob:` URL on demand (creating it once per
// session and caching it), while a real `http(s):`/`data:` URL (the
// Cloudflare-worker-configured path, or a cover image) passes through
// unchanged — every caller can hand either kind to the same function.

const DB_NAME = 'eskimo-local-audio';
const STORE = 'files';
const MARKER_PREFIX = 'local:';

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Memoizes the `blob:` URL per key for this session — resolving the same
// marker twice must hand back the exact same live URL, not a fresh one each
// time (which would leak object URLs and make equality checks unreliable).
const urlCache = new Map();

export function isLocalAudioMarker(url) { return typeof url === 'string' && url.startsWith(MARKER_PREFIX); }

// Stores `file`'s bytes and returns the marker to persist as `audioUrl`.
export async function putLocalAudio(file) {
  const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(file, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return MARKER_PREFIX + key;
}

// Turns a marker into a live, fetchable `blob:` URL (cached per key); a
// real URL (or null/empty) passes straight through unchanged.
export async function resolveAudioUrl(url) {
  if (!isLocalAudioMarker(url)) return url || null;
  const key = url.slice(MARKER_PREFIX.length);
  if (urlCache.has(key)) return urlCache.get(key);
  const db = await openDb();
  const blob = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!blob) return null;
  const objectUrl = URL.createObjectURL(blob);
  urlCache.set(key, objectUrl);
  return objectUrl;
}

// Frees a marker's stored bytes and cached object URL — called when the
// song/edge that owned it is deleted, so removed audio doesn't sit around
// in IndexedDB forever.
export async function deleteLocalAudio(url) {
  if (!isLocalAudioMarker(url)) return;
  const key = url.slice(MARKER_PREFIX.length);
  const cached = urlCache.get(key);
  if (cached) { URL.revokeObjectURL(cached); urlCache.delete(key); }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
