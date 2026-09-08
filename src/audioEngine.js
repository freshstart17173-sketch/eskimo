// Real playback: actually sounds the produced audio instead of only
// planning it. Layers underneath the existing session/queue model rather
// than replacing it — App.jsx's tick loop still decides *when* a hop
// happens (a committed transition's real cue point, a manual skip, a dead
// end), this module only performs the actual audio side of that decision.
//
// Graceful, per-song degradation: a song with no uploaded master plays
// silently but still gets a real ctx-anchored position (kind 'silent' in
// _current — see startMain/getMainElapsed/getPlaybackPosition), so its
// countdown is exact rather than a wall-clock guess — nothing here
// requires every song in the library to have real audio.
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
    // The one pending sample-accurate schedule, if any — see scheduleHop's
    // own comment (docs/playback-model.md sec 6). Driven by App.jsx's tick.
    this._plan = null;
    this._planToken = 0;
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
  // callers that need that too go through stopAll(). Always cancels any
  // pending Plan too: its scheduled times were computed against whichever
  // deck is being stopped right now, so they're meaningless (and would
  // collide with whatever plays next) the moment that deck goes away.
  _stopCurrentSound() {
    this.cancelPlan();
    const c = this._current;
    if (c && c.source) {
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

  // `offsetSec` skips into the clip's OWN timeline before playing (an outro
  // clip commonly still carries the original song's own tail before its
  // new material starts — see edge.clipStartSec). `clipEndSec`, when given,
  // is the absolute position in the clip's OWN timeline to stop at instead
  // of playing to its natural end (an intro clip commonly still carries a
  // trailing overlap into the destination's own opening — edge.clipEndSec).
  // Both default to "play the whole clip", the same behavior as before
  // either concept existed.
  _playClipToEnd(buffer, offsetSec = 0, clipEndSec = null) {
    return new Promise((resolve) => {
      const ctx = this.ensureContext();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      source.connect(gain); gain.connect(this.master);
      source.onended = () => resolve();
      const startCtxTime = ctx.currentTime;
      const playDurationSec = clipEndSec != null ? Math.max(0, clipEndSec - offsetSec) : null;
      if (playDurationSec != null) source.start(startCtxTime, offsetSec, playDurationSec);
      else source.start(startCtxTime, offsetSec);
      this._current = { source, gain, buffer, kind: 'clip', startCtxTime, offsetSec, resolve };
    });
  }

  // Scrubbing the playhead: restarts the same already-loaded main-deck
  // buffer at a new offset instead of re-fetching/re-decoding it. A song
  // with no uploaded master ('silent' kind — see startMain) has no buffer
  // to restart, but still has a ctx-anchored position (offsetSec/
  // startCtxTime, same as a real deck) that a seek must update the same
  // way — otherwise the next authoritative read (getMainElapsed/
  // getPlaybackPosition) would compute elapsed from the old anchor and a
  // stale reactive fallback could stomp the seek before anything else
  // ever notices it happened. Returns false (a genuine no-op) only when
  // `songId` isn't the thing actually sounding right now at all — e.g.
  // mid-fragment (a transition/outro clip playing).
  seekMain(songId, offsetSec) {
    const c = this._current;
    if (!c || (c.kind !== 'main' && c.kind !== 'silent') || c.songId !== songId) return false;
    const ctx = this.ensureContext();
    if (c.kind === 'silent') {
      c.offsetSec = Math.max(0, Math.min(offsetSec, c.durationSec));
      c.startCtxTime = ctx.currentTime;
      return true;
    }
    const clamped = Math.max(0, Math.min(offsetSec, c.buffer.duration));
    // Any pending plan's scheduled times were computed against this deck's
    // old startCtxTime/offsetSec — meaningless (and wrong) the moment
    // either changes, so it has to go, not just the sound itself.
    this.cancelPlan();
    try { c.source.onended = null; c.source.stop(); c.source.disconnect(); } catch (e) { /* already stopped */ }
    this._startMain(c.buffer, songId, clamped);
    return true;
  }

  // Real elapsed seconds into `songId`'s own master, off the AudioContext
  // clock — including the ctx-anchored fallback a 'silent' deck (no
  // uploaded master) keeps for exactly this purpose. Null only when that
  // song isn't the thing actually sounding right now (mid-fragment, or
  // nothing playing at all), which is the caller's cue to fall back to a
  // wall-clock estimate instead.
  getMainElapsed(songId) {
    if (!this.ctx || !this._current || this._current.songId !== songId) return null;
    if (this._current.kind !== 'main' && this._current.kind !== 'silent') return null;
    return this._current.offsetSec + Math.max(0, this.ctx.currentTime - this._current.startCtxTime);
  }

  // ---------------------------------------------------------------------
  // Sample-accurate scheduling (the "Plan" model — docs/playback-model.md
  // sec 6), driven by App.jsx's tick. Given a hop, compute the
  // exact chain of AudioContext-time-scheduled start()/stop() calls and
  // commit them once every buffer involved is decoded, however far in
  // advance of the actual cue point that turns out to be. The audio
  // hardware fires each one at its own precise scheduled time regardless
  // of anything happening on the main thread afterward — that's the whole
  // point: nothing here is "start now", every call carries its own real
  // future AudioContext time.
  // ---------------------------------------------------------------------

  // A source node with nothing scheduled yet — callers decide the exact
  // start (and optionally stop) time. Split out from _startMain/
  // _playClipToEnd (which still call .start(ctx.currentTime, ...)
  // themselves for the "right now" cases) so scheduleHop can create nodes
  // without committing to when they'll fire until the whole chain's math
  // is worked out.
  _createSource(buffer) {
    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain); gain.connect(this.master);
    return source;
  }

  // Cancels whatever's pending in the current plan — any node scheduled
  // to start in the future that hasn't started yet. Calling stop() on a
  // node before its scheduled start time cancels it outright (it never
  // plays at all), per the AudioBufferSourceNode spec — this does NOT
  // touch whatever's already actually sounding right now (the current
  // main deck, or a fragment already mid-playback), only steps of the
  // plan still waiting in the future.
  cancelPlan() {
    if (!this._plan) return;
    const plan = this._plan;
    this._plan = null;
    for (const node of plan.pendingNodes) {
      try { node.stop(); } catch (e) { /* already started, or already stopped */ }
    }
  }

  // `hopDecision`: { cueOffsetSec, fragmentUrls: [url, ...], destSongId,
  // destUrl, destOffsetSec }. `cueOffsetSec` is measured on the CURRENT
  // main deck's own buffer timeline (an edge's outSeconds, or the full
  // duration for a plain cut with no earlier cue) — everything else is
  // computed relative to it. Returns the committed Plan, or null if there
  // was nothing real to schedule against (no main deck playing yet) or
  // the hop was superseded (a newer call, a seek, a stop) before the
  // needed buffers finished loading — in the latter case the caller
  // should treat this exactly like scheduling never happened, since
  // nothing was committed to the audio graph.
  async scheduleHop(hopDecision) {
    if (!hopDecision) { this.cancelPlan(); return null; }
    const current = this._current;
    if (!current || current.kind !== 'main') return null;
    const planToken = ++this._planToken;
    this.cancelPlan();

    // { url, offsetSec?, clipEndSec? } per fragment — offsetSec/clipEndSec
    // trim into the fragment's OWN timeline (an outro's own duplicated tail,
    // an intro's own trailing overlap — see edge.clipStartSec/clipEndSec),
    // independent of the surrounding songs' own cue points.
    const fragments = (hopDecision.fragments || []).filter((f) => f && f.url);
    const urlsToLoad = [...fragments.map((f) => f.url), ...(hopDecision.destUrl ? [hopDecision.destUrl] : [])];
    const buffers = await Promise.all(urlsToLoad.map((url) => this.loadBuffer(url).catch(() => null)));
    // Superseded while awaiting buffers — a newer scheduleHop call, a
    // seek, or a stop already happened. Bail without touching the graph;
    // whichever call superseded this one owns the current state now.
    if (planToken !== this._planToken) return null;
    if (this._current !== current) return null;

    const fragmentBuffers = buffers.slice(0, fragments.length);
    const destBuffer = hopDecision.destUrl ? buffers[buffers.length - 1] : null;
    // A fragment or the destination failed to load (network error, bad
    // file) — bail rather than schedule a chain with a silent gap where
    // real audio was supposed to be; the caller's existing reactive path
    // is the fallback for this rare case, same as today.
    if (fragments.length && fragmentBuffers.some((b) => !b)) return null;
    if (hopDecision.destUrl && !destBuffer) return null;

    const triggerCtxTime = current.startCtxTime + (hopDecision.cueOffsetSec - current.offsetSec);
    const pendingNodes = [];

    // A time already in the past (buffers took longer to load than the
    // remaining lead time) still stops/starts immediately rather than
    // throwing — graceful degradation back toward today's reactive
    // behavior for that rare case, not a hard failure.
    try { current.source.stop(triggerCtxTime); } catch (e) { /* already stopped */ }

    let stepTime = triggerCtxTime;
    const fragmentSteps = []; // { buffer, startCtxTime, offsetSec, durationSec } per fragment — see getPlaybackPosition
    for (let i = 0; i < fragmentBuffers.length; i++) {
      const buffer = fragmentBuffers[i];
      const spec = fragments[i];
      const offsetSec = spec.offsetSec || 0;
      const playDurationSec = spec.clipEndSec != null ? Math.max(0, spec.clipEndSec - offsetSec) : (buffer.duration - offsetSec);
      const node = this._createSource(buffer);
      if (spec.clipEndSec != null) node.start(stepTime, offsetSec, playDurationSec);
      else node.start(stepTime, offsetSec);
      pendingNodes.push(node);
      fragmentSteps.push({ buffer, startCtxTime: stepTime, offsetSec, durationSec: playDurationSec });
      stepTime += playDurationSec;
    }

    // The ctx-time everything scheduled by this call has finished by —
    // equal to destStartCtxTime when there's a real destination, but also
    // meaningful when there isn't one (an End-Set outro): the moment the
    // last fragment's own playback actually ends. Stored separately from
    // destStartCtxTime (which stays null for a no-destination hop) so a
    // caller checking "has this plan already fully fired" never has to
    // treat a null destStartCtxTime as "always already past" — `now >=
    // null` coerces to `now >= 0`, which is true from the very first tick
    // after scheduling, long before the fragment itself actually played.
    const planEndCtxTime = stepTime;

    let destStartCtxTime = null, destNode = null;
    if (destBuffer) {
      destNode = this._createSource(destBuffer);
      destNode.start(stepTime, hopDecision.destOffsetSec || 0);
      pendingNodes.push(destNode);
      destStartCtxTime = stepTime;
    }

    const plan = {
      triggerCtxTime, destStartCtxTime, planEndCtxTime, destSongId: hopDecision.destSongId || null,
      destNode, destBuffer, destOffsetSec: hopDecision.destOffsetSec || 0, pendingNodes, fragmentSteps,
    };
    this._plan = plan;
    return plan;
  }

  // Called once a caller (the tick, currently) notices the plan's
  // destination has actually started sounding — ctx.currentTime has
  // passed destStartCtxTime — so it can be promoted to `_current` exactly
  // as if `_startMain` had been called for it directly. Without this,
  // getMainElapsed/seekMain/the next scheduleHop call would have no way
  // to recognize the new main deck as real, sounding audio.
  consumePlan(plan) {
    if (this._plan === plan) this._plan = null;
    if (!plan.destNode) return; // an End-Set hop with no destination — nothing to promote
    this._current = {
      source: plan.destNode, buffer: plan.destBuffer, kind: 'main',
      songId: plan.destSongId, startCtxTime: plan.destStartCtxTime, offsetSec: plan.destOffsetSec,
    };
  }

  // The one authoritative "what's actually happening right now" query
  // (docs/playback-model.md sec 7, Layer A) — sourced entirely from
  // ctx.currentTime against the Plan/main-deck state, never a wall-clock
  // accumulation, for anything with real audio. A UI driving a continuous
  // display (a progress bar, a countdown) should read this every frame
  // instead of computing its own position off session.timeLeft, which
  // only changes once a second and — before this — was the actual cause
  // of the reported jumpiness.
  //
  // Returns one of:
  //   { phase: 'silence' }                                    — nothing real to report yet
  //   { phase: 'fragment', elapsedSec, durationSec }           — mid transition/outro/intro clip
  //   { phase: 'main', songId, elapsedSec, durationSec }       — a real master is sounding
  getPlaybackPosition() {
    if (!this.ctx) return { phase: 'silence' };
    const now = this.ctx.currentTime;
    const plan = this._plan;
    if (plan && now >= plan.triggerCtxTime && (plan.destStartCtxTime == null || now < plan.destStartCtxTime)) {
      for (let i = plan.fragmentSteps.length - 1; i >= 0; i--) {
        const step = plan.fragmentSteps[i];
        if (now >= step.startCtxTime) {
          return { phase: 'fragment', elapsedSec: now - step.startCtxTime, durationSec: step.durationSec };
        }
      }
    }
    if (this._current && this._current.kind === 'main') {
      return {
        phase: 'main', songId: this._current.songId,
        elapsedSec: this._current.offsetSec + Math.max(0, now - this._current.startCtxTime),
        durationSec: this._current.buffer.duration,
      };
    }
    if (this._current && this._current.kind === 'silent') {
      // Same shape as 'main' — a consumer shouldn't need to know there's
      // no real audio behind it — just sourced from the ctx clock instead
      // of a buffer's own duration.
      return {
        phase: 'main', songId: this._current.songId,
        elapsedSec: this._current.offsetSec + Math.max(0, now - this._current.startCtxTime),
        durationSec: this._current.durationSec,
      };
    }
    return { phase: 'silence' };
  }

  // Starts the very first song of a set. `introEdge` (real audio optional)
  // plays first when the DJ chose "Intro" as the starting method.
  // `offsetSec` (default 0) is the one exception to "a fresh start is
  // always offset 0" — togglePlaying (playbackControls.js) reuses this to
  // resume a song mid-way through, at a persisted position, after a
  // reload left nothing real anchored to resume from (see
  // restoreCosmeticPosition below); every other caller only ever passes 0
  // implicitly. `introEdge` is naturally skipped by callers resuming
  // mid-song (they pass null) — replaying an intro clip when picking back
  // up partway through wouldn't make sense.
  async startMain(song, introEdge, offsetSec = 0) {
    const token = ++this._playToken;
    this._stopCurrentSound();
    if (!song || !song.audioUrl) {
      // No real audio to play — still record a ctx.currentTime-anchored
      // reference (not Date.now()) so getPlaybackPosition's countdown for
      // this song stays immune to setInterval/rAF throttling even though
      // there's nothing actually sounding to be sample-accurate *to*. Kept
      // as its own `kind` (not 'main') so getMainElapsed/seekMain/the
      // scheduler correctly keep treating this as "no real deck" — this is
      // purely a clock reference for the cosmetic countdown.
      if (song) this._current = { kind: 'silent', songId: song.id, startCtxTime: this.ensureContext().currentTime, offsetSec, durationSec: song.durationSec || 210 };
      return false;
    }
    if (introEdge && introEdge.audioUrl) {
      const introBuf = await this.loadBuffer(introEdge.audioUrl).catch(() => null);
      if (token !== this._playToken) return false;
      if (introBuf) {
        await this._playClipToEnd(introBuf, 0, introEdge.clipEndSec != null ? introEdge.clipEndSec : null);
        if (token !== this._playToken) return false;
      }
    }
    const buffer = await this.loadBuffer(song.audioUrl).catch(() => null);
    if (token !== this._playToken || !buffer) return false;
    this._startMain(buffer, song.id, offsetSec);
    return true;
  }

  // A reload leaves session.isPlaying/nowPlayingId persisted with nothing
  // real anchored to match — real audio can't (and shouldn't try to)
  // resume without a fresh user gesture, so App.jsx forces isPlaying back
  // to false on load rather than let the session lie about what's audible
  // (see docs/playback-model.md's reload-seek finding). This still
  // restores a cheap, cosmetic-only position (kind: 'silent', no buffer,
  // no user-gesture requirement) purely so the scrub bar/countdown rings
  // show where the set actually was instead of snapping to 0 until Play
  // is pressed again. Never overwrites a real anchor that's already
  // there — this only ever runs once, right after a fresh load.
  restoreCosmeticPosition(song, offsetSec) {
    if (!song || this._current) return;
    this._current = { kind: 'silent', songId: song.id, startCtxTime: this.ensureContext().currentTime, offsetSec, durationSec: song.durationSec || 210 };
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
        if (buf) await this._playClipToEnd(buf, outroEdge.clipStartSec || 0);
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
    // clip starting the new one, whichever of the two actually exist. The
    // outro clip starts past its own duplicated tail (clipStartSec); the
    // intro clip stops before its own trailing overlap into the
    // destination (clipEndSec) — the main deck already played to its own
    // full duration before this ran, and the destination always starts
    // fresh at 0 right after, so neither clip needs to touch those points.
    if (ending === 'outro' && outroEdge && outroEdge.audioUrl) {
      const buf = await this.loadBuffer(outroEdge.audioUrl).catch(() => null);
      if (token !== this._playToken) return;
      if (buf) await this._playClipToEnd(buf, outroEdge.clipStartSec || 0);
      if (token !== this._playToken) return;
    }
    if (starting === 'intro' && introEdge && introEdge.audioUrl) {
      const buf = await this.loadBuffer(introEdge.audioUrl).catch(() => null);
      if (token !== this._playToken) return;
      if (buf) await this._playClipToEnd(buf, 0, introEdge.clipEndSec != null ? introEdge.clipEndSec : null);
      if (token !== this._playToken) return;
    }
    const mainBuf = await this.loadBuffer(destSong.audioUrl).catch(() => null);
    if (token !== this._playToken || !mainBuf) return;
    this._startMain(mainBuf, destSong.id, 0);
  }
}

