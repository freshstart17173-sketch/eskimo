import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import { Store, freshState, emptySession, removeSongCascade, sampleSongsForTests, sampleEdgesForTests, END, getVisibleEdges, advanceSession, transitionTriggerElapsed } from './core.js';
import Sidebar from './components/Sidebar.jsx';

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
const loaded = Store.load();
const INITIAL = loaded ? { ...freshState(), ...loaded, session: { ...emptySession(), ...(loaded.session || {}) } } : freshState();

export default function App() {
  const [songs, setSongs] = useState(INITIAL.songs);
  const [edges, setEdges] = useState(INITIAL.edges);
  const [session, setSession] = useState(INITIAL.session);
  const [venueName, setVenueName] = useState(INITIAL.venueName);
  const [isDemo, setIsDemo] = useState(!!INITIAL.isDemo);

  const [tab, setTab] = useState('perform');

  // ---- pull anything saved on another device once, on boot (no-op until Supabase is configured) ----
  useEffect(() => {
    Store.pullRemote().then(remote => {
      if (remote && typeof remote === 'object') {
        if (remote.songs) setSongs(remote.songs);
        if (remote.edges) setEdges(remote.edges);
        if (remote.session) setSession({ ...emptySession(), ...remote.session });
        if (typeof remote.venueName === 'string') setVenueName(remote.venueName);
      }
    });
  }, []);

  // ---- debounced persistence: local write is instant, remote push is best-effort ----
  const saveTimer = useRef(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const data = { songs, edges, session, venueName, isDemo };
      Store.save(data);
      Store.pushRemote(data);
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [songs, edges, session, venueName, isDemo]);

  // ---- the set clock: ticks Now Playing's countdown, then hands off to
  // advanceSession (core.js) — the same function a manual "Next song" click
  // uses — once transitionTriggerElapsed says it's time, so the timer and
  // the button can never disagree about what happens next. Critically,
  // that trigger point is the committed transition's real cue point when
  // one exists — not the full song length — so the handoff actually
  // happens where the produced transition was built to happen. ----
  useEffect(() => {
    const t = setInterval(() => {
      setSession(prev => {
        if (!prev.isPlaying || !prev.nowPlayingId) return prev;
        const nowSong = songs[prev.nowPlayingId];
        const duration = nowSong ? nowSong.durationSec : 210;
        const elapsed = duration - prev.timeLeft;
        const triggerAt = transitionTriggerElapsed(prev.queue[0], edges, duration);
        if (elapsed >= triggerAt || prev.timeLeft <= 1) return advanceSession(prev, songs, getVisibleEdges(edges));
        return { ...prev, timeLeft: prev.timeLeft - 1 };
      });
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
      if (prev.nowPlayingId !== songId && !prev.queue.some(q => q.id === songId)) return prev;
      return { ...prev, queue: prev.queue.filter(q => q.id !== songId), isPlaying: prev.nowPlayingId === songId ? false : prev.isPlaying, setEnded: prev.nowPlayingId === songId ? true : prev.setEnded };
    });
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
    Store.clear();
    const fresh = freshState();
    setSongs(fresh.songs); setEdges(fresh.edges); setSession(fresh.session); setVenueName(fresh.venueName);
    setIsDemo(false);
    setTab('perform');
  }, []);

  // Guided first-run: a brand-new library is correctly seed-data-free, but
  // that also means a new producer opens the app to nothing. One click
  // loads a small example graph instead of a blank canvas — clearly marked
  // (see the demo banner below) and, per its own rule, never mixed into a
  // real library: the first real song/audio added while it's showing wipes
  // the example first, regardless of which page that add happens from.
  const loadExample = useCallback(() => {
    setSongs(sampleSongsForTests());
    setEdges(sampleEdgesForTests());
    setSession(emptySession());
    setVenueName(v => v || 'Example set');
    setIsDemo(true);
    setTab('perform');
  }, []);
  const clearExample = useCallback(() => {
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
              venueName={venueName} goUpload={() => setTab('upload')} onLoadExample={loadExample}
            />
          )}
          {tab === 'library' && (
            <LibraryPage songs={songs} edges={edges} goUpload={() => setTab('upload')}
              onUpdateSong={updateSong} onDeleteSong={deleteSong} onDeleteEdge={deleteEdge}
              onQueueSongs={queueSongsAsPlaylist} onLoadExample={loadExample}
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
              songs={songs}
              onAddEdge={(edge) => setEdges(prev => [...prev, edge])}
              onViewSong={() => setTab('library')}
            />
          )}
          {tab === 'settings' && (
            <SettingsPage
              venueName={venueName} setVenueName={setVenueName}
              songs={songs} edges={edges} session={session}
              onClearAll={clearAllData}
              onRestore={(data) => { setSongs(data.songs); setEdges(data.edges); setSession(data.session); setVenueName(data.venueName); }}
              onSetAutoplay={setAutoplay} onSetTransitionOnly={setTransitionOnly}
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
    </div>
  );
}
