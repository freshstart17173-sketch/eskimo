import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import Fuse from 'fuse.js';
import {
  END, START, getVisibleEdges, inOutCounts, clamp, leftSocketAvailability, rightSocketAvailability,
  unwireOutput, wireConnection, wireStart, unwireStart, disconnectAllWires, playlistNextHop, transitionEdgesBetween, introEdgeFor, outroEdgeFor,
  introEdgesFor, outroEdgesFor, setStartVariant, setEndVariant, fmtTime, hopSummary, occludedTransitions,
  addTransitionConnection, removeTransitionConnection, autoconnectNodeTransitions, autoconnectFullGraph,
} from '../core.js';
import { engine } from '../audioEngine.js';
import { useTransportControls } from '../playbackControls.js';
import { computeDagreLayout, NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import GraphPane from './GraphPane.jsx';
import { Icon, ICONS, AlbumArt } from './shared.jsx';
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

function PerformPageInner({ songs, setSongs, edges, session, setSession, venueName, goUpload, goLibrary, onLoadExample }) {
  const rf = useReactFlow();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [hoveredId, setHoveredId] = useState(null);
  const searchInputRef = useRef(null);
  // Selected vs Active: Active (session.nowPlayingId) is whatever's really
  // playing; Selected is purely "what was last clicked in the graph" — a
  // click never starts playback on its own anymore, it only decides what
  // the detail pane on the right shows. Explicitly requested as its own
  // concept: "Selecting a node won't make it active, selecting it and then
  // clicking play will."
  const [selectedId, setSelectedId] = useState(null);
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
  // React Flow's own selection-box drag result (see GraphPane.jsx's
  // onSelectionChange) — a real per-node multi-select, tracked entirely
  // separately from `selectedId` above (the detail pane's own cursor,
  // which a multi-selection must never change — see its own comment).
  // Only ever used to decide which context menu a right-click opens.
  const [multiSelectedIds, setMultiSelectedIds] = useState([]);

  const onPaneContextMenu = useCallback((event) => {
    event.preventDefault();
    const flowPos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setContextMenu({ kind: 'pane', screenX: event.clientX, screenY: event.clientY, flowX: flowPos.x, flowY: flowPos.y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf]);
  // Right-clicking a node that's part of a real (2+) multi-selection opens
  // the group menu instead of that one node's own — matches the
  // multi-selection's own visual ring (GraphNodes.jsx): once 2+ nodes are
  // selected, actions apply to the whole set, not just whichever one
  // happened to catch the right-click.
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();
    if (multiSelectedIds.length > 1 && multiSelectedIds.includes(node.id)) {
      setContextMenu({ kind: 'multi', screenX: event.clientX, screenY: event.clientY, nodeIds: multiSelectedIds });
      return;
    }
    setContextMenu({ kind: 'node', screenX: event.clientX, screenY: event.clientY, nodeId: node.id, nodeType: node.type });
  }, [multiSelectedIds]);
  // React Flow renders a `.react-flow__nodesselection-rect` overlay across
  // the whole multi-selection's bounding box (it's what makes dragging any
  // of the selected nodes move the whole group) — a right-click landing
  // inside that box hits the overlay, not any one node's own element, so
  // onNodeContextMenu above never fires for it. This is React Flow's own
  // dedicated hook for exactly that click.
  const onSelectionContextMenu = useCallback((event, selectedNodes) => {
    event.preventDefault();
    setContextMenu({ kind: 'multi', screenX: event.clientX, screenY: event.clientY, nodeIds: selectedNodes.map(n => n.id) });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const hasStarted = session.nowPlayingId !== null;
  const visibleEdges = useMemo(() => getVisibleEdges(edges), [edges]);
  const { startSet, jumpToSong, togglePlaying, skipNow, goBack, resumeSet } = useTransportControls({ songs, visibleEdges, setSession });
  const transitionEdgesRaw = useMemo(() => visibleEdges.filter(e => e.type === 'transition'), [visibleEdges]);

  const findEdge = useCallback((pred) => visibleEdges.find(pred), [visibleEdges]);

  const ioById = useMemo(() => {
    const m = {};
    Object.keys(songs).forEach(id => { m[id] = inOutCounts(edges, id); });
    return m;
  }, [songs, edges]);

  // Which songs actually have a node on the canvas — a library is meant to
  // hold far more songs than any one set uses, and putting every single one
  // of them on the graph at once was reported directly as making it
  // impossible to lay out a readable playlist. `session.canvasIds === null`
  // means "not migrated yet": seed it once, from whatever already has a
  // node today, so an existing graph isn't wiped the moment this ships. A
  // song added afterward (Upload, Library) is NOT auto-placed — it only
  // gets a node once explicitly dropped onto the canvas (the pane's "Add
  // node here").
  useEffect(() => {
    if (session.canvasIds == null) {
      setSession(prev => (prev.canvasIds == null ? { ...prev, canvasIds: Object.keys(songs) } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const placedSongs = useMemo(() => {
    const ids = session.canvasIds || Object.keys(songs);
    const m = {};
    ids.forEach(id => { if (songs[id]) m[id] = songs[id]; });
    return m;
  }, [session.canvasIds, songs]);
  // The "Add node here" picker's own candidate list — everything in the
  // library that doesn't already have a node on this canvas.
  const unplacedSongs = useMemo(
    () => Object.values(songs).filter(s => !placedSongs[s.id]),
    [songs, placedSongs]
  );

  // Canvas context menu's "Add node here" — places an *existing* library
  // song's node at the right-clicked spot; it never uploads new audio (that
  // clarified a real misunderstanding: "when i said i wanted to be able to
  // add a song i meant add a node, not actually upload").
  function placeSongOnCanvas(songId) {
    const at = addSongAt || { x: 60, y: 60 };
    setSongs(prev => (prev[songId] ? { ...prev, [songId]: { ...prev[songId], x: at.x, y: at.y } } : prev));
    setSession(prev => {
      const ids = prev.canvasIds || Object.keys(songs);
      return ids.includes(songId) ? prev : { ...prev, canvasIds: [...ids, songId] };
    });
    setAddSongAt(null);
  }
  // Node context menu's "Remove from graph" — takes the node off the
  // canvas without touching the song itself (still in the Library), same
  // relationship a spreadsheet has to filtering a view vs. deleting a row.
  // Disconnects every wire touching it first so nothing is left silently
  // wired to a song with no node to show it.
  const removeFromCanvas = useCallback((songId) => {
    setSession(prev => ({
      ...prev,
      canvasIds: (prev.canvasIds || Object.keys(songs)).filter(id => id !== songId),
      activePlaylist: disconnectAllWires(prev.activePlaylist, songId),
    }));
    setSelectedId(prev => (prev === songId ? null : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs]);

  const nowSong = hasStarted ? songs[session.nowPlayingId] : null;
  const elapsed = nowSong ? nowSong.durationSec - session.timeLeft : 0;

  // A click on a graph node only ever selects it now — see the long-form
  // request this answers: "Selecting a node won't make it active, selecting
  // it and then clicking play will." Any old behavior that used to start or
  // commit playback straight from a click lives in playSelected below,
  // reachable only through the detail pane's own Play button.
  const selectSong = useCallback((id) => setSelectedId(id), []);

  // Clicking empty canvas while a node is selected used to do nothing —
  // the detail pane just sat there with no obvious way to close it short
  // of its own ✕. `selectedId` is plain component state, not tied to
  // React Flow's own node-selection at all (see selectSong's own comment
  // above on why), so React Flow deselecting its nodes on a pane click
  // was never going to clear this on its own — needs its own handler.
  const onPaneClick = useCallback(() => setSelectedId(null), []);

  // The detail pane's Play button — (re)starts playback from this exact
  // song right now, auto-picking Intro when one's produced, a hard cut
  // otherwise, same default a cold set start already used. Deliberately the
  // same function whether or not a set is already running: startSet always
  // does a full, clean engine.startMain plus a session reset (queue, timeLeft,
  // etc), so jumping to an arbitrary node mid-set behaves exactly like
  // starting fresh there — and since performAdvance always looks up
  // *this* song's own wiring in activePlaylist (not "whatever the previous
  // song happened to be wired to"), the rest of the set keeps following
  // whatever's been visually laid out in the graph from this new point on.
  const playSelected = useCallback((id) => {
    const introEdge = introEdgeFor(visibleEdges, id);
    jumpToSong(id, introEdge ? 'intro' : 'cut');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, jumpToSong]);

  // The toolbar's "Start set" button — reads whatever's actually wired to
  // the Start Set node on the graph (a real, persistent connection, not a
  // one-shot trigger) and starts there. Mirrors "End set" being the one
  // real trigger for the graph's other bookend.
  function triggerStartSet() {
    const startSongId = activePlaylist.startSongId;
    if (!startSongId || !songs[startSongId]) return;
    jumpToSong(startSongId, activePlaylist.startMode === 'intro' ? 'intro' : 'cut');
  }
  // Dragging or clicking the playhead — `fraction` is 0-1 along the bar.
  // Restarts the real audio deck at the new offset when Now Playing has
  // one (engine.seekMain) and updates the wall-clock `timeLeft` to match.
  // When a produced clip (transition/outro/intro) is what's actually
  // sounding right now, engine.seekMain can't touch it (there's no "main
  // deck" to seek yet) and returns false — in that case `timeLeft` must be
  // left alone too, or the displayed countdown would silently drift out of
  // sync with whatever's really playing until the next song's own master
  // starts and resets it. The one case that still needs the manual
  // `timeLeft` update despite `seekMain` returning false is a song with no
  // uploaded master at all (nowSong.audioUrl is falsy) — there's no real
  // deck to desync from, so the UI's own wall-clock countdown is the only
  // thing scrubbing ever moves.
  function seekPlayhead(fraction) {
    if (!nowSong) return;
    const offsetSec = clamp(fraction, 0, 1) * nowSong.durationSec;
    const seeked = engine.seekMain(session.nowPlayingId, offsetSec);
    if (!seeked && nowSong.audioUrl) return;
    setSession(prev => ({ ...prev, timeLeft: Math.max(0, nowSong.durationSec - offsetSec) }));
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
    Object.keys(placedSongs).forEach(id => { p[id] = { x: placedSongs[id].x, y: placedSongs[id].y }; });
    p[END] = session.endPos || { x: 1250, y: 20 };
    p[START] = session.startPos || { x: -170, y: 20 };
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedSongs, session.startPos, session.endPos]);
  function arrangeForMe() {
    const layout = computeDagreLayout(placedSongs, session.activePlaylist);
    setSongs(prev => {
      const next = { ...prev };
      Object.keys(layout).forEach(id => { if (next[id]) next[id] = { ...next[id], x: layout[id].x, y: layout[id].y }; });
      return next;
    });
    setSession(prev => ({ ...prev, startPos: layout[START] || prev.startPos, endPos: layout[END] || prev.endPos }));
    // Dagre's computed positions land wherever its algorithm puts them, not
    // wherever the camera already happens to be — refit once the new
    // positions have actually rendered so the arranged graph isn't left
    // half outside the view. A short delay rather than an effect tied to
    // `songs`, since dragging a single node also changes `songs` and
    // shouldn't refit the whole camera.
    setTimeout(() => rf.fitView({ duration: 450, padding: 0.25 }), 60);
  }

  // Start/End have nowhere else to persist a manual drag (they aren't
  // songs) — without writing it to session.start/endPos, the very next
  // recompute of `positions` (triggered by *any* song moving, since that's
  // this memo's own dependency) snaps them straight back to the default
  // spawn spot. Reported directly as a bug: nudge Start, then nudge any
  // other node, and Start jumps back.
  //
  // Quantized to the same 22px unit as GraphPane's own dot-grid background
  // (`gap={22}`) before it's persisted — the grid was purely decorative
  // until now, implying an alignment nothing actually honored (a Blender
  // node-editor audit flagged this directly: the visible grid promises
  // structure a drag never delivered). Snapping here, once, on drop —
  // not live during the drag itself, and not on GraphPane's own internal
  // `node.position` while the gesture is in flight — means the free-form
  // feel of an in-progress drag is untouched; only the value that actually
  // gets saved (and which the position-sync effect in GraphPane.jsx then
  // reflects back onto the node) lands on the grid. Deliberately NOT
  // applied to arrangeForMe's dagre output above — that math already
  // produces its own well-spaced layout, and quantizing *node-to-node*
  // proximity (rather than to a fixed grid) is exactly the variant of
  // snapping Blender's own users report as unpredictable.
  const GRID = 22;
  const snapToGrid = (v) => Math.round(v / GRID) * GRID;
  function onDragSongPosition(id, x, y) {
    x = snapToGrid(x); y = snapToGrid(y);
    if (id === START) { setSession(prev => ({ ...prev, startPos: { x, y } })); return; }
    if (id === END) { setSession(prev => ({ ...prev, endPos: { x, y } })); return; }
    setSongs(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], x, y } } : prev));
  }

  // ---------------- the two graph highlight states: active / selected ----------------
  // Active is whatever's really playing (session.nowPlayingId); Selected is
  // purely "what was last clicked" (selectedId) — no more Playing/Next/Later.
  // Deliberately still a plain useCallback with no hover-derived dependency:
  // see the long comment this replaced for why folding a hover-driven value
  // in here specifically broke hit-testing (GraphPane's node-rebuild effect
  // depends on this function's identity). selectedId only changes on an
  // explicit click, not a hover/keystroke, so it's safe to depend on here.
  const stateFor = useCallback((id) => {
    if (id === session.nowPlayingId) return 'active';
    if (id === selectedId) return 'selected';
    return null;
  }, [session.nowPlayingId, selectedId]);

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
    Object.keys(placedSongs).forEach(id => {
      const node = activePlaylist.nodes[id];
      // A song's left arrival can come from either an ordinary incoming
      // wire (node.startMode) or from Start Set targeting it directly
      // (activePlaylist.startMode/startEdgeId — its own independent fields,
      // see wireStart's comment in core.js for why these two can no longer
      // collide). When only one exists, show that one; when a real ordinary
      // wire exists, it wins the display since that's the structural line
      // actually drawn into this socket — Start's own edge (see GraphPane)
      // still renders at its own correct handle regardless of which one
      // wins here.
      const ordinaryLeftMode = node ? node.startMode : 'none';
      const startFeedsThis = activePlaylist.startSongId === id;
      const leftActive = ordinaryLeftMode !== 'none' ? ordinaryLeftMode : (startFeedsThis ? activePlaylist.startMode : 'none');
      const leftFromStart = leftActive !== 'none' && ordinaryLeftMode === 'none' && startFeedsThis;
      const rightActive = node ? node.endMode : 'none';
      let leftOptions = [], rightOptions = [], rightCueSeconds = null;
      // A longer Intro/Outro candidate can start diverging from the plain
      // master well before its own cue point (see occludedTransitions,
      // core.js) — silently hiding a produced Transition off/onto this
      // same song whose own cue falls inside that span. Add Audio already
      // warns about this before a *new* one is saved; the picker itself
      // is the other place picking one matters, since switching *which*
      // built variant is active is exactly this same silent-occlusion
      // risk, just for an edge that's already been saved.
      if (leftActive === 'intro') {
        const candidates = introEdgesFor(visibleEdges, id);
        if (candidates.length > 1) leftOptions = candidates.map(e => {
          const occluded = occludedTransitions(visibleEdges, { type: 'intro', r: id, inSeconds: e.inSeconds });
          const occludedTitles = occluded.map(o => (songs[o.l] || {}).title).filter(Boolean);
          return { id: e.id, label: e.label || 'Intro', occludedTitles };
        });
      }
      if (rightActive === 'outro') {
        const candidates = outroEdgesFor(visibleEdges, id);
        if (candidates.length > 1) rightOptions = candidates.map(e => {
          const occluded = occludedTransitions(visibleEdges, { type: 'outro', l: id, outSeconds: e.outSeconds });
          const occludedTitles = occluded.map(o => (songs[o.r] || {}).title).filter(Boolean);
          return { id: e.id, label: e.label || 'Outro', outSeconds: e.outSeconds, occludedTitles };
        });
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
        leftActive, rightActive, leftFromStart,
        leftEdgeId: leftFromStart ? activePlaylist.startEdgeId : (node ? node.startEdgeId : null),
        rightEdgeId: node ? node.endEdgeId : null,
        leftOptions, rightOptions, rightCueSeconds,
      };
    });
    return map;
  }, [placedSongs, visibleEdges, activePlaylist, songs]);

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

  // A song can carry more than one simultaneous Transition now — adding
  // one leaves whatever else it already carries alone (see
  // addTransitionConnection, core.js); removing one specific edge (a
  // hover-✕ on its own line) leaves any others untouched too.
  const commitAddTransition = useCallback((source, target, edgeId) => {
    setSession(prev => ({ ...prev, activePlaylist: addTransitionConnection(prev.activePlaylist, source, target, edgeId) }));
  }, [setSession]);
  const onDisconnectTransition = useCallback((source, edgeId) => {
    setSession(prev => ({ ...prev, activePlaylist: removeTransitionConnection(prev.activePlaylist, source, edgeId) }));
  }, [setSession]);

  // Node context menu's "Autoconnect transitions" — wires every real
  // produced Transition already leading out of this song at once. The
  // canvas context menu's "Autoconnect all transitions" does the same for
  // every placed song. Neither one touches None/Intro/Outro — see
  // autoconnectNodeTransitions's own comment (core.js) for why that's
  // deliberate, not an oversight.
  const onAutoconnectNode = useCallback((songId) => {
    setSession(prev => ({ ...prev, activePlaylist: autoconnectNodeTransitions(visibleEdges, prev.activePlaylist, songId) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges]);
  const onAutoconnectAll = useCallback(() => {
    const ids = Object.keys(placedSongs);
    setSession(prev => ({ ...prev, activePlaylist: autoconnectFullGraph(visibleEdges, prev.activePlaylist, ids) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, placedSongs]);
  // The multi-selection context menu's own versions of the per-node
  // actions above — folds the same core.js function over every selected
  // id in one setSession, not one call per node, so this is one undo-
  // worthy state change instead of `songIds.length` of them.
  const onAutoconnectSelection = useCallback((songIds) => {
    setSession(prev => ({
      ...prev,
      activePlaylist: songIds.reduce((pl, id) => autoconnectNodeTransitions(visibleEdges, pl, id), prev.activePlaylist),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges]);
  const onDisconnectAllSelection = useCallback((songIds) => {
    setSession(prev => ({
      ...prev,
      activePlaylist: songIds.reduce((pl, id) => disconnectAllWires(pl, id), prev.activePlaylist),
    }));
  }, []);
  const onRemoveFromGraphSelection = useCallback((songIds) => {
    setSession(prev => ({
      ...prev,
      canvasIds: (prev.canvasIds || Object.keys(songs)).filter(id => !songIds.includes(id)),
      activePlaylist: songIds.reduce((pl, id) => disconnectAllWires(pl, id), prev.activePlaylist),
    }));
    setSelectedId(prev => (songIds.includes(prev) ? null : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs]);

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
      // Adds this transition alongside whatever else the song already
      // carries, rather than replacing it — a song can transition into
      // more than one place at once now (see addTransitionConnection,
      // core.js); dragging a second one in used to silently discard the
      // first, which was a real footgun.
      commitAddTransition(conn.source, conn.target, candidates[0].id);
      return;
    }
    const endEdgeId = sourceType === 'outro' ? ((outroEdgeFor(visibleEdges, conn.source)) || {}).id || null : null;
    const startEdgeId = targetType === 'intro' ? ((introEdgeFor(visibleEdges, conn.target)) || {}).id || null : null;
    commitWire(conn.source, conn.target, sourceType, endEdgeId, targetType, startEdgeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, commitWire, commitStartWire, commitAddTransition]);

  // A socket's dropdown (only rendered when 2+ candidates exist — see
  // socketDataById) swaps which produced edge fills an already-active
  // slot, leaving the slot itself and any wired destination untouched. A
  // left-side switch on a song whose Intro is showing purely because Start
  // Set feeds it directly (leftFromStart — see socketDataById) has to land
  // on activePlaylist's own startEdgeId instead of the song's ordinary
  // node entry, or the switch would silently do nothing to what Start
  // actually plays (see wireStart's comment in core.js).
  const selectVariant = useCallback((songId, side, edgeId) => {
    setSession(prev => {
      if (side === 'left' && prev.activePlaylist.startSongId === songId
        && (!prev.activePlaylist.nodes[songId] || prev.activePlaylist.nodes[songId].startMode === 'none')) {
        return { ...prev, activePlaylist: { ...prev.activePlaylist, startEdgeId: edgeId } };
      }
      return {
        ...prev,
        activePlaylist: side === 'left'
          ? setStartVariant(prev.activePlaylist, songId, edgeId)
          : setEndVariant(prev.activePlaylist, songId, edgeId),
      };
    });
  }, [setSession]);

  // The hover-✕ on an active wire (see GraphPane's edge rendering) —
  // deliberately not "click the wire itself", which would make a stray
  // click destroy part of a built playlist the same way clicking to end
  // a set used to risk before that got a confirm modal of its own.
  const disconnectSong = useCallback((songId) => {
    setSession(prev => ({ ...prev, activePlaylist: unwireOutput(prev.activePlaylist, songId) }));
  }, [setSession]);

  // ---------------- search (Fuse.js) ----------------
  // Scoped to what's actually on the canvas — this page's search is for
  // finding/focusing a node on the graph, not browsing the whole library
  // (that's what the Library page is for).
  const fuse = useMemo(() => new Fuse(Object.values(placedSongs), { keys: ['title', 'artist'], threshold: 0.35, ignoreLocation: true }), [placedSongs]);
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

  // EndNode's "part of your plan"/"not queued" hint — now reads the graph's
  // actual wiring (is any song's output connected to End) rather than the
  // one-shot manual queue, which nothing writes into anymore now that the
  // Next list and the explicit End Set trigger are both gone.
  const endWired = useMemo(
    () => Object.keys(activePlaylist.nodes).some(id => activePlaylist.nodes[id].nextSongId === END),
    [activePlaylist]
  );
  const selectedSong = selectedId ? placedSongs[selectedId] : null;

  if (Object.keys(songs).length === 0) {
    return (
      <div className="page page-perform">
        <div className="empty-state">
          <div className="empty-state-title">Your graph is empty</div>
          <div className="empty-state-sub">Add your first song, then come back here to lay out your set and connect it to others.</div>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={goUpload}>Upload a song</button>
            {onLoadExample && <button className="btn btn-ghost" onClick={onLoadExample}>Load an example graph</button>}
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
          <Icon path={ICONS.grid} size={13} /> Autoarrange
        </button>

        <div className="toolbar-spacer" />

        {/* Just three controls now — Start, Pause/Resume, Stop. Ending a set
            gracefully is purely a consequence of the graph's own wiring
            leading into the End node (see playlistNextHop/performAdvance);
            there's no separate "End set" trigger to fake that anymore, and
            no confirm modal in the way of a plain stop. */}
        {!hasStarted && activePlaylist.startSongId && songs[activePlaylist.startSongId] && (
          <button className="toolbar-start-set-btn" onClick={triggerStartSet} data-tooltip={'Start playing from ' + songs[activePlaylist.startSongId].title}>
            <Icon path={ICONS.play} filled size={12} /> Start
          </button>
        )}
        {hasStarted && (
          <>
            <button className="toolbar-btn" onClick={togglePlaying} data-tooltip={session.isPlaying ? 'Pause' : 'Resume'}>
              <Icon path={session.isPlaying ? ICONS.pause : ICONS.play} filled={!session.isPlaying} size={13} /> {session.isPlaying ? 'Pause' : 'Resume'}
            </button>
            <button className="toolbar-stop-set-btn" onClick={resumeSet} data-tooltip="Stop right now">
              <Icon path={ICONS.stop} filled size={12} /> Stop
            </button>
          </>
        )}
      </div>

      <div className="perform-layout">
        <div className="graph-pane">
          <GraphPane
            songs={placedSongs} positions={positions} transitionEdgesRaw={transitionEdgesRaw} activePlaylist={activePlaylist}
            socketDataById={socketDataById} onToggleSocket={toggleSocket} onSelectVariant={selectVariant} mixingEdgeId={mixingEdgeId}
            onConnect={handleConnect} isValidConnection={isValidConnection} onDisconnectSong={disconnectSong}
            onDisconnectTransition={onDisconnectTransition} onDisconnectStart={disconnectStart}
            stateFor={stateFor} ioById={ioById} hoveredId={hoveredId} setHoveredId={setHoveredId}
            matchIds={matchIds} searchActive={searchActive}
            onDragSongPosition={onDragSongPosition} onSelectSong={selectSong}
            endQueued={endWired}
            nowPlayingId={session.nowPlayingId} nowElapsedSec={elapsed} nowDurationSec={nowSong ? nowSong.durationSec : 0}
            onPaneClick={onPaneClick}
            onPaneContextMenu={onPaneContextMenu} onNodeContextMenu={onNodeContextMenu}
            onSelectionContextMenu={onSelectionContextMenu}
            onMultiSelectionChange={setMultiSelectedIds}
          />
        </div>
        {selectedSong && (
          <DetailPane
            song={selectedSong} socketData={socketDataById[selectedId]} io={ioById[selectedId] || { inCount: 0, outCount: 0 }}
            onPlay={() => playSelected(selectedId)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {/* Just start/pause/stop plus the graph itself now covers everything
          the old side panel, bottom queue bar, and End Set modal used to —
          see the toolbar and player-bar above/below for why each of those
          was removed rather than ported over as-is. */}
      {hasStarted && (
        <div className="player-bar player-bar-bottom">
          <div className="player-bar-now">
            <AlbumArt className="player-bar-art" url={nowSong.coverUrl} />
            <div className="player-bar-text">
              <div className="player-bar-title">{nowSong.title}</div>
              <div className="player-bar-artist">{nowSong.artist}</div>
            </div>
          </div>

          <button className="icon-btn" onClick={goBack} aria-label="Back" data-tooltip="Back">
            <Icon path={ICONS.skipBack} filled size={16} />
          </button>
          <button className="icon-btn" onClick={togglePlaying} aria-label={session.isPlaying ? 'Pause' : 'Play'}>
            <Icon path={session.isPlaying ? ICONS.pause : ICONS.play} filled={!session.isPlaying} size={16} />
          </button>
          <button className="icon-btn" onClick={skipNow} aria-label="Skip to next" data-tooltip="Skip to next">
            <Icon path={ICONS.skip} filled size={16} />
          </button>

          <span className="mono-num player-bar-time">{fmtTime(elapsed)}</span>
          <div className="player-bar-scrub"><Playhead onSeek={seekPlayhead} /></div>
          <span className="mono-num player-bar-time">{fmtTime(nowSong.durationSec)}</span>

          <div className="player-bar-next">
            {queueHead ? (
              <>
                {/* What's actually happening between the two songs — a
                    transition, an outro into a cut, a plain cut into an
                    intro, etc — reusing the exact same summary the graph's
                    own hop model already computes, so this can never say
                    something different than what the wiring will really do. */}
                <span className="player-bar-hop-type">{hopSummary(queueHead)}</span>
                {queueHead.id === END ? (
                  <span className="player-bar-next-title player-bar-next-end">End</span>
                ) : (
                  <>
                    <AlbumArt className="player-bar-art-sm" url={nextSong ? nextSong.coverUrl : null} />
                    <span className="player-bar-next-title">{nextSong ? nextSong.title : ''}</span>
                  </>
                )}
                {mixingIntoSong && (
                  <span className="player-bar-crossfade" style={{ '--pct': crossfadePct + '%' }} data-tooltip={crossfadePct + '% mixed'} />
                )}
              </>
            ) : <span className="player-bar-next-empty">nothing wired next</span>}
          </div>

          <VolumeControl volume={volume} onChange={handleVolumeChange} />
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu} songs={songs} activePlaylist={activePlaylist}
          onClose={closeContextMenu}
          onAddNodeHere={() => { setAddSongAt({ x: contextMenu.flowX, y: contextMenu.flowY }); closeContextMenu(); }}
          onArrangeForMe={() => { arrangeForMe(); closeContextMenu(); }}
          onAutoconnectAll={() => { onAutoconnectAll(); closeContextMenu(); }}
          onFocus={(id) => { focusOn(id); closeContextMenu(); }}
          onSetAsStart={(id) => { setAsStart(id); closeContextMenu(); }}
          onAutoconnectNode={(id) => { onAutoconnectNode(id); closeContextMenu(); }}
          onDisconnectAll={(id) => { disconnectAll(id); closeContextMenu(); }}
          onEditInLibrary={() => { goLibrary(); closeContextMenu(); }}
          onRemoveFromGraph={(id) => { removeFromCanvas(id); closeContextMenu(); }}
          onDisconnectStart={() => { disconnectStart(); closeContextMenu(); }}
          onDisconnectEnd={(id) => { disconnectSong(id); closeContextMenu(); }}
          onAutoconnectSelection={(ids) => { onAutoconnectSelection(ids); closeContextMenu(); }}
          onDisconnectAllSelection={(ids) => { onDisconnectAllSelection(ids); closeContextMenu(); }}
          onRemoveFromGraphSelection={(ids) => { onRemoveFromGraphSelection(ids); closeContextMenu(); }}
        />
      )}

      {addSongAt && (
        <AddNodeModal songs={unplacedSongs} onPick={placeSongOnCanvas} onCancel={() => setAddSongAt(null)} />
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
  onAddNodeHere, onArrangeForMe, onAutoconnectAll, onFocus, onSetAsStart, onAutoconnectNode, onDisconnectAll, onEditInLibrary, onRemoveFromGraph,
  onDisconnectStart, onDisconnectEnd, onAutoconnectSelection, onDisconnectAllSelection, onRemoveFromGraphSelection,
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
  if (menu.kind === 'multi') {
    // Same three per-node actions the single-node menu below offers,
    // applied across every selected node at once (see onAutoconnectSelection
    // etc., PerformPage.jsx) — Set as Start/Focus here/Edit in Library
    // stay single-node-only concepts, so they're not offered here.
    items = (
      <>
        <div className="context-menu-heading">{menu.nodeIds.length} songs selected</div>
        <button className="context-menu-item" onClick={() => onAutoconnectSelection(menu.nodeIds)}>Autoconnect transitions</button>
        <button className="context-menu-item" onClick={() => onDisconnectAllSelection(menu.nodeIds)}>Disconnect all wires</button>
        <button className="context-menu-item" onClick={() => onRemoveFromGraphSelection(menu.nodeIds)}>Remove from graph</button>
      </>
    );
  } else if (menu.kind === 'pane') {
    items = (
      <>
        <button className="context-menu-item" onClick={onAddNodeHere}>Add node here</button>
        <button className="context-menu-item" onClick={onArrangeForMe}>Autoarrange</button>
        {/* Wires every real produced Transition already leading out of every
            placed song at once — see autoconnectFullGraph's own comment
            (core.js) for why this deliberately only ever touches
            Transitions, never None/Intro/Outro. */}
        <button className="context-menu-item" onClick={onAutoconnectAll}>Autoconnect all transitions</button>
      </>
    );
  } else if (menu.nodeType === 'song') {
    items = (
      <>
        <button className="context-menu-item" onClick={() => onFocus(menu.nodeId)}>Focus here</button>
        <button className="context-menu-item" onClick={() => onSetAsStart(menu.nodeId)}>Set as Start</button>
        <button className="context-menu-item" onClick={() => onAutoconnectNode(menu.nodeId)}>Autoconnect transitions</button>
        <button className="context-menu-item" onClick={() => onDisconnectAll(menu.nodeId)}>Disconnect all wires</button>
        <button className="context-menu-item" onClick={onEditInLibrary}>Edit in Library</button>
        <div className="context-menu-sep" />
        {/* Deleting a song outright is a Library-only action now — this menu
            only ever offers removing the node from the graph (it stays in
            the Library, can be re-added later), never the destructive
            delete, which doesn't belong on a menu you can reach mid-set. */}
        <button className="context-menu-item" onClick={() => onRemoveFromGraph(menu.nodeId)}>Remove from graph</button>
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

// The canvas context menu's "Add node here" — a plain search over the
// library's *unplaced* songs (never an upload form: adding a node means
// placing something that already exists, see placeSongOnCanvas's own
// comment for the misunderstanding this corrects), closed the moment a
// result is picked.
function AddNodeModal({ songs, onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const fuse = useMemo(() => new Fuse(songs, { keys: ['title', 'artist'], threshold: 0.35, ignoreLocation: true }), [songs]);
  const results = useMemo(() => {
    const q = query.trim();
    return (q ? fuse.search(q).map(r => r.item) : songs).slice(0, 40);
  }, [fuse, query, songs]);

  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Add node</div>
        <input
          className="input" autoFocus placeholder="Find a song already in your library…"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        <div className="add-node-results">
          {results.length === 0 && (
            <div className="add-node-empty">
              {songs.length === 0 ? 'Every song in your library already has a node here.' : 'No match.'}
            </div>
          )}
          {results.map(s => (
            <button key={s.id} className="add-node-result" onClick={() => onPick(s.id)}>
              <AlbumArt className="add-node-result-art" url={s.coverUrl} />
              <span className="add-node-result-text">
                <span className="add-node-result-title">{s.title}</span>
                <span className="add-node-result-artist">{s.artist}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// The right-side detail pane — the *only* place a socket's full specifics
// (which type, which produced edge, its own cue point) show for a song
// that isn't currently playing. Selecting a node just shows this; nothing
// here starts playback except the one explicit Play button, matching the
// Selected-vs-Active split this replaces the old always-on-canvas socket
// dropdowns' implicit "click a socket to see it" behavior with.
function DetailPane({ song, socketData, io, onPlay, onClose }) {
  const sd = socketData || {
    leftActive: 'none', rightActive: 'none', leftEdgeId: null, rightEdgeId: null,
    leftOptions: [], rightOptions: [], rightCueSeconds: null,
  };
  const SOCKET_LABEL = { none: 'None', intro: 'Intro', outro: 'Outro', transition: 'Transition' };
  return (
    <div className="detail-pane">
      <button className="detail-pane-close icon-btn" onClick={onClose} aria-label="Close">
        <Icon path={ICONS.close} size={14} />
      </button>
      <div className="detail-pane-header">
        <AlbumArt className="detail-pane-art" url={song.coverUrl} />
        <div>
          <div className="detail-pane-title">{song.title}</div>
          <div className="detail-pane-artist">{song.artist}</div>
        </div>
      </div>
      <div className="detail-pane-tags">
        <span className="tag tag-accent">{song.bpm} BPM</span>
        <span className="tag tag-good">{song.key}</span>
        <span className="tag">{fmtTime(song.durationSec)}</span>
      </div>
      <button className="btn btn-primary detail-pane-play" onClick={onPlay}>
        <Icon path={ICONS.play} filled size={13} /> Play
      </button>
      <div className="detail-pane-section">
        <div className="detail-pane-section-title">Input <span className="detail-pane-count">↓{io.inCount}</span></div>
        <div className="detail-pane-row">{SOCKET_LABEL[sd.leftActive]}{sd.leftOptions.length > 1 && ' (' + sd.leftOptions.length + ' variants)'}</div>
      </div>
      <div className="detail-pane-section">
        <div className="detail-pane-section-title">Output <span className="detail-pane-count">↑{io.outCount}</span></div>
        <div className="detail-pane-row">
          {SOCKET_LABEL[sd.rightActive]}{sd.rightOptions.length > 1 && ' (' + sd.rightOptions.length + ' variants)'}
          {sd.rightCueSeconds != null && <span className="detail-pane-cue"> · cue at {fmtTime(sd.rightCueSeconds)}</span>}
        </div>
      </div>
    </div>
  );
}

// The player bar's volume control — collapsed to a plain icon most of the
// time (most things should disappear until clicked; a slider sitting open
// at all times was needless permanent width in the bar), expanding into
// the actual slider in a small popover on click and closing again on any
// outside click, the same pattern every other popover in this app already
// follows.
function VolumeControl({ volume, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);
  return (
    <div className="player-bar-volume" ref={ref}>
      <button
        className="icon-btn" aria-label="Volume" data-tooltip={Math.round(volume * 100) + '%'}
        onClick={() => setOpen(o => !o)}
      >
        <Icon path={ICONS.volume} size={15} />
      </button>
      {open && (
        <div className="player-bar-volume-popover">
          <input
            type="range" min="0" max="1" step="0.01" value={volume}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-label="Volume" autoFocus
          />
        </div>
      )}
    </div>
  );
}