export const engine = new AudioEngine();

// Warms the buffer cache for whatever a hop is about to need, ahead of the
// actual cue point — called by App.jsx's tick loop once the trigger is
// within PREFETCH_LOOKAHEAD_SEC. This doesn't fix the ~1s tick-granularity
// timing slop (see docs/playback-model.md, Finding 2 — that needs a real
// scheduler, not a contained patch), but it does remove the *decode
// latency* half of the "seamless" transition gap (Finding 1): a fragment
// that's already sitting decoded in `bufferCache` by the time performAdvance
// actually fires starts playing on the same tick instead of after an
// awaited fetch+decode round trip. loadBuffer already dedupes by URL, so
// calling this every tick while inside the lookahead window is harmless —
// only the first call for a given URL does real work.
// Prefers the hop's own edgeId — the specific outro variant actually
// wired/selected (see playlistNextHop/confirmEndSet) — over a blind
// "first outro on this song" scan, which would play the wrong audio the
// moment a song has more than one outro variant to choose from. Shared by
// performAdvance and buildHopDecision so there's exactly one place that
// resolves "which outro edge did this hop actually mean" — two separate
// copies of this same lookup is exactly how they'd eventually disagree.
export function findOutroEdgeFor(edges, nowPlayingId, edgeId) {
  return (edgeId && edges.find((e) => e.id === edgeId)) || edges.find((e) => e.type === 'outro' && e.l === nowPlayingId);
}

