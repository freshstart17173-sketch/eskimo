import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Store, freshState, emptySession, removeSongCascade, END, getVisibleEdges, pickAutoplayNext } from './core.js';
import Sidebar from './components/Sidebar.jsx';
import PerformPage from './components/PerformPage.jsx';
import LibraryPage from './components/Library.jsx';
import UploadSongPage from './components/UploadSong.jsx';
import AddAudioPage from './components/AddAudio.jsx';
import SettingsPage from './components/Settings.jsx';

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
      const data = { songs, edges, session, venueName };
      Store.save(data);
      Store.pushRemote(data);
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [songs, edges, session, venueName]);

  // ---- the set clock: ticks Now Playing's countdown, promotes Next when it hits 0.
  // If nothing is queued and autoplay is off, the set just ends — no looping trick to
  // paper over there being nothing next ("letting the song end naturally"). If
  // autoplay is on, pickAutoplayNext chooses instead — a built transition when one
  // exists, otherwise a random cut to keep an infinite playlist going (unless
  // transitionOnly is set, in which case a dead end still ends the set: that's the
  // "truly seamless" guarantee). ----
  useEffect(() => {
    const t = setInterval(() => {
      setSession(prev => {
        if (!prev.isPlaying || !prev.nowPlayingId) return prev;
        if (prev.timeLeft <= 1) {
          const head = prev.queue[0];
          if (!head) {
            if (prev.autoplay) {
              const pick = pickAutoplayNext(songs, getVisibleEdges(edges), prev.nowPlayingId, prev.transitionOnly);
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
          if (head.id === END) {
            return { ...prev, isPlaying: false, setEnded: true, queue: [], timeLeft: 0 };
          }
          const nextSong = songs[head.id];
          return { ...prev, nowPlayingId: head.id, queue: prev.queue.slice(1), timeLeft: nextSong ? nextSong.durationSec : 210, endingChoice: 'cut' };
        }
        return { ...prev, timeLeft: prev.timeLeft - 1 };
      });
    }, 1000);
    return () => clearInterval(t);
  }, [songs, edges]);

  const deleteSong = useCallback((songId) => {
    const result = removeSongCascade(songs, edges, songId);
    setSongs(result.songs);
    setEdges(result.edges);
    setSession(prev => {
      if (prev.nowPlayingId !== songId && !prev.queue.some(q => q.id === songId)) return prev;
      return { ...prev, queue: prev.queue.filter(q => q.id !== songId), isPlaying: prev.nowPlayingId === songId ? false : prev.isPlaying, setEnded: prev.nowPlayingId === songId ? true : prev.setEnded };
    });
  }, [edges, songs]);

  const updateSong = useCallback((songId, patch) => {
    setSongs(prev => (prev[songId] ? { ...prev, [songId]: { ...prev[songId], ...patch } } : prev));
  }, []);

  const deleteEdge = useCallback((edgeId) => {
    setEdges(prev => prev.filter(e => e.id !== edgeId));
  }, []);

  const clearAllData = useCallback(() => {
    Store.clear();
    const fresh = freshState();
    setSongs(fresh.songs); setEdges(fresh.edges); setSession(fresh.session); setVenueName(fresh.venueName);
    setTab('perform');
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
        base = { ...prev, nowPlayingId: first, startMethod: 'cut', isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, endingChoice: 'cut', queue: [] };
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

  const songCount = Object.keys(songs).length;
  const edgeCount = edges.length;

  return (
    <div className="app-shell">
      <Sidebar tab={tab} setTab={setTab} songCount={songCount} edgeCount={edgeCount} venueName={venueName} />
      <div className="main">
        {tab === 'perform' && (
          <ReactFlowProvider>
            <PerformPage
              songs={songs} setSongs={setSongs} edges={edges} session={session} setSession={setSession}
              venueName={venueName} goUpload={() => setTab('upload')}
            />
          </ReactFlowProvider>
        )}
        {tab === 'library' && (
          <LibraryPage songs={songs} edges={edges} goUpload={() => setTab('upload')}
            onUpdateSong={updateSong} onDeleteSong={deleteSong} onDeleteEdge={deleteEdge}
            onQueueSongs={queueSongsAsPlaylist}
          />
        )}
        {tab === 'upload' && (
          <UploadSongPage
            onAddSong={(song) => setSongs(prev => ({ ...prev, [song.id]: song }))}
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
          />
        )}
      </div>
    </div>
  );
}
