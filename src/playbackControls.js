import { useCallback, useEffect, useRef } from 'react';
import { introEdgeFor } from './core.js';
import { engine, performAdvance } from './audioEngine.js';

// Drives a continuous playback-position display off the real clock every
// frame — the same technique LiveWaveform (GraphNodes.jsx) already uses
// for its spectrum bars (a real reading, updated via requestAnimationFrame,
// written directly through a ref), applied here to progress/countdown
// displays too. `onFrame` should write straight to the DOM through a ref,
// never call setState — going through React re-render for a value that
// changes every frame would be the same mistake this exists to fix. See
// docs/playback-model.md sec 7. A ref (not a dependency array entry) holds
// the latest callback so passing an inline function every render doesn't
// restart the rAF loop.
export function usePlaybackFrame(onFrame) {
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  useEffect(() => {
    let raf;
    function tick() {
      onFrameRef.current(engine.getPlaybackPosition());
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

// The transport primitives (Play/Pause, Skip, Start, Stop, Back). Used to
// be hand-copied near-verbatim into both PerformPage.jsx and a second,
// now-removed flat "Live" screen — two independently maintained
// implementations of the exact same behavior, which is exactly how a fix
// (or a bug) in one silently failed to reach the other. Kept as one
// module (not folded back into PerformPage.jsx) since a single, isolated
// implementation is still easier to audit and test than logic embedded in
// a 1000-line component, even with one consumer.

// "the first few seconds" — how long into the current song Back still
// treats you as having "just arrived", and so sends you to the previous
// song instead of restarting this one. Standard previous-track behavior.
export const BACK_RESTART_THRESHOLD_SEC = 5;

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

  // A deliberate jump to an arbitrary song (the detail pane's Play button,
  // Start Set, Live's own "Start playing") — unlike startSet itself, this
  // remembers where you jumped *from* so Back can return to it. startSet
  // stays history-agnostic on its own since it's also reused by playAgain
  // (replaying the song that just ended — nothing to "go back" to) and by
  // goBack itself (which must not re-push what it's leaving).
  const jumpToSong = useCallback((songId, starting) => {
    setSession(prev => (prev.nowPlayingId
      ? { ...prev, history: [...prev.history, prev.nowPlayingId].slice(-50) }
      : prev));
    startSet(songId, starting);
  }, [startSet, setSession]);

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

  // Back: restart the current song, unless we're still within the first
  // few seconds of it and there's somewhere to go back to — then go to
  // the previous song instead. Always a plain cut, same as Skip: "when
  // playing a song from skip or back, it plays with nothing in front, no
  // intro or transition" was explicit. Computed inside the setSession
  // updater (not off outside state) the same way togglePlaying reads/
  // writes `prev` atomically, so there's no separate `session` dependency
  // to thread through the hook.
  const goBack = useCallback(() => {
    setSession(prev => {
      if (!prev.nowPlayingId) return prev;
      const song = songs[prev.nowPlayingId];
      const engineElapsed = engine.getMainElapsed(prev.nowPlayingId);
      const elapsed = engineElapsed != null ? engineElapsed : (song ? song.durationSec - prev.timeLeft : 0);
      const goToPrevious = elapsed < BACK_RESTART_THRESHOLD_SEC && prev.history.length > 0;
      const destId = goToPrevious ? prev.history[prev.history.length - 1] : prev.nowPlayingId;
      const destSong = songs[destId];
      engine.startMain(destSong, null);
      return {
        ...prev, nowPlayingId: destId, startMethod: 'cut', queue: [],
        isPlaying: true, timeLeft: destSong ? destSong.durationSec : 210, setEnded: false, nextMode: 'transition',
        history: goToPrevious ? prev.history.slice(0, -1) : prev.history,
      };
    });
  }, [songs, setSession]);

  const resumeSet = useCallback(() => {
    engine.stopAll();
    setSession(prev => ({
      ...prev, setEnded: false, isPlaying: false, nowPlayingId: null, startMethod: null,
      queue: [], timeLeft: 0, nextMode: 'transition', autoHistory: [], history: [],
    }));
  }, [setSession]);

  return { startSet, jumpToSong, togglePlaying, skipNow, goBack, resumeSet };
}
