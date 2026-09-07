import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import Fuse from 'fuse.js';
import {
  END, START, getVisibleEdges, inOutCounts, queueTailId, removeQueueItem,
  transitionCandidates, cutCandidates, clamp, leftSocketAvailability, rightSocketAvailability,
  unwireOutput, wireConnection, wireStart, unwireStart, disconnectAllWires, playlistNextHop, transitionEdgesBetween, introEdgeFor, outroEdgeFor,
  introEdgesFor, outroEdgesFor, setStartVariant, setEndVariant, fmtTime, uid, mockDuration, uploadAudioIfConfigured, uploadCoverIfPossible,
} from '../core.js';
import { engine, performAdvance } from '../audioEngine.js';
import { analyzeAudio } from '../audioAnalyze.js';
import { computeDagreLayout, NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import GraphPane from './GraphPane.jsx';
import { Icon, ICONS, ConfirmModal, Field, Dropzone, CoverPicker, AlbumArt } from './shared.jsx';
import { Playhead } from './SequencePane.jsx';

// The Provider wrapper lives here (not App.jsx) so @xyflow/react — React
// Flow, dagre's graph layout, Fuse.js search, this whole module — only
// downloads once this page is actually opened (see App.jsx's React.lazy).
export default function PerformPage(props) {
  return (
    <ReactFlowProvider>
      <PerformPageInner {...props} />
    </ReactFlowProvider>
  );
}

function PerformPageInner({ songs, setSongs, edges, session, setSession, venueName, goUpload, goLibrary, onLoadExample, onDeleteSong }) {
  const rf = useReactFlow();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [hoveredId, setHoveredId] = useState(null);
  const searchInputRef = useRef(null);
  const [endSetModalOpen, setEndSetModalOpen] = useState(false);
  const [endSetEnding, setEndSetEnding] = useState('cut');
  // Which song is picked in the "Start the set" card — lifted up from
  // SequencePane (rather than living as that component's own state) so a
  // click on the graph can select a song too, not just the search box.
  const [startPickId, setStartPickId] = useState(null);
  // The player bar's volume slider — reads the engine's own stored value on
  // mount so it doesn't reset to 100% every time this page remounts.
  const [volume, setVolumeState] = useState(() => engine.getVolume());
  const handleVolumeChange = useCallback((v) => { engine.setVolume(v); setVolumeState(v); }, []);
  // Right-click context menus (empty canvas vs. a specific node) — one
  // piece of state, null when closed, `{ kind: 'pane'|'node', screenX,
  // screenY, flowX, flowY, nodeId, nodeType }` when open. `screenX/Y`
  // position the popover itself (fixed, viewport coordinates from the
  // click); `flowX/Y` (pane menu only) are where "Add song here" should
  // actually place the new song, in the canvas's own coordinate space.
  const [contextMenu, setContextMenu] = useState(null);
  const [addSongAt, setAddSongAt] = useState(null); // { x, y } in flow space, or null when the modal's closed

  const onPaneContextMenu = useCallback((event) => {
    event.preventDefault();
    const flowPos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setContextMenu({ kind: 'pane', screenX: event.clientX, screenY: event.clientY, flowX: flowPos.x, flowY: flowPos.y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf]);
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();
    setContextMenu({ kind: 'node', screenX: event.clientX, screenY: event.clientY, nodeId: node.id, nodeType: node.type });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const hasStarted = session.nowPlayingId !== null;
  const visibleEdges = useMemo(() => getVisibleEdges(edges), [edges]);
  const transitionEdgesRaw = useMemo(() => visibleEdges.filter(e => e.type === 'transition'), [visibleEdges]);
  const isTransitionMode = session.nextMode === 'transition';

  const fromId = useMemo(
    () => (hasStarted ? queueTailId(session.nowPlayingId, session.queue) : null),
    [hasStarted, session.nowPlayingId, session.queue]
  );

  const usedIds = useMemo(() => new Set([session.nowPlayingId, ...session.queue.map(q => q.id)]), [session.nowPlayingId, session.queue]);

  const findEdge = useCallback((pred) => visibleEdges.find(pred), [visibleEdges]);

  const ioById = useMemo(() => {
    const m = {};
    Object.keys(songs).forEach(id => { m[id] = inOutCounts(edges, id); });
    return m;
  }, [songs, edges]);

  const hasOutroForPlaying = !!findEdge(e => e.type === 'outro' && e.l === session.nowPlayingId);

  // An outro chosen for a previous song doesn't necessarily carry over —
  // fall back to a hard cut the moment the new Now Playing doesn't have one,
  // rather than silently disabling an ending that's still "selected".
  useEffect(() => {
    if (session.nextMode === 'outro' && !hasOutroForPlaying) {
      setSession(prev => (prev.nextMode === 'outro' ? { ...prev, nextMode: 'cut' } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.nowPlayingId, hasOutroForPlaying]);

  // ---------------- the manual Next list: what the Playing card's mode toggle currently offers ----------------
  // Every row carries its own built audio's URL when there is one — the
  // side panel plays it inline so you can actually hear a transition (or
  // an intro, for a cut/outro candidate) before committing to it, not just
  // read its label and cue time.
  function rowsFrom(candidateFromId, excludeIds) {
    if (isTransitionMode) {
      return transitionCandidates(visibleEdges, candidateFromId, excludeIds).map(e => {
        const dest = songs[e.r];
        return {
          kind: 'transition', key: e.id, edgeId: e.id, label: e.label || null,
          destId: e.r, destTitle: dest.title, destArtist: dest.artist, destCoverUrl: dest.coverUrl, destDurationSec: dest.durationSec,
          outSeconds: e.outSeconds, previewUrl: e.audioUrl || null,
        };
      });
    }
    return cutCandidates(songs, excludeIds).map(id => {
      const s = songs[id];
      const introEdge = findEdge(e => e.type === 'intro' && e.r === id);
      return {
        kind: 'cut', key: id, destId: id, destTitle: s.title, destArtist: s.artist, destCoverUrl: s.coverUrl, destDurationSec: s.durationSec,
        hasIntro: !!introEdge, previewUrl: introEdge ? (introEdge.audioUrl || null) : null,
      };
    });
  }

  const nowSong = hasStarted ? songs[session.nowPlayingId] : null;
  const elapsed = nowSong ? nowSong.durationSec - session.timeLeft : 0;

  const nextRows = useMemo(() => {
    if (!hasStarted || !fromId) return [];
    const rows = rowsFrom(fromId, usedIds);
    if (!isTransitionMode) return rows.sort((a, b) => a.destTitle.localeCompare(b.destTitle));
    // Real per-edge cue timing: candidates with time left on their own
    // built cue float to the top, soonest first; a transition with no cue
    // point yet never expires, so it sinks below the timed ones. Once a
    // cue point has actually passed, that produced transition can't
    // cleanly start anymore (its audio was built to begin exactly there) —
    // drop it rather than leaving a dead "0:00" card sitting in the list.
    return rows.map(r => {
      const hasCue = r.outSeconds != null;
      const secondsLeft = hasCue ? Math.max(0, r.outSeconds - elapsed) : session.timeLeft;
      const basisSec = hasCue ? r.outSeconds : (nowSong ? nowSong.durationSec : 210);
      return { ...r, hasCue, secondsLeft, basisSec };
    }).filter(r => !(r.hasCue && r.outSeconds - elapsed <= 0)).sort((a, b) => {
      if (a.hasCue && b.hasCue) return a.secondsLeft - b.secondsLeft;
      if (a.hasCue) return -1;
      if (b.hasCue) return 1;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStarted, fromId, isTransitionMode, visibleEdges, usedIds, songs, nowSong, session.timeLeft]);

  // Stabilized against `nextRows` itself changing identity every second —
  // `nextRows` carries a live `secondsLeft` countdown (see its own comment
  // above, keyed off `session.timeLeft`) so it's a brand new array every
  // playback tick even when the *set* of candidate destIds hasn't actually
  // changed. Without this, `stateFor` below (which reads `nextCandidateIds`)
  // gets a new identity every tick too, GraphPane's node-rebuild effect
  // (keyed on `stateFor`) refires every tick, and every node on the canvas
  // gets a brand new object once a second during any live set — exactly the
  // same class of bug already found and fixed once for `hoveredId` (see the
  // long comment on `stateFor` below), just reached through a different
  // dependency. Measured directly: with this memo naively keyed on
  // `nextRows`, the graph's disconnect-✕ buttons got their DOM node torn
  // down and recreated once a second during playback — read by a user as
  // "flickering" even while holding the mouse perfectly still over one.
  const nextCandidateIdsRef = useRef(new Set());
  const nextCandidateIds = useMemo(() => {
    const next = new Set(nextRows.map(r => r.destId));
    const prev = nextCandidateIdsRef.current;
    if (prev.size === next.size && [...next].every(id => prev.has(id))) return prev;
    nextCandidateIdsRef.current = next;
    return next;
  }, [nextRows]);

  // Hover preview ("what would picking this lead to") — not a staged plan,
  // just a look-ahead. Only shows once you're hovering an actual candidate.
  const laterRows = useMemo(() => {
    if (!hoveredId || !nextCandidateIds.has(hoveredId)) return [];
    const excl = new Set([...usedIds, hoveredId]);
    return rowsFrom(hoveredId, excl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredId, nextCandidateIds, usedIds, isTransitionMode, visibleEdges, songs]);
  const laterCandidateIds = useMemo(() => new Set(laterRows.map(r => r.destId)), [laterRows]);

  // ---------------- committing a pick — always immediate, no separate stage/confirm step ----------------
  function commitTransition(edgeId, destId) {
    setSession(prev => ({ ...prev, queue: [...prev.queue, { id: destId, mode: 'transition', edgeId }] }));
  }
  // `ending` defaults to the Playing card's current toggle (the ordinary
  // Next-list path) but the graph's hover-card passes one explicitly, since
  // it lets you pick cut vs. outro for a hovered song directly, regardless
  // of whatever the Playing card's toggle currently shows.
  function commitCutOrOutro(destId, ending) {
    const introEdge = findEdge(e => e.type === 'intro' && e.r === destId);
    const resolvedEnding = ending || (session.nextMode === 'outro' ? 'outro' : 'cut');
    setSession(prev => ({
      ...prev,
      queue: [...prev.queue, { id: destId, mode: 'cut', ending: resolvedEnding, starting: introEdge ? 'intro' : 'cut' }],
    }));
  }
  function commitRow(row) {
    if (row.kind === 'transition') commitTransition(row.edgeId, row.destId);
    else commitCutOrOutro(row.destId);
  }

  function setNextMode(mode) { setSession(prev => ({ ...prev, nextMode: mode })); }

  // End Set never sits in the ordinary Next list — it's reachable only from
  // a low-key link plus a confirm modal, so it can't be picked by accident
  // the way one more click through a scrolling list could.
  function requestEndSet() {
    setEndSetEnding(session.nextMode === 'outro' && hasOutroForPlaying ? 'outro' : 'cut');
    setEndSetModalOpen(true);
  }
  function confirmEndSet() {
    // The outro's own edgeId lets transitionTriggerElapsed (core.js) hand
    // off at its real cue point instead of waiting out the full song
    // duration — see that function's own comment for why that used to
    // duplicate the outro clip's overlapping tail material.
    const outroEdgeId = endSetEnding === 'outro' ? ((findEdge(e => e.type === 'outro' && e.l === session.nowPlayingId) || {}).id || null) : null;
    setSession(prev => ({ ...prev, queue: [...prev.queue, { id: END, ending: endSetEnding, edgeId: outroEdgeId }] }));
    setEndSetModalOpen(false);
  }

  // A click on a graph node (not a socket, not a drag): before a set has
  // started, this just plays that song immediately — no extra step through
  // the search box or a Cut/Intro picker first, matching direct request
  // ("click on a node and then just play from there"); it auto-picks Intro
  // when the song has one produced, Cut otherwise, same as any other cold
  // start would default to. Once a set IS running, a click instead commits
  // that song as the very next hop right now (a real transition when one's
  // built between Now Playing and it, otherwise a cut/outro) — explicit and
  // immediate, not "hover it and hope it shows up as a Next candidate."
  const selectSong = useCallback((id) => {
    if (!hasStarted) {
      const introEdge = introEdgeFor(visibleEdges, id);
      startSet(id, introEdge ? 'intro' : 'cut');
      return;
    }
    if (id === session.nowPlayingId || usedIds.has(id)) return;
    const transitionEdge = fromId ? visibleEdges.find(e => e.type === 'transition' && e.l === fromId && e.r === id) : null;
    if (transitionEdge) commitTransition(transitionEdge.id, id);
    else commitCutOrOutro(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStarted, visibleEdges, session.nowPlayingId, usedIds, fromId]);

  function startSet(songId, starting) {
    const song = songs[songId];
    const introEdge = starting === 'intro' ? findEdge(e => e.type === 'intro' && e.r === songId) : null;
    engine.startMain(song, introEdge);
    setSession(prev => ({
      ...prev, nowPlayingId: songId, startMethod: starting,
      queue: [], isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, nextMode: 'transition',
    }));
  }
  // The toolbar's "Start set" button — reads whatever's actually wired to
  // the Start Set node on the graph (a real, persistent connection, not a
  // one-shot trigger) and starts there. Mirrors "End set" being the one
  // real trigger for the graph's other bookend.
  function triggerStartSet() {
    const startSongId = activePlaylist.startSongId;
    if (!startSongId || !songs[startSongId]) return;
    const node = activePlaylist.nodes[startSongId];
    startSet(startSongId, node && node.startMode === 'intro' ? 'intro' : 'cut');
  }
  // Dragging or clicking the playhead — `fraction` is 0-1 along the bar.
  // Restarts the real audio deck at the new offset when Now Playing has
  // one (engine.seekMain), and always updates the wall-clock `timeLeft`
  // regardless, so a song with no uploaded master still scrubs correctly
  // via its own fallback countdown.
  function seekPlayhead(fraction) {
    if (!nowSong) return;
    const offsetSec = clamp(fraction, 0, 1) * nowSong.durationSec;
    engine.seekMain(session.nowPlayingId, offsetSec);
    setSession(prev => ({ ...prev, timeLeft: Math.max(0, nowSong.durationSec - offsetSec) }));
  }
  function togglePlaying() {
    setSession(prev => {
      const isPlaying = !prev.isPlaying;
      if (isPlaying) engine.resume(); else engine.pause();
      return { ...prev, isPlaying };
    });
  }
  // The "Set ended" screen's primary action — a dead end (nothing queued,
  // nothing wired, autoplay off) ends the set the same way an explicit End
  // Set does, but unlike an explicit end there's usually nothing wrong with
  // the song itself, so replaying it shouldn't need re-picking it from
  // scratch through the search box. `session.nowPlayingId`/`startMethod`
  // are both still exactly what they were the moment it ended (nothing
  // clears them until resumeSet does), so this just restarts the same song
  // the same way it started.
  function playAgain() {
    if (!session.nowPlayingId) return;
    startSet(session.nowPlayingId, session.startMethod || 'cut');
  }
  function resumeSet() {
    engine.stopAll();
    setSession(prev => ({ ...prev, setEnded: false, isPlaying: false, nowPlayingId: null, startMethod: null, queue: [], timeLeft: 0, nextMode: 'transition', autoHistory: [] }));
  }
  function removeQueueFrom(index) { setSession(prev => ({ ...prev, queue: prev.queue.slice(0, index) })); }
  // Skip just one queued song, keeping the plan after it — the hop into
  // whatever was next gets recomputed against its new predecessor (see
  // removeQueueItem in core.js) instead of losing the whole rest of the plan.
  function removeQueueOne(index) {
    setSession(prev => ({ ...prev, queue: removeQueueItem(prev.queue, index, prev.nowPlayingId, visibleEdges) }));
  }
  // the manual skip button — same rule the set-clock's timer uses (performAdvance, audioEngine.js)
  function skipNow() { setSession(prev => performAdvance(prev, songs, visibleEdges)); }

  // ---------------- layout: always manual (stored x/y) — "Arrange for me" is a one-shot action, not a mode ----------------
  // This used to be a persistent toggle: while "on", every node's position
  // came from a live dagre recompute, which silently fought any manual drag
  // (the node would just snap back to its dagre-computed spot on the next
  // render) — a real bug in its own right, reported directly ("auto arrange
  // being a toggle when it should obviously be a button press"). Now it's
  // exactly that: one press runs dagre once and writes the result straight
  // into each song's stored x/y, same as a manual drag would, so the graph
  // is immediately back to being freely, permanently draggable afterward.
  const positions = useMemo(() => {
    const p = {};
    Object.keys(songs).forEach(id => { p[id] = { x: songs[id].x, y: songs[id].y }; });
    p[END] = { x: 1250, y: 20 };
    p[START] = { x: -170, y: 20 };
    return p;
  }, [songs]);
  function arrangeForMe() {
    const layout = computeDagreLayout(songs, edges);
    setSongs(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(id => { if (layout[id]) next[id] = { ...next[id], x: layout[id].x, y: layout[id].y }; });
      return next;
    });
    // Dagre's computed positions land wherever its algorithm puts them, not
    // wherever the camera already happens to be — refit once the new
    // positions have actually rendered so the arranged graph isn't left
    // half outside the view. A short delay rather than an effect tied to
    // `songs`, since dragging a single node also changes `songs` and
    // shouldn't refit the whole camera.
    setTimeout(() => rf.fitView({ duration: 450, padding: 0.25 }), 60);
  }

  function onDragSongPosition(id, x, y) {
    setSongs(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], x, y } } : prev));
  }

  // Canvas context menu's "Add song here" — the same save logic Upload
  // Song's own form uses (real decode for duration, local/worker audio and
  // cover storage), just placed at the right-clicked point instead of an
  // auto-computed spot and reached without leaving the graph.
  async function saveAddedSong({ title, artist, file, coverFile }) {
    const analyzed = await analyzeAudio(file).catch(() => null);
    const audio = await uploadAudioIfConfigured(file);
    const coverUrl = coverFile ? await uploadCoverIfPossible(coverFile) : null;
    const id = uid('s');
    const at = addSongAt || { x: 60, y: 60 };
    const song = {
      id, title: title.trim(), artist: artist.trim() || 'Unknown',
      x: at.x, y: at.y, bpm: 120, key: '—',
      durationSec: (analyzed && analyzed.durationSec) || mockDuration(title + artist),
      audioUrl: audio.audioUrl || null, coverUrl,
    };
    setSongs(prev => ({ ...prev, [id]: song }));
    setAddSongAt(null);
  }

  // ---------------- the three graph highlight states: playing / next / later ----------------
  // Memoized so its identity is stable across renders that don't actually
  // change the queue (e.g. a hover or search keystroke) — `stateFor` below
  // depends on it, and GraphPane's data-refresh effect depends on `stateFor`,
  // so an unmemoized array here would re-trigger that effect on every
  // render for no reason.
  const queueIds = useMemo(() => session.queue.map(q => q.id), [session.queue]);
  // Deliberately does NOT depend on laterCandidateIds/hoveredId — this feeds
  // GraphPane's node-rebuild effect (via the `stateFor` prop), and a real
  // bug was traced here directly: laterCandidateIds is itself derived from
  // `laterRows`, which depends on `hoveredId`, so `stateFor`'s own identity
  // was silently changing on every hover despite looking like a stable
  // useCallback — refiring that effect on every hover the exact same way
  // the original hoveredId-jitter bug did, just one level indirected. That
  // in turn triggers React Flow's internal registry resync often enough,
  // and fast enough, to make the browser's own hit-testing genuinely
  // unstable at the hovered pixel: confirmed directly — with this
  // dependency in place, the same node's onMouseEnter/onMouseLeave fired
  // over 20 times *each* in a single second while the pointer sat
  // perfectly still, an actual feedback loop (enter → state change →
  // resync → momentary hit-test miss → native mouseleave → state change →
  // resync → hit lands again → native mouseenter → repeat), not merely a
  // cosmetic flicker. The "later" hover-preview highlight this used to fold
  // in here now reaches SongNode through context instead (see
  // laterCandidateIds passed to GraphPane below) — same fix as the
  // hoveredId/matchIds treatment before it.
  const stateFor = useCallback((id) => {
    if (id === session.nowPlayingId) return 'playing';
    if (queueIds[0] === id) return 'next';
    if (queueIds.slice(1).includes(id)) return 'later';
    if (nextCandidateIds.has(id)) return 'next';
    return null;
  }, [session.nowPlayingId, queueIds, nextCandidateIds]);

  // ---------------- playlist-editor sockets (see TODO.md) ----------------
  // One entry per song. Every song shows the same fixed three rows per
  // side (LEFT_SOCKET_TYPES/RIGHT_SOCKET_TYPES in core.js) — a row a song
  // can't actually use (no produced edge) still renders, greyed out and
  // non-interactive, rather than disappearing, so every node scans the
  // same shape at a glance. `*Available` says which rows are real for this
  // song. The row label itself always stays the fixed type name
  // ("Transition"/"Intro"/"Outro") — it never renames itself to whichever
  // specific edge is wired, since that read as the socket *type* changing
  // rather than just a choice underneath it. When more than one produced
  // edge could fill an active slot, `*Options` carries the full candidate
  // list (each `{ id, label }`) for a dropdown next to the row; a single
  // candidate needs no picker at all.
  const activePlaylist = session.activePlaylist;
  const socketDataById = useMemo(() => {
    const map = {};
    Object.keys(songs).forEach(id => {
      const node = activePlaylist.nodes[id];
      const leftActive = node ? node.startMode : 'none';
      const rightActive = node ? node.endMode : 'none';
      let leftOptions = [], rightOptions = [], rightCueSeconds = null;
      if (leftActive === 'intro') {
        const candidates = introEdgesFor(visibleEdges, id);
        if (candidates.length > 1) leftOptions = candidates.map(e => ({ id: e.id, label: e.label || 'Intro' }));
      }
      if (rightActive === 'outro') {
        const candidates = outroEdgesFor(visibleEdges, id);
        if (candidates.length > 1) rightOptions = candidates.map(e => ({ id: e.id, label: e.label || 'Outro', outSeconds: e.outSeconds }));
      } else if (rightActive === 'transition' && node.nextSongId) {
        const candidates = transitionEdgesBetween(visibleEdges, id, node.nextSongId);
        if (candidates.length > 1) rightOptions = candidates.map(e => ({ id: e.id, label: e.label || 'Transition', outSeconds: e.outSeconds }));
      }
      // The countdown ring (GraphNodes.jsx) needs the cue point behind
      // whichever edge is actually wired right now — Outro and Transition
      // both keep it on endEdgeId, so one lookup covers both.
      if ((rightActive === 'outro' || rightActive === 'transition') && node.endEdgeId) {
        const edge = visibleEdges.find(e => e.id === node.endEdgeId);
        if (edge && edge.outSeconds != null) rightCueSeconds = edge.outSeconds;
      }
      map[id] = {
        leftAvailable: leftSocketAvailability(visibleEdges, id), rightAvailable: rightSocketAvailability(visibleEdges, id),
        leftActive, rightActive,
        leftEdgeId: node ? node.startEdgeId : null, rightEdgeId: node ? node.endEdgeId : null,
        leftOptions, rightOptions, rightCueSeconds,
      };
    });
    return map;
  }, [songs, visibleEdges, activePlaylist]);

  // A socket click toggles None/Intro/Outro directly (clicking the type
  // that's already active turns it back off, to None); a Transition
  // socket is only ever set by a real drag-connect — see TODO.md. Intro
  // and Outro don't need a destination to mean something on their own
  // ("this song always starts with its intro" / "ends with its outro,
  // even if nothing's wired after it yet") — dragging a connection later
  // can still attach a specific next song on top of either.
  const toggleSocket = useCallback((songId, side, type) => {
    setSession(prev => {
      const node = prev.activePlaylist.nodes[songId];
      const base = node || { startMode: 'none', startEdgeId: null, endMode: 'none', endEdgeId: null, nextSongId: null };
      if (side === 'left') {
        const turningOn = base.startMode !== type;
        const startMode = turningOn ? type : 'none';
        const startEdgeId = startMode === 'intro' ? ((findEdge(e => e.type === 'intro' && e.r === songId) || {}).id || null) : null;
        const nodes = { ...prev.activePlaylist.nodes, [songId]: { ...base, startMode, startEdgeId } };
        return { ...prev, activePlaylist: { ...prev.activePlaylist, nodes } };
      }
      const turningOn = base.endMode !== type;
      if (!turningOn) return { ...prev, activePlaylist: unwireOutput(prev.activePlaylist, songId) };
      const endEdgeId = type === 'outro' ? ((findEdge(e => e.type === 'outro' && e.l === songId) || {}).id || null) : null;
      const nodes = { ...prev.activePlaylist.nodes, [songId]: { ...base, endMode: type, endEdgeId } };
      return { ...prev, activePlaylist: { ...prev.activePlaylist, nodes } };
    });
  }, [setSession, findEdge]);

  const commitWire = useCallback((source, target, endMode, endEdgeId, startMode, startEdgeId) => {
    setSession(prev => ({ ...prev, activePlaylist: wireConnection(prev.activePlaylist, source, target, endMode, endEdgeId, startMode, startEdgeId) }));
  }, [setSession]);

  // Start Set's own wire — see wireStart (core.js) for why this needs a
  // dedicated pointer instead of reusing endMode/nextSongId the way every
  // other connection does (Start isn't a song; nothing plays "from" it).
  const commitStartWire = useCallback((songId, startMode, startEdgeId) => {
    setSession(prev => ({ ...prev, activePlaylist: wireStart(prev.activePlaylist, songId, startMode, startEdgeId) }));
  }, [setSession]);
  const disconnectStart = useCallback(() => {
    setSession(prev => ({ ...prev, activePlaylist: unwireStart(prev.activePlaylist) }));
  }, [setSession]);

  // Node context menu's "Set as Start" — the same auto-pick rule click-to-
  // play already uses (Intro when one's produced, a cold cut otherwise),
  // just wiring it as the persistent Start Set connection instead of
  // triggering playback immediately.
  const setAsStart = useCallback((songId) => {
    const introEdge = introEdgeFor(visibleEdges, songId);
    commitStartWire(songId, introEdge ? 'intro' : 'none', introEdge ? introEdge.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, commitStartWire]);

  // Node context menu's "Disconnect all wires" — every wire touching this
  // song in one action (its own outgoing wire, whichever song wires into
  // it, and Start Set if that's what's wired here), rather than hunting
  // down each hover-✕ individually.
  const disconnectAll = useCallback((songId) => {
    setSession(prev => ({ ...prev, activePlaylist: disconnectAllWires(prev.activePlaylist, songId) }));
  }, [setSession]);

  // Only a Transition output may ever meet a Transition input — everything
  // else (None/Outro on the left of the drag, None/Intro on the right)
  // freely mixes, since those four don't correspond to a specific produced
  // edge the way a transition does. React Flow calls this before a drag
  // is even allowed to visually snap, so an invalid drop never gets this
  // far in the first place.
  //
  // These handlers (and toggleSocket/commitWire/disconnectSong/
  // selectVariant above and below) are wrapped in useCallback so their
  // identity only changes when something they actually depend on does —
  // GraphPane threads them into each edge's `data`, and an edge rendered
  // through React Flow's EdgeLabelRenderer portal (the hover-✕ disconnect
  // button) briefly drops out of the DOM on any render where its `data`
  // reference changes, even though the edge itself never stopped being
  // wired. Without this, every 1-second playback tick — which produces a
  // brand new `session` object and so a brand new inline function here —
  // would make the disconnect button flicker during an actual live set.
  // A drag from the Start Set node marks whichever song it's dropped on as
  // the set's entry point — Intro or None only (there's no "Start
  // Transition", the same way there's no Outro on the left side of a
  // song). A drag into the End Set node is the same idea in reverse: only
  // a None/Outro *output* can end there, never a Transition (an active
  // transition already has its own real destination song). Both wires
  // persist on the graph exactly like a song-to-song connection — see
  // commitStartWire below and the plain `commitWire` reuse for End, since
  // END is just an ordinary target id as far as wireConnection is
  // concerned.
  const isValidConnection = useCallback((conn) => {
    if (conn.source === conn.target) return false;
    if (conn.source === START) return conn.targetHandle === 'left-none' || conn.targetHandle === 'left-intro';
    if (conn.target === END) return conn.sourceHandle === 'right-none' || conn.sourceHandle === 'right-outro';
    const sourceType = conn.sourceHandle.slice('right-'.length);
    const targetType = conn.targetHandle.slice('left-'.length);
    if (sourceType === 'transition' || targetType === 'transition') return sourceType === 'transition' && targetType === 'transition';
    return true;
  }, []);

  // A dropped connection always wires immediately, picking the first
  // produced candidate when several exist between that pair (or several
  // intro/outro fragments on one song) — the row itself then grows a
  // dropdown next to it (see socketDataById's `*Options`) so switching to
  // a different candidate is a plain select, not a second popup to drive
  // through. Nothing here ever guesses at which *song* to connect: that
  // part still only ever comes from the drag itself.
  const handleConnect = useCallback((conn) => {
    if (conn.source === START) {
      const startMode = conn.targetHandle === 'left-intro' ? 'intro' : 'none';
      const startEdgeId = startMode === 'intro' ? ((introEdgeFor(visibleEdges, conn.target)) || {}).id || null : null;
      commitStartWire(conn.target, startMode, startEdgeId);
      return;
    }
    const sourceType = conn.sourceHandle.slice('right-'.length);
    if (conn.target === END) {
      const endEdgeId = sourceType === 'outro' ? ((outroEdgeFor(visibleEdges, conn.source)) || {}).id || null : null;
      commitWire(conn.source, END, sourceType, endEdgeId, 'none', null);
      return;
    }
    const targetType = conn.targetHandle.slice('left-'.length);
    if (sourceType === 'transition') {
      const candidates = transitionEdgesBetween(visibleEdges, conn.source, conn.target);
      if (candidates.length === 0) return;
      commitWire(conn.source, conn.target, 'transition', candidates[0].id, 'transition', candidates[0].id);
      return;
    }
    const endEdgeId = sourceType === 'outro' ? ((outroEdgeFor(visibleEdges, conn.source)) || {}).id || null : null;
    const startEdgeId = targetType === 'intro' ? ((introEdgeFor(visibleEdges, conn.target)) || {}).id || null : null;
    commitWire(conn.source, conn.target, sourceType, endEdgeId, targetType, startEdgeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, commitWire, commitStartWire]);

  // A socket's dropdown (only rendered when 2+ candidates exist — see
  // socketDataById) swaps which produced edge fills an already-active
  // slot, leaving the slot itself and any wired destination untouched.
  const selectVariant = useCallback((songId, side, edgeId) => {
    setSession(prev => ({
      ...prev,
      activePlaylist: side === 'left'
        ? setStartVariant(prev.activePlaylist, songId, edgeId)
        : setEndVariant(prev.activePlaylist, songId, edgeId),
    }));
  }, [setSession]);

  // The hover-✕ on an active wire (see GraphPane's edge rendering) —
  // deliberately not "click the wire itself", which would make a stray
  // click destroy part of a built playlist the same way clicking to end
  // a set used to risk before that got a confirm modal of its own.
  const disconnectSong = useCallback((songId) => {
    setSession(prev => ({ ...prev, activePlaylist: unwireOutput(prev.activePlaylist, songId) }));
  }, [setSession]);

  // ---------------- search (Fuse.js) ----------------
  const fuse = useMemo(() => new Fuse(Object.values(songs), { keys: ['title', 'artist'], threshold: 0.35, ignoreLocation: true }), [songs]);
  const searchActive = searchQuery.trim().length > 0;
  const matches = useMemo(() => (searchActive ? fuse.search(searchQuery).map(r => r.item) : []), [fuse, searchQuery, searchActive]);
  const matchIds = useMemo(() => new Set(matches.map(m => m.id)), [matches]);
  const suggestions = useMemo(() => matches.slice(0, 7), [matches]);

  function centerFor(id) {
    const pos = positions[id];
    if (!pos) return null;
    const isSentinel = id === END || id === START;
    const w = isSentinel ? END_W : NODE_W, h = isSentinel ? END_H : NODE_H;
    return { x: pos.x + w / 2, y: pos.y + h / 2 };
  }
  const focusOn = useCallback((id, zoom = 1.15) => {
    const c = centerFor(id);
    if (!c || !rf) return;
    rf.setCenter(c.x, c.y, { zoom, duration: 450 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, rf]);

  useEffect(() => {
    if (searchActive && matches.length > 0) {
      setMatchIndex(0);
      focusOn(matches[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  function stepMatch(dir) {
    if (matches.length === 0) return;
    const next = (matchIndex + dir + matches.length) % matches.length;
    setMatchIndex(next);
    focusOn(matches[next].id);
  }
  function pickSuggestion(id) {
    setSearchQuery('');
    setShowSuggestions(false);
    focusOn(id);
  }
  function focusActive() {
    if (session.nowPlayingId) focusOn(session.nowPlayingId, 1.15);
    else rf.fitView({ duration: 450, padding: 0.2 });
  }

  // ---------------- keyboard shortcuts: / or Cmd/Ctrl+K focuses search, arrow
  // keys step results while search is active, Space toggles Playing ----------------
  useEffect(() => {
    function isTypingTarget(el) {
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }
    function onKeyDown(e) {
      const typing = isTypingTarget(document.activeElement);
      if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        if (searchInputRef.current) searchInputRef.current.focus();
        return;
      }
      if (searchActive && !typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        stepMatch(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.key === ' ' && !typing && hasStarted) {
        e.preventDefault();
        togglePlaying();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchActive, matches, matchIndex, hasStarted]);

  const cueBarPct = nowSong && nowSong.durationSec ? Math.round((1 - session.timeLeft / nowSong.durationSec) * 100) : 0;

  // Spotify-style dual display: once we're within CROSSFADE_LOOKAHEAD_SEC of
  // the committed transition's real cue point, show both songs instead of
  // just Playing.
  // A wired-but-not-manually-queued hop needs to show "mixing into" too —
  // same effective-head reasoning as the tick loop's trigger check, so the
  // UI and the real handoff always agree on what's about to happen.
  const queueHead = session.queue[0] || (session.nowPlayingId ? playlistNextHop(activePlaylist, session.nowPlayingId) : null);
  const committedEdge = (queueHead && queueHead.mode === 'transition' && queueHead.edgeId)
    ? edges.find(e => e.id === queueHead.edgeId) : null;
  let mixingIntoSong = null, crossfadePct = 0, mixingEdgeId = null;
  if (nowSong && queueHead && queueHead.mode === 'transition') {
    const triggerAt = committedEdge && committedEdge.outSeconds != null ? committedEdge.outSeconds : nowSong.durationSec;
    if (triggerAt - elapsed <= 8) {
      mixingIntoSong = songs[queueHead.id] || null;
      crossfadePct = clamp(Math.round((1 - Math.max(0, triggerAt - elapsed) / 8) * 100), 0, 100);
      mixingEdgeId = committedEdge ? committedEdge.id : null;
    }
  }
  // The player bar's "Next" preview — whatever queueHead already resolved
  // to (a manual commit or the graph's own wiring), regardless of the
  // 8-second crossfade lookahead mixingIntoSong is gated behind.
  const nextSong = queueHead && queueHead.id !== END ? songs[queueHead.id] : null;

  if (Object.keys(songs).length === 0) {
    return (
      <div className="page page-perform">
        <div className="empty-state">
          <div className="empty-state-title">Your graph is empty</div>
          <div className="empty-state-sub">Add your first song, then come back here to lay out your set and connect it to others.</div>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={goUpload}>Upload a song</button>
            <button className="btn btn-ghost" onClick={onLoadExample}>Load an example graph</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-perform">
      <div className="toolbar">
        <div className="search-wrap">
          <input
            ref={searchInputRef}
            className="input" placeholder="Find a song or artist… (/)" value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (matches.length) focusOn(matches[0].id); setShowSuggestions(false); }
              if (e.key === 'Escape') { setSearchQuery(''); setShowSuggestions(false); }
            }}
          />
          {showSuggestions && searchActive && suggestions.length > 0 && (
            <div className="search-suggestions">
              {suggestions.map(s => (
                <button key={s.id} className="search-suggestion" onMouseDown={() => pickSuggestion(s.id)}>
                  <span>{s.title}</span>
                  <span className="search-suggestion-artist">{s.artist}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {searchActive && (
          <div className="search-nav">
            <button className="icon-btn" aria-label="Previous match" onClick={() => stepMatch(-1)} disabled={matches.length === 0}><Icon path={ICONS.chevronLeft} size={13} /></button>
            <span className="search-count mono-num">{matches.length ? (matchIndex + 1) + '/' + matches.length : '0/0'}</span>
            <button className="icon-btn" aria-label="Next match" onClick={() => stepMatch(1)} disabled={matches.length === 0}><Icon path={ICONS.chevron} size={13} /></button>
          </div>
        )}

        <button className="toolbar-btn" onClick={focusActive} data-tooltip="Focus on the playing song">
          <Icon path={ICONS.target} size={13} /> Focus active
        </button>
        <button className="toolbar-btn" onClick={arrangeForMe} data-tooltip="Auto-arrange the graph">
          <Icon path={ICONS.grid} size={13} /> Arrange for me
        </button>

        <div className="legend toolbar-spacer">
          <span><i className="swatch swatch-playing" />playing</span>
          <span><i className="swatch swatch-next" />next</span>
          <span><i className="swatch swatch-later" />later</span>
        </div>

        {!session.isPlaying && activePlaylist.startSongId && songs[activePlaylist.startSongId] && (
          <button className="toolbar-start-set-btn" onClick={triggerStartSet} data-tooltip={'Start playing from ' + songs[activePlaylist.startSongId].title}>
            <Icon path={ICONS.play} filled size={12} /> Start set
          </button>
        )}
        {hasStarted && (
          <>
            <button className="toolbar-end-set-btn" onClick={requestEndSet} data-tooltip="Play this out, then stop">
              <Icon path={ICONS.stop} filled size={12} /> End set
            </button>
            <button className="toolbar-stop-set-btn" onClick={resumeSet} data-tooltip="Stop right now">
              <Icon path={ICONS.stop} filled size={12} /> Stop set
            </button>
          </>
        )}
      </div>

      {/* The old side panel and bottom queue bar stay unused — the graph
          itself (click-to-play/commit, the toolbar buttons, and the node/
          canvas right-click menus) already covers picking what plays — but
          a live set still needs an always-visible "what's on, what's next,
          and the regular transport" strip that doesn't require reading the
          canvas at all. */}
      {hasStarted && (
        <div className="player-bar">
          <div className="player-bar-now">
            <AlbumArt className="player-bar-art" url={nowSong.coverUrl} />
            <div className="player-bar-text">
              <div className="player-bar-title">{nowSong.title}</div>
              <div className="player-bar-artist">{nowSong.artist}</div>
            </div>
          </div>

          <button className="icon-btn" onClick={togglePlaying} aria-label={session.isPlaying ? 'Pause' : 'Play'}>
            <Icon path={session.isPlaying ? ICONS.pause : ICONS.play} filled={!session.isPlaying} size={16} />
          </button>
          <button className="icon-btn" onClick={skipNow} aria-label="Skip to next" data-tooltip="Skip to next">
            <Icon path={ICONS.skip} filled size={16} />
          </button>

          <span className="mono-num player-bar-time">{fmtTime(elapsed)}</span>
          <div className="player-bar-scrub"><Playhead pct={cueBarPct} onSeek={seekPlayhead} /></div>
          <span className="mono-num player-bar-time">{fmtTime(nowSong.durationSec)}</span>

          <div className="player-bar-volume" data-tooltip={Math.round(volume * 100) + '%'}>
            <Icon path={ICONS.volume} size={14} />
            <input
              type="range" min="0" max="1" step="0.01" value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              aria-label="Volume"
            />
          </div>

          <div className="player-bar-next">
            <span className="player-bar-next-label">Next</span>
            {nextSong ? (
              <>
                <AlbumArt className="player-bar-art-sm" url={nextSong.coverUrl} />
                <span className="player-bar-next-title">{nextSong.title}</span>
              </>
            ) : <span className="player-bar-next-empty">nothing queued</span>}
          </div>
        </div>
      )}

      <div className="perform-layout">
        <div className="graph-pane">
          <GraphPane
            songs={songs} positions={positions} transitionEdgesRaw={transitionEdgesRaw} activePlaylist={activePlaylist}
            socketDataById={socketDataById} onToggleSocket={toggleSocket} onSelectVariant={selectVariant} mixingEdgeId={mixingEdgeId}
            onConnect={handleConnect} isValidConnection={isValidConnection} onDisconnectSong={disconnectSong}
            onDisconnectStart={disconnectStart}
            stateFor={stateFor} ioById={ioById} hoveredId={hoveredId} setHoveredId={setHoveredId}
            matchIds={matchIds} searchActive={searchActive} laterCandidateIds={laterCandidateIds}
            onDragSongPosition={onDragSongPosition} onSelectSong={selectSong}
            endQueued={queueIds.includes(END)}
            nowPlayingId={session.nowPlayingId} nowElapsedSec={elapsed} nowDurationSec={nowSong ? nowSong.durationSec : 0}
            onPaneContextMenu={onPaneContextMenu} onNodeContextMenu={onNodeContextMenu}
          />
        </div>
      </div>

      {endSetModalOpen && (
        <ConfirmModal
          title="End the set?"
          confirmLabel="End set" danger
          onCancel={() => setEndSetModalOpen(false)}
          onConfirm={confirmEndSet}
        >
          <div className="modal-sub">
            {nowSong ? nowSong.title : 'Now Playing'} will {endSetEnding === 'outro' ? 'play its outro, then' : 'cut, and'} stop the set — nothing more queued after it.
          </div>
          {hasOutroForPlaying && (
            <div className="seq-row-toggles segmented" style={{ marginTop: 10 }}>
              <button className={'seq-toggle' + (endSetEnding === 'cut' ? ' active' : '')} onClick={() => setEndSetEnding('cut')}>Cut</button>
              <button className={'seq-toggle' + (endSetEnding === 'outro' ? ' active' : '')} onClick={() => setEndSetEnding('outro')}>Outro</button>
            </div>
          )}
        </ConfirmModal>
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu} songs={songs} activePlaylist={activePlaylist}
          onClose={closeContextMenu}
          onAddSongHere={() => { setAddSongAt({ x: contextMenu.flowX, y: contextMenu.flowY }); closeContextMenu(); }}
          onArrangeForMe={() => { arrangeForMe(); closeContextMenu(); }}
          onFocus={(id) => { focusOn(id); closeContextMenu(); }}
          onSetAsStart={(id) => { setAsStart(id); closeContextMenu(); }}
          onDisconnectAll={(id) => { disconnectAll(id); closeContextMenu(); }}
          onEditInLibrary={() => { goLibrary(); closeContextMenu(); }}
          onDeleteSong={(id) => { onDeleteSong(id); closeContextMenu(); }}
          onDisconnectStart={() => { disconnectStart(); closeContextMenu(); }}
          onDisconnectEnd={(id) => { disconnectSong(id); closeContextMenu(); }}
        />
      )}

      {addSongAt && (
        <AddSongModal onSave={saveAddedSong} onCancel={() => setAddSongAt(null)} />
      )}
    </div>
  );
}

// The two right-click menus (empty canvas vs. a specific node) — one
// component branching on `menu.kind`/`menu.nodeType` rather than two,
// since they share the same popover shell, outside-click/Escape handling,
// and positioning logic. Closes itself the same way GraphPane's socket
// dropdowns do: a mousedown outside the menu, or Escape.
function ContextMenu({
  menu, activePlaylist, onClose,
  onAddSongHere, onArrangeForMe, onFocus, onSetAsStart, onDisconnectAll, onEditInLibrary, onDeleteSong,
  onDisconnectStart, onDisconnectEnd,
}) {
  const ref = useRef(null);
  useEffect(() => {
    function onDocMouseDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onDocMouseDown); window.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);

  const style = { left: menu.screenX, top: menu.screenY };
  let items;
  if (menu.kind === 'pane') {
    items = (
      <>
        <button className="context-menu-item" onClick={onAddSongHere}>Add song here</button>
        <button className="context-menu-item" onClick={onArrangeForMe}>Arrange for me</button>
      </>
    );
  } else if (menu.nodeType === 'song') {
    items = (
      <>
        <button className="context-menu-item" onClick={() => onFocus(menu.nodeId)}>Focus here</button>
        <button className="context-menu-item" onClick={() => onSetAsStart(menu.nodeId)}>Set as Start</button>
        <button className="context-menu-item" onClick={() => onDisconnectAll(menu.nodeId)}>Disconnect all wires</button>
        <button className="context-menu-item" onClick={onEditInLibrary}>Edit in Library</button>
        <div className="context-menu-sep" />
        <button className="context-menu-item context-menu-danger" onClick={() => onDeleteSong(menu.nodeId)}>Delete song</button>
      </>
    );
  } else if (menu.nodeType === 'start') {
    const wired = !!activePlaylist.startSongId;
    items = <button className="context-menu-item" disabled={!wired} onClick={onDisconnectStart}>{wired ? 'Disconnect' : 'Not wired'}</button>;
  } else {
    const wiredFrom = Object.keys(activePlaylist.nodes).find(id => activePlaylist.nodes[id].nextSongId === END);
    items = <button className="context-menu-item" disabled={!wiredFrom} onClick={() => onDisconnectEnd(wiredFrom)}>{wiredFrom ? 'Disconnect' : 'Not wired'}</button>;
  }
  return <div className="context-menu" style={style} ref={ref}>{items}</div>;
}

// The canvas context menu's "Add song here" — a condensed version of
// Upload Song's own form (same underlying save logic, see saveAddedSong
// above) inside the app's existing ConfirmModal shell, so adding a song
// never needs leaving the graph.
function AddSongModal({ onSave, onCancel }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [file, setFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const coverPreviewUrl = useMemo(() => (coverFile ? URL.createObjectURL(coverFile) : null), [coverFile]);

  async function confirm() {
    if (!title.trim()) { setError('Give the song a title.'); return; }
    setError('');
    setSaving(true);
    await onSave({ title, artist, file, coverFile });
    setSaving(false);
  }

  return (
    <ConfirmModal title="Add song" confirmLabel={saving ? 'Adding…' : 'Add song'} onCancel={onCancel} onConfirm={confirm}>
      <Field label="Cover art (optional)"><CoverPicker url={coverPreviewUrl} onFile={setCoverFile} /></Field>
      <Field label="Title"><input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Faultline Blue" /></Field>
      <Field label="Artist"><input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="e.g. Nomi Sato" /></Field>
      <Field label="Master audio"><Dropzone file={file} onFile={setFile} hint="drop the song's audio" /></Field>
      {error && <div className="error-note">{error}</div>}
    </ConfirmModal>
  );
}