export const PREFETCH_LOOKAHEAD_SEC = 6;
export function prefetchHop(hop, nowPlayingId, edges, songs) {
  if (!hop) return;
  if (hop.id === END) {
    const edge = findOutroEdgeFor(edges, nowPlayingId, hop.edgeId);
    if (edge && edge.audioUrl) engine.loadBuffer(edge.audioUrl).catch(() => null);
    return;
  }
  const destSong = songs[hop.id];
  if (hop.mode === 'transition') {
    const edge = edges.find((e) => e.id === hop.edgeId);
    if (edge && edge.audioUrl) engine.loadBuffer(edge.audioUrl).catch(() => null);
  } else if (hop.ending === 'outro') {
    const edge = findOutroEdgeFor(edges, nowPlayingId, hop.edgeId);
    if (edge && edge.audioUrl) engine.loadBuffer(edge.audioUrl).catch(() => null);
  }
  if (destSong && destSong.audioUrl) engine.loadBuffer(destSong.audioUrl).catch(() => null);
}

// Converts a `hop` (the same {id, mode, ending, starting, edgeId} shape
// used throughout the app) into what scheduleHop actually needs: an exact
// cue point on the CURRENT main deck's own timeline, the fragment(s) that
// play at it, and the destination. Falls back to `currentBufferDurationSec`
// (the real decoded buffer's own length, not the data model's durationSec
// field) as the cue point whenever there's no earlier real one — a plain
// cut fires at the song's natural end, which still benefits from being
// scheduled precisely in advance rather than reactively (the destination's
// buffer still has to be fetched/decoded from somewhere, same as any other
// hop). Returns null only when the hop itself can't be resolved to a real
// destination at all (autoplay dead ends, a hop naming a deleted song).
export function buildHopDecision(hop, nowPlayingId, songs, edges, currentBufferDurationSec) {
  if (!hop) return null;
  if (hop.id === END) {
    if (hop.ending !== 'outro') return { cueOffsetSec: currentBufferDurationSec, fragments: [], destSongId: null, destUrl: null, destOffsetSec: 0 };
    const edge = findOutroEdgeFor(edges, nowPlayingId, hop.edgeId);
    // An outro has no out point on the main deck — it always plays to its
    // own full natural duration; the clip's own trim (clipStartSec, below)
    // is what avoids replaying material the main deck already played, not
    // an early cutoff here.
    const fragments = edge && edge.audioUrl ? [{ url: edge.audioUrl, offsetSec: edge.clipStartSec || 0 }] : [];
    return { cueOffsetSec: currentBufferDurationSec, fragments, destSongId: null, destUrl: null, destOffsetSec: 0 };
  }
  const destSong = songs[hop.id];
  if (!destSong) return null;
  if (hop.mode === 'transition') {
    const edge = edges.find((e) => e.id === hop.edgeId);
    const cueOffsetSec = edge && edge.outSeconds != null ? edge.outSeconds : currentBufferDurationSec;
    return {
      cueOffsetSec, fragments: edge && edge.audioUrl ? [{ url: edge.audioUrl }] : [],
      destSongId: hop.id, destUrl: destSong.audioUrl || null, destOffsetSec: edge && edge.inSeconds != null ? edge.inSeconds : 0,
    };
  }
  // cut, possibly with an outro leaving the old song and/or an intro
  // starting the new one — same up-to-three-piece chain handleHandoff's
  // sequential version plays, just scheduled all at once instead. Neither
  // an outro nor an intro moves the cue point: the outro's main deck always
  // plays to its own full duration (no out point), and the destination
  // always starts at 0 (no in point) — each clip's own trim handles the
  // rest (clipStartSec/clipEndSec).
  const outroEdge = hop.ending === 'outro' ? findOutroEdgeFor(edges, nowPlayingId, hop.edgeId) : null;
  const introEdge = hop.starting === 'intro' ? edges.find((e) => e.type === 'intro' && e.r === hop.id) : null;
  const fragments = [];
  if (outroEdge && outroEdge.audioUrl) fragments.push({ url: outroEdge.audioUrl, offsetSec: outroEdge.clipStartSec || 0 });
  if (introEdge && introEdge.audioUrl) fragments.push({ url: introEdge.audioUrl, clipEndSec: introEdge.clipEndSec != null ? introEdge.clipEndSec : null });
  return { cueOffsetSec: currentBufferDurationSec, fragments, destSongId: hop.id, destUrl: destSong.audioUrl || null, destOffsetSec: 0 };
}

