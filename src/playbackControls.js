import { useCallback } from 'react';
import { introEdgeFor } from './core.js';
import { engine, performAdvance } from './audioEngine.js';

// The transport primitives (Play/Pause, Skip, Start, Stop) used to be
// hand-copied near-verbatim into both PerformPage.jsx (the graph) and
// LivePerformPage.jsx (the flat live screen) — two independently
// maintained implementations of the exact same behavior. That's exactly
// how a fix (or a bug) in one screen silently fails to apply to the other:
// a change made here once instead of "the same edit, twice, and don't
// forget the second one" is the actual fix for that whole class of drift,
// not just this round's bugs.
export function useTransportControls({ songs, visibleEdges, setSession }) {
  // Starting a set from `songId` — used for a cold Start Set, the detail
  // pane's Play button, and "Play again" after a dead end. Always a full,
  // clean engine.startMain plus a session reset (queue, timeLeft, etc), so
  // jumping to an arbitrary song behaves exactly like starting fresh there.
  const startSet = useCallback((songId, starting) => {
    const song = songs[songId];
    const introEdge = starting === 'intro' ? introEdgeFor(visibleEdges, songId) : null;
    engine.startMain(song, introEdge);
    setSession(prev => ({
      ...prev, nowPlayingId: songId, startMethod: starting,
      queue: [], isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, nextMode: 'transition',
    }));
  }, [songs, visibleEdges, setSession]);

  const togglePlaying = useCallback(() => {
    setSession(prev => {
      const isPlaying = !prev.isPlaying;
      if (isPlaying) engine.resume(); else engine.pause();
      return { ...prev, isPlaying };
    });
  }, [setSession]);

  // Skip forces a plain cut to whatever's next (see performAdvance's
  // `forceCut`) — it must never wait for or play a wired transition/outro's
  // produced clip, that's the whole point of the automatic timed handoff
  // instead.
  const skipNow = useCallback(() => {
    setSession(prev => performAdvance(prev, songs, visibleEdges, { forceCut: true }));
  }, [songs, visibleEdges, setSession]);

  const resumeSet = useCallback(() => {
    engine.stopAll();
    setSession(prev => ({
      ...prev, setEnded: false, isPlaying: false, nowPlayingId: null, startMethod: null,
      queue: [], timeLeft: 0, nextMode: 'transition', autoHistory: [],
    }));
  }, [setSession]);

  return { startSet, togglePlaying, skipNow, resumeSet };
}
