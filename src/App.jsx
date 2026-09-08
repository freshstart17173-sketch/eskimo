import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import { Store, freshState, emptySession, removeSongCascade, removeSongFromPlaylist, playlistNextHop, sampleSongsForTests, sampleEdgesForTests, END, getVisibleEdges, transitionTriggerElapsed, autoconnectFullGraph } from './core.js';
import { engine, performAdvance, prefetchHop, PREFETCH_LOOKAHEAD_SEC, buildHopDecision, syncSessionFromFiredPlan } from './audioEngine.js';
import { isCrateSyncConfigured, createCrate, fetchCrateLibrary, subscribeCrateLibrary, pushCrateSong, deleteCrateSong, pushCrateEdge, deleteCrateEdge } from './crateStore.js';
import Sidebar from './components/Sidebar.jsx';

// A shared crate is addressed by a URL, checked once at boot — see
// docs/live-crate-collab-design.md. Deliberately a completely separate
// code path from the personal library below, not a variant of it: a
// crate has no relationship to whatever this browser's own solo library
// is, and must never read from or write into it (spec requirement 9).
const CRATE_ID = new URLSearchParams(window.location.search).get('crate') || null;
const CRATE_SESSION_KEY = CRATE_ID ? 'djflow:crate:' + CRATE_ID : null;
function loadCrateSession() {
  if (!CRATE_SESSION_KEY) return null;
  try {
    const raw = localStorage.getItem(CRATE_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Lazy — each page's own module (and, for Perform, @xyflow/react + dagre +
// Fuse.js on top) only downloads once its tab is actually opened, instead
// of every page's code paying for Perform's graph-canvas dependencies on
// first load regardless of which tab loads first.
const PerformPage = lazy(() => import('./components/PerformPage.jsx'));
const LibraryPage = lazy(() => import('./components/Library.jsx'));
const UploadSongPage = lazy(() => import('./components/UploadSong.jsx'));
const AddAudioPage = lazy(() => import('./components/AddAudio.jsx'));
const SettingsPage = lazy(() => import('./components/Settings.jsx'));

// Merge onto a fresh default rather than trusting the saved shape wholesale —
// older saved sessions predate fields like autoplay/autoHistory, and a
// missing field should fall back cleanly instead of crashing downstream.
//
// isPlaying is forced false regardless of what was persisted: a reload
// tears down the AudioContext entirely, so if the tab closed mid-set
// there is genuinely nothing sounding anymore — claiming isPlaying:true
// here would be the session lying about what's audible, which is exactly
// the class of bug (session vs. engine disagreeing about the truth) this
// whole rewrite exists to eliminate. It also used to be the seed of a
// real race: the tick would immediately start running against an engine
// with nothing anchored (see docs/playback-model.md's reload-seek
// finding), so a seek right after reload could get silently overwritten
// by the tick's stale wall-clock fallback. Forcing it false means no tick
// runs at all until the user genuinely presses Play again — see the
// mount effect below (restores a cosmetic position only) and
// togglePlaying (playbackControls.js, restores a real one on demand).
// A crate starts from nothing (songs/edges arrive from the crate fetch
// effect below, once it resolves) except its own local-only session —
// the personal `loaded` blob below is never consulted at all in crate
// mode, per requirement 9.
const loaded = CRATE_ID ? null : Store.load();
const INITIAL = CRATE_ID
  ? { ...freshState(), session: { ...emptySession(), ...(loadCrateSession() || {}), isPlaying: false } }
  : loaded ? { ...freshState(), ...loaded, session: { ...emptySession(), ...(loaded.session || {}), isPlaying: false } } : freshState();

export default function App() {
  const [songs, setSongs] = useState(INITIAL.songs);
  const [edges, setEdges] = useState(INITIAL.edges);
  const [session, setSession] = useState(INITIAL.session);
  const [venueName, setVenueName] = useState(INITIAL.venueName);
  const [isDemo, setIsDemo] = useState(!!INITIAL.isDemo);
  const [playlists, setPlaylists] = useState(INITIAL.playlists || []);

  const [tab, setTab] = useState('perform');

  // ---- pull anything saved on another device once, on boot (no-op until Supabase is configured) ----
  // Never runs in crate mode — a crate has no relationship to this
  // browser's own personal library (requirement 9).
  useEffect(() => {
    if (CRATE_ID) return;
    Store.pullRemote().then(remote => {
      if (remote && typeof remote === 'object') {
        if (remote.songs) setSongs(remote.songs);
        if (remote.edges) setEdges(remote.edges);
        if (remote.session) setSession({ ...emptySession(), ...remote.session });
        if (typeof remote.venueName === 'string') setVenueName(remote.venueName);
        if (Array.isArray(remote.playlists)) setPlaylists(remote.playlists);
      }
    });
  }, []);

  // ---- shared crate: initial fetch + live incremental updates ----
  // Completely separate from the personal sync above — see
  // docs/live-crate-collab-design.md. `remoteOriginRef` tracks which
  // song/edge ids' most recent change came from another collaborator
  // (via the realtime subscription) rather than a local edit, so the
  // diff-push effect below doesn't immediately write them straight back
  // to the crate — that would still be harmless (an identical row upsert),
  // just a perpetual, pointless echo of realtime events between every
  // connected client.
  const remoteOriginRef = useRef({ songs: new Set(), edges: new Set() });
  useEffect(() => {
    if (!CRATE_ID || !isCrateSyncConfigured) return;
    let cancelled = false;
    fetchCrateLibrary(CRATE_ID).then(lib => {
      if (cancelled || !lib) return;
      setSongs(lib.songs);
      setEdges(lib.edges);
    });
    const unsubscribe = subscribeCrateLibrary(CRATE_ID, {
      onSong: (song) => {
        remoteOriginRef.current.songs.add(song.id);
        setSongs(prev => ({ ...prev, [song.id]: song }));
      },
      onSongDelete: (songId) => {
        remoteOriginRef.current.songs.add(songId);
        setSongs(prev => { if (!(songId in prev)) return prev; const next = { ...prev }; delete next[songId]; return next; });
      },
      onEdge: (edge) => {
        remoteOriginRef.current.edges.add(edge.id);
        setEdges(prev => (prev.some(e => e.id === edge.id) ? prev.map(e => (e.id === edge.id ? edge : e)) : [...prev, edge]));
      },
      onEdgeDelete: (edgeId) => {
        remoteOriginRef.current.edges.add(edgeId);
        setEdges(prev => prev.filter(e => e.id !== edgeId));
      },
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // ---- shared crate: push local song/edge changes, whatever triggered
  // them (a direct upload, a drag, Autoarrange, Autoconnect, an undo — every
  // one of them already flows through setSongs/setEdges, so diffing here
  // covers all of them without needing to touch each call site). Reference-
  // equality diff against the previous render's objects — correct as long
  // as every update creates new object identities for what actually
  // changed and reuses old ones for what didn't, which is already how
  // every setSongs/setEdges call in this codebase works. ----
  const prevCrateSongsRef = useRef(songs);
  const prevCrateEdgesRef = useRef(edges);
  useEffect(() => {
    if (!CRATE_ID || !isCrateSyncConfigured) return;
    const prevSongs = prevCrateSongsRef.current;
    if (songs !== prevSongs) {
      Object.keys(songs).forEach(id => {
        if (songs[id] === prevSongs[id]) return;
        if (remoteOriginRef.current.songs.delete(id)) return;
        pushCrateSong(CRATE_ID, songs[id]);
      });
      Object.keys(prevSongs).forEach(id => {
        if (id in songs) return;
        if (remoteOriginRef.current.songs.delete(id)) return;
        deleteCrateSong(CRATE_ID, id);
      });
      prevCrateSongsRef.current = songs;
    }
    const prevEdges = prevCrateEdgesRef.current;
    if (edges !== prevEdges) {
      const prevById = new Map(prevEdges.map(e => [e.id, e]));
      const nextById = new Map(edges.map(e => [e.id, e]));
      nextById.forEach((edge, id) => {
        if (prevById.get(id) === edge) return;
        if (remoteOriginRef.current.edges.delete(id)) return;
        pushCrateEdge(CRATE_ID, edge);
      });
      prevById.forEach((_edge, id) => {
        if (nextById.has(id)) return;
        if (remoteOriginRef.current.edges.delete(id)) return;
        deleteCrateEdge(CRATE_ID, id);
      });
      prevCrateEdgesRef.current = edges;
    }
  }, [songs, edges]);

  // ---- restore a cosmetic (not real) position after a reload ----
  // isPlaying was just forced false above regardless of what was
  // persisted, but nowPlayingId/timeLeft still describe wherever the set
  // actually was — worth showing correctly (the scrub bar, the countdown
  // rings) rather than snapping to 0 until Play is pressed again. This is
  // deliberately NOT an attempt to resume real audio: that needs an
  // actual buffer load and a fresh user gesture, both of which
  // togglePlaying (playbackControls.js) handles the moment Play is
  // actually pressed. Runs once, before the tick loop below ever
  // considers `session.nowPlayingId` (isPlaying is false, so it won't
  // anyway) — see engine.restoreCosmeticPosition's own comment and
  // docs/playback-model.md's reload-seek finding for why this exists.
  useEffect(() => {
    if (session.nowPlayingId) {
      const song = songs[session.nowPlayingId];
      if (song) engine.restoreCosmeticPosition(song, song.durationSec - session.timeLeft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- debounced persistence: local write is instant, remote push is best-effort ----
  // In crate mode this only ever persists `session` (graph wiring +
  // playback), and only to a crate-scoped local key — songs/edges are the
  // crate's own shared state (pushed by the diff effect above), and
  // `session` here is never sent to the crate at all, which is what makes
  // spec requirement 10 (a remote edit can never touch anyone's live
  // performance state) true by construction rather than something this
  // code has to actively guard.
  const [saveError, setSaveError] = useState(false);
  const saveTimer = useRef(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (CRATE_ID) {
        try { localStorage.setItem(CRATE_SESSION_KEY, JSON.stringify(session)); } catch (e) { setSaveError(true); }
        return;
      }
      const data = { songs, edges, session, venueName, isDemo, playlists };
      // Store.save already logs a console warning on failure (e.g. a
      // localStorage quota error) — that alone is easy to miss for days
      // while every change since silently stops persisting, so surface it
      // as a real, impossible-to-miss banner too instead of only a devtools
      // line.
      setSaveError(!Store.save(data));
      Store.pushRemote(data);
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [songs, edges, session, venueName, isDemo, playlists]);

  // ---- the set clock. Two different mechanisms depending on whether Now
  // Playing has real, sounding audio right now — see docs/playback-model.md
  // sec 6 for the full design:
  //
  // Real audio: a hop is scheduled against AudioContext's own clock the
  // moment it's known (engine.scheduleHop), not reactively once this tick
  // notices a cue point has arrived — the browser's audio thread carries
  // out the splice at its exact precomputed time regardless of anything
  // happening here afterward. This tick's only job for that case is
  // noticing, after the fact, that a scheduled hop already fired
  // (ctx.currentTime has passed it) and syncing session state to match,
  // plus keeping the displayed countdown numbers current in the meantime.
  // It is never the thing deciding *when* real audio happens anymore.
  //
  // No real audio for Now Playing (nothing uploaded): there's no
  // AudioContext clock to schedule against, so this falls back to exactly
  // the reactive wall-clock path this tick used unconditionally before —
  // measure real time between ticks, hand off via performAdvance once
  // elapsed crosses the trigger point.
  //
  // Kept at the same 1000ms cadence as before: each tick producing a new
  // session object resets the save-effect's 400ms debounce below, so a
  // shorter period would starve it and nothing would persist while a set
  // plays. sessionRef mirrors the latest session so this can read it
  // without going through setSession's updater — scheduling is a real
  // side effect (creates/cancels Web Audio nodes), and an updater function
  // must stay pure since React can invoke it more than once. ----
  const lastTickAtRef = useRef(Date.now());
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const scheduledHopKeyRef = useRef(null);
  useEffect(() => {
    lastTickAtRef.current = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const dtSec = Math.max(0, (now - lastTickAtRef.current) / 1000);
      lastTickAtRef.current = now;
      const prev = sessionRef.current;
      if (!prev.isPlaying || !prev.nowPlayingId) return;
      const nowSong = songs[prev.nowPlayingId];
      const duration = nowSong ? nowSong.durationSec : 210;
      const visibleEdges = getVisibleEdges(edges);
      const effectiveHead = prev.queue[0] || playlistNextHop(prev.activePlaylist, prev.nowPlayingId);

      // A previously scheduled hop already fired in real audio — sync
      // session state to match what's already true, then let the next
      // tick schedule whatever comes after (once state has settled).
      const plan = engine._plan;
      if (plan && engine.ctx && engine.ctx.currentTime >= plan.destStartCtxTime) {
        const ctxNow = engine.ctx.currentTime;
        engine.consumePlan(plan);
        scheduledHopKeyRef.current = null;
        setSession(p => syncSessionFromFiredPlan(p, plan, songs, ctxNow));
        return;
      }

      const hasRealMainDeck = engine._current && engine._current.kind === 'main' && engine._current.songId === prev.nowPlayingId;

      if (!hasRealMainDeck) {
        // No real audio to schedule against for Now Playing — exactly the
        // reactive wall-clock path this tick always used before.
        const engineElapsed = engine.getMainElapsed(prev.nowPlayingId);
        const elapsed = engineElapsed != null ? engineElapsed : Math.max(0, (duration - prev.timeLeft) + dtSec);
        const triggerAt = transitionTriggerElapsed(effectiveHead, edges, duration);
        if (elapsed >= triggerAt || elapsed >= duration - 0.05) { setSession(p => performAdvance(p, songs, visibleEdges)); return; }
        if (triggerAt - elapsed <= PREFETCH_LOOKAHEAD_SEC) prefetchHop(effectiveHead, prev.nowPlayingId, edges, songs);
        setSession(p => (p.isPlaying && p.nowPlayingId ? { ...p, timeLeft: Math.max(0, duration - elapsed) } : p));
        return;
      }

      // Real audio is playing: keep the schedule up to date and update the
      // displayed countdown off the real clock. Re-schedule whenever there
      // is no pending plan at all (nothing scheduled yet, or one was just
      // cancelled externally by a seek/skip/startSet) or the known hop
      // itself changed (rewired mid-set, a fresh manual commit) —
      // scheduleHop's own token guards against this racing an in-flight
      // buffer load. Scheduling itself never depends on this tick firing
      // on time — a late tick only delays *noticing* a hop already
      // happened, never delays the hop.
      const key = effectiveHead ? [effectiveHead.id, effectiveHead.mode, effectiveHead.edgeId || '', effectiveHead.ending || '', effectiveHead.starting || ''].join('|') : null;
      if (!engine._plan || key !== scheduledHopKeyRef.current) {
        scheduledHopKeyRef.current = key;
        if (key) engine.scheduleHop(buildHopDecision(effectiveHead, prev.nowPlayingId, songs, edges, engine._current.buffer.duration));
        else engine.cancelPlan();
      }
      const elapsedNow = engine.getMainElapsed(prev.nowPlayingId);
      if (elapsedNow != null) {
        setSession(p => (p.isPlaying && p.nowPlayingId === prev.nowPlayingId ? { ...p, timeLeft: Math.max(0, duration - elapsedNow) } : p));
      }
    }, 1000);
    return () => clearInterval(t);
  }, [songs, edges]);

  const setAutoplay = useCallback((on) => setSession(prev => ({ ...prev, autoplay: on })), []);
  const setTransitionOnly = useCallback((on) => setSession(prev => ({ ...prev, transitionOnly: on })), []);

  // One-level undo for song/edge deletion: delete happens immediately, no
  // blocking confirm — a toast holds a snapshot of everything from just
  // before the delete and restores it wholesale if clicked in time.
  const [undoToast, setUndoToast] = useState(null); // { message, snapshot: { songs, edges, session } } | null
  const undoTimerRef = useRef(null);
  useEffect(() => () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); }, []);

  const showUndoToast = useCallback((message, snapshot) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoToast({ message, snapshot });
    undoTimerRef.current = setTimeout(() => setUndoToast(null), 6000);
  }, []);

  const undoDelete = useCallback(() => {
    setUndoToast(current => {
      if (!current) return current;
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setSongs(current.snapshot.songs);
      setEdges(current.snapshot.edges);
      setSession(current.snapshot.session);
      return null;
    });
  }, []);

  const deleteSong = useCallback((songId) => {
    const snapshot = { songs, edges, session };
    const song = songs[songId];
    const result = removeSongCascade(songs, edges, songId);
    setSongs(result.songs);
    setEdges(result.edges);
    setSession(prev => {
      const activePlaylist = removeSongFromPlaylist(prev.activePlaylist, songId);
      if (prev.nowPlayingId !== songId && !prev.queue.some(q => q.id === songId)) return { ...prev, activePlaylist };
      if (prev.nowPlayingId === songId) engine.stopAll();
      return { ...prev, activePlaylist, queue: prev.queue.filter(q => q.id !== songId), isPlaying: prev.nowPlayingId === songId ? false : prev.isPlaying, setEnded: prev.nowPlayingId === songId ? true : prev.setEnded };
    });
    // A saved playlist referencing a now-deleted song would otherwise sit
    // there silently broken until someone tried to load it.
    setPlaylists(prev => prev.map(p => removeSongFromPlaylist(p, songId)));
    showUndoToast('Deleted "' + (song ? song.title : 'that song') + '"', snapshot);
  }, [edges, songs, session, showUndoToast]);

  const updateSong = useCallback((songId, patch) => {
    setSongs(prev => (prev[songId] ? { ...prev, [songId]: { ...prev[songId], ...patch } } : prev));
  }, []);

  const deleteEdge = useCallback((edgeId) => {
    const snapshot = { songs, edges, session };
    const edge = edges.find(e => e.id === edgeId);
    const label = edge ? ({ outro: 'Outro', intro: 'Intro' }[edge.type] || 'Transition') : 'Audio piece';
    setEdges(prev => prev.filter(e => e.id !== edgeId));
    showUndoToast(label + ' removed', snapshot);
  }, [edges, songs, session, showUndoToast]);

  const clearAllData = useCallback(() => {
    engine.stopAll();
    Store.clear();
    const fresh = freshState();
    setSongs(fresh.songs); setEdges(fresh.edges); setSession(fresh.session); setVenueName(fresh.venueName);
    setPlaylists(fresh.playlists);
    setIsDemo(false);
    setTab('perform');
  }, []);

  // Turns the current personal library into a shared crate: creates the
  // crate row, seeds it with everything currently in this library (so
  // whoever opens the link first sees your existing songs, not an empty
  // pool), then reloads into crate mode on that new URL — from this point
  // on this browser is just another collaborator on the crate, same as
  // anyone else who opens the link (see docs/live-crate-collab-design.md).
  const [creatingCrate, setCreatingCrate] = useState(false);
  const startSharedCrate = useCallback(async () => {
    setCreatingCrate(true);
    const id = await createCrate();
    if (!id) { setCreatingCrate(false); return; }
    await Promise.all([
      ...Object.values(songs).map(s => pushCrateSong(id, s)),
      ...edges.map(e => pushCrateEdge(id, e)),
    ]);
    window.location.href = window.location.pathname + '?crate=' + id;
  }, [songs, edges]);

  // Guided first-run: a brand-new library is correctly seed-data-free, but
  // that also means a new producer opens the app to nothing. One click
  // loads a small example graph instead of a blank canvas — clearly marked
  // (see the demo banner below) and, per its own rule, never mixed into a
  // real library: the first real song/audio added while it's showing wipes
  // the example first, regardless of which page that add happens from.
  const loadExample = useCallback(() => {
    const exampleSongs = sampleSongsForTests();
    const exampleEdges = sampleEdgesForTests();
    setSongs(exampleSongs);
    setEdges(exampleEdges);
    // Pre-wired, not just structurally available — autoconnecting every
    // produced transition at once means the example actually demonstrates
    // its own multi-input/output/loop wiring (see sampleEdgesForTests'
    // own comment) the moment it loads, rather than handing over 50 songs
    // of hollow, unwired sockets to build by hand first.
    const base = emptySession();
    const activePlaylist = autoconnectFullGraph(getVisibleEdges(exampleEdges), base.activePlaylist, Object.keys(exampleSongs));
    setSession({ ...base, activePlaylist });
    setVenueName(v => v || 'Example set');
    setIsDemo(true);
    setTab('perform');
  }, []);
  // Suppressed inside a shared crate: an empty crate's own "load an
  // example graph" prompt would push 50 fake demo songs straight into
  // the shared pool for every collaborator, not just a private local
  // preview — the whole point of the crate is the real, contributed
  // library, so this onboarding affordance doesn't belong there at all.
  const loadExampleProp = CRATE_ID ? undefined : loadExample;
  const clearExample = useCallback(() => {
    engine.stopAll();
    const fresh = freshState();
    setSongs(fresh.songs); setEdges(fresh.edges); setSession(fresh.session);
    setVenueName(v => (v === 'Example set' ? '' : v));
    setIsDemo(false);
  }, []);

  // Select a run of songs in Library, in the order you want them played,
  // and queue the whole thing in one go instead of staging one at a time.
  // Uses a built transition between consecutive picks where one exists,
  // otherwise a cut — same as choosing one at a time would, just batched.
  const queueSongsAsPlaylist = useCallback((orderedIds) => {
    if (orderedIds.length === 0) return;
    const visibleEdges = getVisibleEdges(edges);
    const hasTransition = (a, b) => visibleEdges.some(e => e.type === 'transition' && e.l === a && e.r === b);
    setSession(prev => {
      let base = prev, startIdx = 0;
      if (!prev.nowPlayingId) {
        const first = orderedIds[0];
        const song = songs[first];
        engine.startMain(song, null);
        base = { ...prev, nowPlayingId: first, startMethod: 'cut', isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, nextMode: 'transition', queue: [] };
        startIdx = 1;
      }
      const newItems = [];
      let prevId = base.nowPlayingId;
      for (let i = startIdx; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        newItems.push(hasTransition(prevId, id) ? { id, mode: 'transition' } : { id, mode: 'cut', ending: 'cut', starting: 'cut' });
        prevId = id;
      }
      return { ...base, queue: [...base.queue, ...newItems] };
    });
    setTab('perform');
  }, [edges, songs]);

  // The one real entry point for a song joining the library — guard it so
  // an example graph never ends up blended with the user's own songs: the
  // first real upload while the example is showing clears it first.
  const addSong = useCallback((song) => {
    if (isDemo) { clearExample(); setSongs({ [song.id]: song }); return; }
    setSongs(prev => ({ ...prev, [song.id]: song }));
  }, [isDemo, clearExample]);

  const songCount = Object.keys(songs).length;
  const edgeCount = edges.length;

  return (
    <div className="app-shell">
      <Sidebar tab={tab} setTab={setTab} songCount={songCount} edgeCount={edgeCount} venueName={venueName} />
      <div className="main">
        {isDemo && (
          <div className="demo-banner">
            <span>You're viewing an example graph — nothing here is saved to a real library.</span>
            <button className="btn btn-ghost btn-sm" onClick={clearExample}>Start your own</button>
          </div>
        )}
        <Suspense fallback={<div className="page-loading" />}>
          {tab === 'perform' && (
            <PerformPage
              songs={songs} setSongs={setSongs} edges={edges} session={session} setSession={setSession}
              venueName={venueName} goUpload={() => setTab('upload')} goLibrary={() => setTab('library')} onLoadExample={loadExampleProp}
            />
          )}
          {tab === 'library' && (
            <LibraryPage songs={songs} edges={edges} goUpload={() => setTab('upload')}
              onUpdateSong={updateSong} onDeleteSong={deleteSong} onDeleteEdge={deleteEdge}
              onQueueSongs={queueSongsAsPlaylist} onLoadExample={loadExampleProp}
            />
          )}
          {tab === 'upload' && (
            <UploadSongPage
              onAddSong={addSong}
              onViewSong={() => setTab('library')}
              existingCount={songCount}
            />
          )}
          {tab === 'addAudio' && (
            <AddAudioPage
              songs={songs} edges={edges}
              onAddEdge={(edge) => setEdges(prev => [...prev, edge])}
              onViewSong={() => setTab('library')}
              goUpload={() => setTab('upload')}
              onLoadExample={loadExampleProp}
            />
          )}
          {tab === 'settings' && (
            <SettingsPage
              venueName={venueName} setVenueName={setVenueName}
              songs={songs} edges={edges} session={session} playlists={playlists}
              onClearAll={clearAllData}
              onRestore={(data) => { setSongs(data.songs); setEdges(data.edges); setSession(data.session); setVenueName(data.venueName); setPlaylists(Array.isArray(data.playlists) ? data.playlists : []); }}
              onSetAutoplay={setAutoplay} onSetTransitionOnly={setTransitionOnly}
              crateId={CRATE_ID} isCrateSyncConfigured={isCrateSyncConfigured}
              onStartSharedCrate={startSharedCrate} creatingCrate={creatingCrate}
            />
          )}
        </Suspense>
      </div>

      {undoToast && (
        <div className="toast">
          <span className="toast-message">{undoToast.message}</span>
          <button className="btn btn-ghost btn-sm" onClick={undoDelete}>Undo</button>
        </div>
      )}

      {saveError && (
        <div className="toast toast-danger">
          <span className="toast-message">Couldn't save — storage is full. Your last change isn't saved; a reload may lose it.</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setSaveError(false)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
