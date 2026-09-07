// Real playback: actually sounds the produced audio instead of only
// planning it. Layers underneath the existing session/queue model rather
// than replacing it — App.jsx's tick loop still decides *when* a hop
// happens (a committed transition's real cue point, a manual skip, a dead
// end), this module only performs the actual audio side of that decision.
//
// Graceful, per-song degradation: a song with no uploaded master plays
// silently and the caller falls back to a wall-clock estimate for its
// countdown (see getMainElapsed returning null) — nothing here requires
// every song in the library to have real audio.
//
// Sequencing model: Now Playing's own master plays as the "main" deck.
// At a hop, any produced fragment involved (a transition's own recorded
// clip, an outro leaving the old song, an intro starting the new one) is
// played to its natural end first, then the destination song's master
// becomes the new main deck — a transition's own clip is what carries
// the actual crossfade, splicing back into the destination at its
// recorded `inSeconds` cue; a plain cut/outro hop always starts its
// destination from 0. Pausing suspends the whole AudioContext (freezes
// every currently scheduled node, whichever deck or fragment is
// sounding) rather than tracking play/pause per node.

import { END, advanceSession, playlistNextHop, clamp } from './core.js';
import { resolveAudioUrl } from './localAudioStore.js';

const bufferCache = new Map();

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this._freqData = null;
    this._current = null; // { source, gain, buffer, kind: 'main'|'clip', songId?, startCtxTime, offsetSec, resolve? }
    this._playToken = 0;
    this._volume = 1; // survives a context not existing yet (set before any audio has played)
  }

  // A plain master-bus volume control, independent of anything else the
  // engine is doing — the player's own volume slider, not a per-transition
  // loudness concern. Stored on the instance (not just the GainNode) so it
  // survives ensureContext() not having run yet, e.g. a volume drag before
  // any audio has ever played.
  setVolume(v) {
    this._volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this._volume;
  }
  getVolume() { return this._volume; }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume;
      // A tap on the master bus for the Playing node's live waveform — an
      // AnalyserNode just observes whatever passes through it, so wiring it
      // inline between master and the destination doesn't change what's
      // actually heard.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.75;
      this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  // Real-time level per band, 0..1 — `bandCount` small bars reading off the
  // low/mid frequency range (music's energy lives there; the top end of an
  // FFT is mostly silence and would just read as bars that never move).
  // Returns null before any audio has ever played (no AudioContext yet).
  getLevels(bandCount) {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this._freqData);
    const usableBins = Math.floor(this._freqData.length * 0.5);
    const perBand = Math.max(1, Math.floor(usableBins / bandCount));
    const levels = [];
    for (let i = 0; i < bandCount; i++) {
      let sum = 0, count = 0;
      const start = i * perBand, end = Math.min(usableBins, start + perBand);
      for (let j = start; j < end; j++) { sum += this._freqData[j]; count++; }
      levels.push(count ? sum / count / 255 : 0);
    }
    return levels;
  }

  // `url` may be a real http(s) URL (the Cloudflare-worker-configured path)
  // or a `local:` marker for audio stored in IndexedDB with no backend at
  // all (see localAudioStore.js) — cached by the *marker/URL as given*, so
  // resolving it to its (memoized) `blob:` URL first doesn't create a
  // second cache entry for the same audio.
  async loadBuffer(url) {
    if (!url) return null;
    if (bufferCache.has(url)) return bufferCache.get(url);
    const ctx = this.ensureContext();
    const promise = resolveAudioUrl(url)
      .then((realUrl) => { if (!realUrl) throw new Error('no audio at ' + url); return fetch(realUrl); })
      .then((res) => { if (!res.ok) throw new Error('fetch failed: ' + res.status); return res.arrayBuffer(); })
      .then((ab) => new Promise((resolve, reject) => ctx.decodeAudioData(ab, resolve, reject)))
      .catch((e) => { bufferCache.delete(url); throw e; });
    bufferCache.set(url, promise);
    return promise;
  }

  async pause() { if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend(); }
  async resume() { if (this.ctx) await this.ctx.resume(); }

  // Stops whatever's audibly playing (main deck or an in-flight fragment)
  // without cancelling a handoff chain that's still awaiting buffers —
  // callers that need that too go through stopAll().
  _stopCurrentSound() {
    const c = this._current;
    if (c) {
      try { c.source.onended = null; } catch (e) { /* already stopped */ }
      try { c.source.stop(); } catch (e) { /* already stopped */ }
      try { c.source.disconnect(); } catch (e) { /* already disconnected */ }
      if (c.kind === 'clip' && c.resolve) c.resolve(); // unblock any chain awaiting this fragment
    }
    this._current = null;
  }

  // Full stop: also cancels any handoff chain still awaiting a buffer load
  // or a fragment's natural end, so a superseded chain's later `await`s
  // bail out via the token check instead of stepping on the new state.
  stopAll() {
    this._playToken++;
    this._stopCurrentSound();
  }

  _startMain(buffer, songId, offsetSec) {
    const ctx = this.ensureContext();
    // pause() suspends the whole context; nothing elsewhere ever resumes it
    // again except an explicit Play/Pause toggle. Starting a new main deck
    // (Start Set, Play again, or a fresh song after a pause) needs to be
    // audible immediately even when the previous set was left paused, not
    // silently schedule a source into a still-suspended context.
    if (ctx.state !== 'running') ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain); gain.connect(this.master);
    const startCtxTime = ctx.currentTime;
    source.start(startCtxTime, offsetSec);
    this._current = { source, gain, buffer, kind: 'main', songId, startCtxTime, offsetSec };
  }

  _playClipToEnd(buffer) {
    return new Promise((resolve) => {
      const ctx = this.ensureContext();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      source.connect(gain); gain.connect(this.master);
      source.onended = () => resolve();
      const startCtxTime = ctx.currentTime;
      source.start(startCtxTime);
      this._current = { source, gain, buffer, kind: 'clip', startCtxTime, offsetSec: 0, resolve };
    });
  }

  // Scrubbing the playhead: restarts the same already-loaded main-deck
  // buffer at a new offset instead of re-fetching/re-decoding it. Returns
  // false (a no-op for the caller) when `songId` isn't actually the main
  // deck sounding right now — mid-fragment (a transition/outro clip
  // playing), or a song with no uploaded master at all, so there's nothing
  // real to seek; the caller's own wall-clock `timeLeft` is what moves in
  // that case instead, same as normal playback for a silent song already
  // works today.
  seekMain(songId, offsetSec) {
    const c = this._current;
    if (!c || c.kind !== 'main' || c.songId !== songId) return false;
    const ctx = this.ensureContext();
    const clamped = Math.max(0, Math.min(offsetSec, c.buffer.duration));
    try { c.source.onended = null; c.source.stop(); c.source.disconnect(); } catch (e) { /* already stopped */ }
    this._startMain(c.buffer, songId, clamped);
    return true;
  }

  // Real elapsed seconds into `songId`'s own master, straight off the
  // AudioContext clock — null whenever that song isn't the thing actually
  // sounding right now (no real audio at all, or mid-fragment), which is
  // the caller's cue to fall back to a wall-clock estimate instead.
  getMainElapsed(songId) {
    if (!this.ctx || !this._current || this._current.kind !== 'main' || this._current.songId !== songId) return null;
    return this._current.offsetSec + Math.max(0, this.ctx.currentTime - this._current.startCtxTime);
  }

  // Starts the very first song of a set. `introEdge` (real audio optional)
  // plays first when the DJ chose "Intro" as the starting method.
  async startMain(song, introEdge) {
    const token = ++this._playToken;
    this._stopCurrentSound();
    if (!song || !song.audioUrl) return false;
    if (introEdge && introEdge.audioUrl) {
      const introBuf = await this.loadBuffer(introEdge.audioUrl).catch(() => null);
      if (token !== this._playToken) return false;
      if (introBuf) {
        await this._playClipToEnd(introBuf);
        if (token !== this._playToken) return false;
      }
    }
    const buffer = await this.loadBuffer(song.audioUrl).catch(() => null);
    if (token !== this._playToken || !buffer) return false;
    this._startMain(buffer, song.id, 0);
    return true;
  }

  // The real-audio side of a hop the session model already decided on
  // (see performAdvance below) — plays whatever produced fragments are
  // involved, then starts the destination song's own master, if any of
  // it has real audio to play; otherwise leaves the deck silent so the
  // caller's wall-clock fallback keeps the countdown going on its own.
  async handleHandoff({ hop, destSong, edges, ending, starting, outroEdge, introEdge }) {
    const token = ++this._playToken;
    this._stopCurrentSound();

    if (hop && hop.id === END) {
      if (ending === 'outro' && outroEdge && outroEdge.audioUrl) {
        const buf = await this.loadBuffer(outroEdge.audioUrl).catch(() => null);
        if (token !== this._playToken) return;
        if (buf) await this._playClipToEnd(buf);
      }
      return;
    }
    if (!destSong) return;

    if (hop && hop.mode === 'transition') {
      const edge = edges.find((e) => e.id === hop.edgeId);
      let startOffset = 0;
      if (edge && edge.audioUrl) {
        const buf = await this.loadBuffer(edge.audioUrl).catch(() => null);
        if (token !== this._playToken) return;
        if (buf) {
          await this._playClipToEnd(buf);
          if (token !== this._playToken) return;
          startOffset = edge.inSeconds != null ? edge.inSeconds : 0;
        }
      }
      const mainBuf = await this.loadBuffer(destSong.audioUrl).catch(() => null);
      if (token !== this._playToken || !mainBuf) return;
      this._startMain(mainBuf, destSong.id, startOffset);
      return;
    }

    // cut/outro hop: an outro clip leaving the old song, then an intro
    // clip starting the new one, whichever of the two actually exist.
    if (ending === 'outro' && outroEdge && outroEdge.audioUrl) {
      const buf = await this.loadBuffer(outroEdge.audioUrl).catch(() => null);
      if (token !== this._playToken) return;
      if (buf) await this._playClipToEnd(buf);
      if (token !== this._playToken) return;
    }
    if (starting === 'intro' && introEdge && introEdge.audioUrl) {
      const buf = await this.loadBuffer(introEdge.audioUrl).catch(() => null);
      if (token !== this._playToken) return;
      if (buf) await this._playClipToEnd(buf);
      if (token !== this._playToken) return;
    }
    const mainBuf = await this.loadBuffer(destSong.audioUrl).catch(() => null);
    if (token !== this._playToken || !mainBuf) return;
    this._startMain(mainBuf, destSong.id, 0);
  }
}

