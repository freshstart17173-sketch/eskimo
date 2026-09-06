import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import Fuse from 'fuse.js';
import {
  END, clamp, getVisibleEdges, inOutCounts, oneHopReachable, computeReachability, advanceSession,
} from '../core.js';
import { computeDagreLayout, NODE_W, NODE_H, END_W, END_H } from '../graphLayout.js';
import GraphPane from './GraphPane.jsx';
import SequencePane from './SequencePane.jsx';
import QueueBar from './QueueBar.jsx';
import { Icon, ICONS } from './shared.jsx';

export default function PerformPage({ songs, setSongs, edges, session, setSession, venueName, goUpload, onLoadExample }) {
  const rf = useReactFlow();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [layoutMode, setLayoutMode] = useState('manual'); // 'manual' | 'auto'
  const [hoveredId, setHoveredId] = useState(null);
  const searchInputRef = useRef(null);

  const [stagedId, setStagedId] = useState(null);
  const [stagedMode, setStagedMode] = useState('cut'); // 'transition' | 'cut'
  const [stagedEdgeId, setStagedEdgeId] = useState(null); // which produced transition, when there's more than one
  const [stagedStarting, setStagedStarting] = useState('cut');

  useEffect(() => { setStagedId(null); }, [session.nowPlayingId]);

  const hasStarted = session.nowPlayingId !== null;
  const visibleEdges = useMemo(() => getVisibleEdges(edges), [edges]);
  const transitionEdgesRaw = useMemo(() => visibleEdges.filter(e => e.type === 'transition'), [visibleEdges]);

  const reach = useMemo(
    () => hasStarted
      ? computeReachability(songs, visibleEdges, session.nowPlayingId, session.queue)
      : { fromId: null, tier1: new Set(Object.keys(songs)) },
    [songs, visibleEdges, hasStarted, session.nowPlayingId, session.queue]
  );
  const { fromId, tier1 } = reach;

  const usedIds = useMemo(() => new Set([session.nowPlayingId, ...session.queue.map(q => q.id)]), [session.nowPlayingId, session.queue]);
  const laterIds = useMemo(
    () => stagedId ? oneHopReachable(visibleEdges, stagedId, new Set([...usedIds, ...tier1])) : new Set(),
    [stagedId, visibleEdges, usedIds, tier1]
  );

  const findEdge = useCallback((pred) => visibleEdges.find(pred), [visibleEdges]);
  // Two songs can have more than one produced transition between them —
  // Add Audio never de-dupes, and Library already lists every one. Collect
  // all of them here rather than just the first, so none are silently
  // unreachable in Perform.
  const findEdges = useCallback((pred) => visibleEdges.filter(pred), [visibleEdges]);

  const ioById = useMemo(() => {
    const m = {};
    Object.keys(songs).forEach(id => { m[id] = inOutCounts(edges, id); });
    return m;
  }, [songs, edges]);

  function optionsFor(id) {
    if (id === END) {
      const outroEdge = findEdge(e => e.type === 'outro' && e.l === fromId);
      return { id, title: 'End Set', outroEdge };
    }
    const s = songs[id];
    const transitionEdges = findEdges(e => e.type === 'transition' && e.l === fromId && e.r === id);
    const introEdge = findEdge(e => e.type === 'intro' && e.r === id);
    return { id, title: s.title, artist: s.artist, transitionEdges, transitionEdge: transitionEdges[0] || null, introEdge };
  }

  function stage(id) {
    if (id === session.nowPlayingId) return;
    const qIdx = session.queue.findIndex(q => q.id === id);
    if (qIdx >= 0) { setSession(prev => ({ ...prev, queue: prev.queue.slice(0, qIdx) })); setStagedId(null); return; }
    if (!fromId) return;
    if (id === END) { setStagedId(END); return; }
    const transitionEdges = findEdges(e => e.type === 'transition' && e.l === fromId && e.r === id);
    const introEdge = findEdge(e => e.type === 'intro' && e.r === id);
    setStagedId(id);
    setStagedMode(transitionEdges.length > 0 ? 'transition' : 'cut');
    setStagedEdgeId(transitionEdges[0] ? transitionEdges[0].id : null);
    setStagedStarting(introEdge ? 'intro' : 'cut');
  }

  function commitStaged() {
    if (!stagedId) return;
    if (stagedId === END) {
      setSession(prev => ({ ...prev, queue: [...prev.queue, { id: END, ending: prev.endingChoice }] }));
      setStagedId(null);
      return;
    }
    const item = stagedMode === 'transition'
      ? { id: stagedId, mode: 'transition', edgeId: stagedEdgeId }
      : { id: stagedId, mode: 'cut', ending: session.endingChoice, starting: stagedStarting };
    setSession(prev => ({ ...prev, queue: [...prev.queue, item] }));
    setStagedId(null);
  }

  function startSet(songId, starting) {
    const song = songs[songId];
    setSession(prev => ({
      ...prev, nowPlayingId: songId, startMethod: starting,
      queue: [], isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, endingChoice: 'cut',
    }));
  }
  function togglePlaying() { setSession(prev => ({ ...prev, isPlaying: !prev.isPlaying })); }
  function resumeSet() { setSession(prev => ({ ...prev, setEnded: false, isPlaying: false, nowPlayingId: null, startMethod: null, queue: [], timeLeft: 0, endingChoice: 'cut', autoHistory: [] })); }
  function setEndingChoice(choice) { setSession(prev => ({ ...prev, endingChoice: choice })); }
  function removeQueueFrom(index) { setSession(prev => ({ ...prev, queue: prev.queue.slice(0, index) })); }
  // the manual "Next song" button — same rule the set-clock's timer uses (advanceSession, core.js)
  function skipNow() { setSession(prev => advanceSession(prev, songs, visibleEdges)); }

  // ---------------- layout: manual (stored x/y) or auto (dagre) ----------------
  const autoPositions = useMemo(() => layoutMode === 'auto' ? computeDagreLayout(songs, edges) : null, [layoutMode, songs, edges]);
  const positions = useMemo(() => {
    const p = {};
    Object.keys(songs).forEach(id => { p[id] = autoPositions ? autoPositions[id] : { x: songs[id].x, y: songs[id].y }; });
    p[END] = autoPositions ? autoPositions[END] : { x: 1250, y: 20 };
    return p;
  }, [songs, autoPositions]);

  function onDragSongPosition(id, x, y) {
    setSongs(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], x, y } } : prev));
  }

  // ---------------- the three graph highlight states: playing / next / later ----------------
  const queueIds = session.queue.map(q => q.id);
  const stateFor = useCallback((id) => {
    if (id === session.nowPlayingId) return 'playing';
    if (queueIds[0] === id) return 'next';
    if (queueIds.slice(1).includes(id)) return 'later';
    if (tier1.has(id)) return 'next';
    if (laterIds.has(id)) return 'later';
    return null;
  }, [session.nowPlayingId, queueIds, tier1, laterIds]);

  // ---------------- edges: tiered coloring, all solid, no per-edge labels ----------------
  const transitionEdges = useMemo(() => transitionEdgesRaw.map(e => {
    let tier = 'base';
    if (e.l === fromId && tier1.has(e.r)) tier = 'next';
    else if (e.l === stagedId && laterIds.has(e.r)) tier = 'later';
    return { ...e, _tier: tier };
  }), [transitionEdgesRaw, fromId, tier1, stagedId, laterIds]);

  const hasOutroForPlaying = !!findEdge(e => e.type === 'outro' && e.l === session.nowPlayingId);

  // ---------------- search (Fuse.js) ----------------
  const fuse = useMemo(() => new Fuse(Object.values(songs), { keys: ['title', 'artist'], threshold: 0.35, ignoreLocation: true }), [songs]);
  const searchActive = searchQuery.trim().length > 0;
  const matches = useMemo(() => (searchActive ? fuse.search(searchQuery).map(r => r.item) : []), [fuse, searchQuery, searchActive]);
  const matchIds = useMemo(() => new Set(matches.map(m => m.id)), [matches]);
  const suggestions = useMemo(() => matches.slice(0, 7), [matches]);

  function centerFor(id) {
    const pos = positions[id];
    if (!pos) return null;
    const w = id === END ? END_W : NODE_W, h = id === END ? END_H : NODE_H;
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

  // ---------------- hover-card data (same commit functions as the Sequence pane) ----------------
  const hoverCardFor = useCallback((id) => {
    if (!hasStarted || hoveredId !== id || !tier1.has(id)) return null;
    const opts = optionsFor(id);
    const isStagedHere = stagedId === id;
    return {
      isStaged: isStagedHere, mode: stagedMode, hasTransition: !!opts.transitionEdge,
      onStage: () => stage(id), onConfirm: commitStaged, onSetMode: setStagedMode,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStarted, hoveredId, tier1, stagedId, stagedMode, fromId, songs]);

  const nowSong = hasStarted ? songs[session.nowPlayingId] : null;
  const cueBarPct = nowSong && nowSong.durationSec ? Math.round((1 - session.timeLeft / nowSong.durationSec) * 100) : 0;

  // Spotify-style dual display: once we're within CROSSFADE_LOOKAHEAD_SEC of
  // the committed transition's real cue point, show both songs instead of
  // just Playing. Only applies to a committed (queued) transition — staging
  // something in Next is a preview, not a commitment, so it doesn't trigger this.
  const queueHead = session.queue[0];
  const committedEdge = (queueHead && queueHead.mode === 'transition' && queueHead.edgeId)
    ? edges.find(e => e.id === queueHead.edgeId) : null;
  let mixingIntoSong = null, crossfadePct = 0;
  if (nowSong && queueHead && queueHead.mode === 'transition') {
    const triggerAt = committedEdge && committedEdge.outSeconds != null ? committedEdge.outSeconds : nowSong.durationSec;
    const elapsed = nowSong.durationSec - session.timeLeft;
    if (triggerAt - elapsed <= 8) {
      mixingIntoSong = songs[queueHead.id] || null;
      crossfadePct = clamp(Math.round((1 - Math.max(0, triggerAt - elapsed) / 8) * 100), 0, 100);
    }
  }

  // Each candidate's countdown is its own transition's cue point, not a
  // shared clock: a built transition edge carries a real outSeconds (when
  // should must-trigger by, in Now Playing's own timeline). Candidates with
  // time still on their clock float to the top, soonest-expiring first;
  // candidates with no timed transition (reachable only via a cut, which
  // never expires) sink below them, since there's no urgency to a cut.
  const nextRows = useMemo(() => {
    const elapsed = nowSong ? nowSong.durationSec - session.timeLeft : 0;
    const rows = Array.from(tier1).map(id => {
      const opts = optionsFor(id);
      const hasRealCue = !!(opts.transitionEdge && opts.transitionEdge.outSeconds != null);
      // every row shows a countdown — a real per-edge cue point when one's
      // been built, otherwise the shared "time left in Now Playing" clock
      // as a sane default, never blank. basisSec is the countdown's 100%
      // mark (the cue point itself, or the full song when there's no cue)
      // so the drain bar always starts full and empties to zero right as
      // the trigger fires.
      const secondsLeft = hasRealCue ? Math.max(0, opts.transitionEdge.outSeconds - elapsed) : session.timeLeft;
      const basisSec = hasRealCue ? opts.transitionEdge.outSeconds : (nowSong ? nowSong.durationSec : 210);
      return { ...opts, secondsLeft, hasRealCue, basisSec };
    });
    return rows.sort((a, b) => {
      if (a.hasRealCue && b.hasRealCue) return a.secondsLeft - b.secondsLeft;
      if (a.hasRealCue) return -1;
      if (b.hasRealCue) return 1;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier1, fromId, songs, nowSong, session.timeLeft]);
  const laterRows = stagedId ? Array.from(laterIds).map(id => optionsFor(id)) : [];

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
            <button className="icon-btn" onClick={() => stepMatch(-1)} disabled={matches.length === 0}><Icon path={ICONS.chevronLeft} size={13} /></button>
            <span className="search-count mono-num">{matches.length ? (matchIndex + 1) + '/' + matches.length : '0/0'}</span>
            <button className="icon-btn" onClick={() => stepMatch(1)} disabled={matches.length === 0}><Icon path={ICONS.chevron} size={13} /></button>
          </div>
        )}

        <button className="toolbar-btn" onClick={focusActive} data-tooltip="Focus on the playing song">
          <Icon path={ICONS.target} size={13} /> Focus active
        </button>
        <button className={'toolbar-btn' + (layoutMode === 'auto' ? ' active' : '')} onClick={() => setLayoutMode(m => (m === 'auto' ? 'manual' : 'auto'))} data-tooltip="Toggle auto-arrange">
          <Icon path={ICONS.grid} size={13} /> {layoutMode === 'auto' ? 'Auto-arranged' : 'Arrange for me'}
        </button>

        <div className="legend toolbar-spacer">
          <span><i className="swatch swatch-playing" />playing</span>
          <span><i className="swatch swatch-next" />next</span>
          <span><i className="swatch swatch-later" />later</span>
        </div>
      </div>

      <div className="perform-layout">
        <div className="graph-pane">
          <GraphPane
            songs={songs} positions={positions} transitionEdges={transitionEdges}
            stateFor={stateFor} ioById={ioById} hoveredId={hoveredId} setHoveredId={setHoveredId}
            matchIds={matchIds} searchActive={searchActive}
            onDragSongPosition={onDragSongPosition} hoverCardFor={hoverCardFor}
            onStageEnd={() => hasStarted && stage(END)} endQueued={queueIds.includes(END)}
          />
          <QueueBar songs={songs} nowPlayingId={session.nowPlayingId} queue={session.queue} autoHistory={session.autoHistory} onRemoveQueueItem={removeQueueFrom} />
        </div>

        <SequencePane
          songs={songs} session={session} venueName={venueName}
          hasStarted={hasStarted} nowSong={nowSong} cueBarPct={cueBarPct} hasOutroForPlaying={hasOutroForPlaying}
          mixingIntoSong={mixingIntoSong} crossfadePct={crossfadePct}
          nextRows={nextRows} laterRows={laterRows} stagedId={stagedId} stagedMode={stagedMode} stagedEdgeId={stagedEdgeId}
          onTogglePlaying={togglePlaying} onResumeSet={resumeSet} onStartSet={startSet} onSetEndingChoice={setEndingChoice}
          onStage={stage} onCommitStaged={commitStaged} onSetStagedMode={setStagedMode} onSetStagedEdgeId={setStagedEdgeId}
          onSkipNext={skipNow}
        />
      </div>
    </div>
  );
}