// The tick's job once it notices a scheduled Plan already fired in real
// audio (ctx.currentTime has passed plan.destStartCtxTime): bring session
// state into agreement with what's already true, never the other way
// around. Pure and pulled out of the tick itself specifically so it's
// directly testable without needing a live AudioContext or React — the
// actual scheduling already happened; this only has to get the
// bookkeeping right (which queue entry to consume, the history push, the
// real elapsed-since-fired time for the new countdown).
export function syncSessionFromFiredPlan(prevSession, plan, songs, ctxCurrentTime) {
  if (!prevSession.isPlaying || !prevSession.nowPlayingId) return prevSession;
  const wasQueued = prevSession.queue[0] && prevSession.queue[0].id === plan.destSongId;
  const history = [...prevSession.history, prevSession.nowPlayingId].slice(-50);
  if (plan.destSongId == null) {
    return { ...prevSession, isPlaying: false, setEnded: true, queue: [], timeLeft: 0, history };
  }
  const destSong = songs[plan.destSongId];
  const destDuration = destSong ? destSong.durationSec : 210;
  return {
    ...prevSession, nowPlayingId: plan.destSongId, history,
    queue: wasQueued ? prevSession.queue.slice(1) : prevSession.queue,
    timeLeft: Math.max(0, destDuration - (ctxCurrentTime - plan.destStartCtxTime)),
  };
}

