import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import Fuse from 'fuse.js';
import {
  END, START, getVisibleEdges, inOutCounts, queueTailId, removeQueueItem,
  transitionCandidates, cutCandidates, clamp, leftSocketAvailability, rightSocketAvailability,
  unwireOutput, wireConnection, playlistNextHop, transitionEdgesBetween, introEdgeFor, outroEdgeFor,
  introEdgesFor, outroEdgesFor, setStartVariant, setEndVariant, fmtTime,
} from '../core.js';
import { engine, performAdvance } from '../audioEngine.js';
import { computeDagreLayout, NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import GraphPane from './GraphPane.jsx';
import SequencePane from './SequencePane.jsx';
import QueueBar from './QueueBar.jsx';
import { Icon, ICONS, ConfirmModal } from './shared.jsx';

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

function PerformPageInner({ songs, setSongs, edges, session, setSession, venueName, goUpload, onLoadExample }) {
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

  const nextCandidateIds = useMemo(() => new Set(nextRows.map(r => r.destId)), [nextRows]);

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
    setSession(prev => ({ ...prev, queue: [...prev.queue, { id: END, ending: endSetEnding }] }));
    setEndSetModalOpen(false);
  }

  // A click on a graph node (not a socket, not a drag) selects that song in
  // the "Start the set" card so it shows the Cut/Intro choice and a "Start
  // playing" button — before this, the only way to start with a specific
  // song was to find it again through the search box, even though it was
  // already right there on the canvas you just clicked.
  const selectSong = useCallback((id) => { if (!hasStarted) setStartPickId(id); }, [hasStarted]);

  function startSet(songId, starting) {
    const song = songs[songId];
    const introEdge = starting === 'intro' ? findEdge(e => e.type === 'intro' && e.r === songId) : null;
    engine.startMain(song, introEdge);
    setSession(prev => ({
      ...prev, nowPlayingId: songId, startMethod: starting,
      queue: [], isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, nextMode: 'transition',
    }));
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

  // ---------------- the three graph highlight states: playing / next / later ----------------
  // Memoized so its identity is stable across renders that don't actually
  // change the queue (e.g. a hover or search keystroke) — `stateFor` below
  // depends on it, and GraphPane's data-refresh effect depends on `stateFor`,
  // so an unmemoized array here would re-trigger that effect on every
  // render for no reason.
  const queueIds = useMemo(() => session.queue.map(q => q.id), [session.queue]);
  const stateFor = useCallback((id) => {
    if (id === session.nowPlayingId) return 'playing';
    if (queueIds[0] === id) return 'next';
    if (queueIds.slice(1).includes(id)) return 'later';
    if (nextCandidateIds.has(id)) return 'next';
    if (laterCandidateIds.has(id)) return 'later';
    return null;
  }, [session.nowPlayingId, queueIds, nextCandidateIds, laterCandidateIds]);

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
  const isValidConnection = useCallback((conn) => {
    if (conn.source === conn.target) return false;
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
    const sourceType = conn.sourceHandle.slice('right-'.length);
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
  }, [visibleEdges, commitWire]);

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

        {hasStarted && (
          <button className="toolbar-end-set-btn" onClick={requestEndSet} data-tooltip="Stop the set after this">
            <Icon path={ICONS.stop} filled size={12} /> End set
          </button>
        )}
      </div>

      <div className="perform-layout">
        <div className="graph-pane">
          <GraphPane
            songs={songs} positions={positions} transitionEdgesRaw={transitionEdgesRaw} activePlaylist={activePlaylist}
            socketDataById={socketDataById} onToggleSocket={toggleSocket} onSelectVariant={selectVariant} mixingEdgeId={mixingEdgeId}
            onConnect={handleConnect} isValidConnection={isValidConnection} onDisconnectSong={disconnectSong}
            stateFor={stateFor} ioById={ioById} hoveredId={hoveredId} setHoveredId={setHoveredId}
            matchIds={matchIds} searchActive={searchActive}
            onDragSongPosition={onDragSongPosition} onSelectSong={selectSong}
            endQueued={queueIds.includes(END)} hasStarted={hasStarted}
            nowPlayingId={session.nowPlayingId} nowElapsedSec={elapsed} nowDurationSec={nowSong ? nowSong.durationSec : 0}
          />
          <QueueBar songs={songs} nowPlayingId={session.nowPlayingId} queue={session.queue} autoHistory={session.autoHistory} onRemoveQueueItem={removeQueueFrom} onRemoveQueueItemOnly={removeQueueOne} />
        </div>

        <SequencePane
          songs={songs} session={session} venueName={venueName}
          hasStarted={hasStarted} nowSong={nowSong} cueBarPct={cueBarPct} hasOutroForPlaying={hasOutroForPlaying}
          mixingIntoSong={mixingIntoSong} crossfadePct={crossfadePct}
          nextRows={nextRows} laterRows={laterRows} setHoveredId={setHoveredId}
          startPickId={startPickId} onSetStartPick={setStartPickId}
          onTogglePlaying={togglePlaying} onResumeSet={resumeSet} onStartSet={startSet} onSetNextMode={setNextMode}
          onCommitRow={commitRow} onSkipNext={skipNow} onRequestEndSet={requestEndSet}
          onSeek={seekPlayhead}
        />
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
    </div>
  );
}