export const engine = new AudioEngine();

// Shared by both the set-clock's automatic tick and the manual skip button
// (App.jsx and PerformPage.jsx respectively) — one place that both decides
// the next session state (advanceSession, core.js — unchanged) and performs
// the matching real-audio handoff, so the two call sites can never disagree
// about what a hop actually does.
export function performAdvance(prevSession, songs, edges) {
  const nowPlayingId = prevSession.nowPlayingId;
  const explicitHop = prevSession.queue[0] || null;
  // No manual queue entry — fall back to the graph's own wiring (the
  // playlist editor, see TODO.md) before resorting to autoplay's random
  // pick, so a fully wired loop keeps itself going forever without ever
  // needing randomness. A manual commit always wins when both exist.
  const wiredHop = !explicitHop ? playlistNextHop(prevSession.activePlaylist, nowPlayingId) : null;
  const hop = explicitHop || wiredHop;
  const next = wiredHop
    ? advanceSession({ ...prevSession, queue: [wiredHop] }, songs, edges)
    : advanceSession(prevSession, songs, edges);

  // Prefers the hop's own edgeId — the specific outro variant actually
  // wired/selected (see playlistNextHop/confirmEndSet) — over a blind
  // "first outro on this song" scan, which would play the wrong audio the
  // moment a song has more than one outro variant to choose from.
  function findOutroEdge(edgeId) {
    return (edgeId && edges.find((e) => e.id === edgeId)) || edges.find((e) => e.type === 'outro' && e.l === nowPlayingId);
  }
  if (hop) {
    if (hop.id === END) {
      const outroEdge = hop.ending === 'outro' ? findOutroEdge(hop.edgeId) : null;
      engine.handleHandoff({ hop, destSong: null, edges, ending: hop.ending, outroEdge });
    } else {
      const destSong = songs[hop.id];
      const outroEdge = hop.mode === 'cut' && hop.ending === 'outro' ? findOutroEdge(hop.edgeId) : null;
      const introEdge = hop.mode === 'cut' && hop.starting === 'intro' ? edges.find((e) => e.type === 'intro' && e.r === hop.id) : null;
      engine.handleHandoff({ hop, destSong, edges, ending: hop.ending, starting: hop.starting, outroEdge, introEdge });
    }
  } else if (prevSession.autoplay && next.nowPlayingId && next.nowPlayingId !== nowPlayingId) {
    const destSong = songs[next.nowPlayingId];
    const picked = next.autoHistory[next.autoHistory.length - 1];
    const mode = picked ? picked.mode : 'cut';
    const introEdge = mode === 'cut' ? edges.find((e) => e.type === 'intro' && e.r === next.nowPlayingId) : null;
    engine.handleHandoff({ hop: { mode }, destSong, edges, starting: introEdge ? 'intro' : 'cut', introEdge });
  } else if (!next.isPlaying) {
    engine.stopAll();
  }
  return next;
}