// Shared by both the set-clock's automatic tick and the manual skip button
// (App.jsx and PerformPage.jsx respectively) — one place that both decides
// the next session state (advanceSession, core.js — unchanged) and
// performs the matching real-audio handoff, so the two call sites can
// never disagree about what a hop actually does.
//
// `forceCut` is the one deliberate exception to "never disagree": a manual
// Skip still advances to exactly the same destination the graph's wiring
// would have picked (so the session and the Next list stay honest about
// what's actually next), but it must NOT wait for or play a wired
// Transition/Outro's produced clip — the whole point of Skip is "just play
// the next song, right now, plainly", not the seamless cued handoff the
// timer's automatic path exists for. Before this flag existed, Skip called
// through to the exact same transition-clip logic as the timed cue-point
// handoff, so skipping a song mid-transition-setup would still play out the
// transition's audio first — visibly not what "skip" should mean.
export function performAdvance(prevSession, songs, edges, opts = {}) {
  const { forceCut = false } = opts;
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

  if (hop) {
    if (hop.id === END) {
      const ending = forceCut ? 'cut' : hop.ending;
      const outroEdge = ending === 'outro' ? findOutroEdgeFor(edges, nowPlayingId, hop.edgeId) : null;
      engine.handleHandoff({ hop, destSong: null, edges, ending, outroEdge });
    } else {
      const destSong = songs[hop.id];
      const mode = forceCut ? 'cut' : hop.mode;
      const ending = forceCut ? 'cut' : hop.ending;
      const starting = forceCut ? 'cut' : hop.starting;
      const outroEdge = mode === 'cut' && ending === 'outro' ? findOutroEdgeFor(edges, nowPlayingId, hop.edgeId) : null;
      const introEdge = mode === 'cut' && starting === 'intro' ? edges.find((e) => e.type === 'intro' && e.r === hop.id) : null;
      engine.handleHandoff({ hop: { ...hop, mode }, destSong, edges, ending, starting, outroEdge, introEdge });
    }
  } else if (prevSession.autoplay && next.nowPlayingId && next.nowPlayingId !== nowPlayingId) {
    const destSong = songs[next.nowPlayingId];
    const picked = next.autoHistory[next.autoHistory.length - 1];
    const mode = forceCut ? 'cut' : (picked ? picked.mode : 'cut');
    const introEdge = mode === 'cut' ? edges.find((e) => e.type === 'intro' && e.r === next.nowPlayingId) : null;
    engine.handleHandoff({ hop: { mode }, destSong, edges, starting: introEdge ? 'intro' : 'cut', introEdge });
  } else if (!next.isPlaying) {
    engine.stopAll();
  }
  return next;
}
