import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import Fuse from 'fuse.js';
import {
  END, getVisibleEdges, inOutCounts, queueTailId, removeQueueItem,
  transitionCandidates, cutCandidates, clamp,
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
  const [layoutMode, setLayoutMode] = useState('manual'); // 'manual' | 'auto'
  const [hoveredId, setHoveredId] = useState(null);
  const searchInputRef = useRef(null);
  const [endSetModalOpen, setEndSetModalOpen] = useState(false);
  const [endSetEnding, setEndSetEnding] = useState('cut');

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
    // point yet never expires, so it sinks below the timed ones.
    return rows.map(r => {
      const hasCue = r.outSeconds != null;
      const secondsLeft = hasCue ? Math.max(0, r.outSeconds - elapsed) : session.timeLeft;
      const basisSec = hasCue ? r.outSeconds : (nowSong ? nowSong.durationSec : 210);
      return { ...r, hasCue, secondsLeft, basisSec };
    }).sort((a, b) => {
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
  function commitCutOrOutro(destId) {
    const introEdge = findEdge(e => e.type === 'intro' && e.r === destId);
    setSession(prev => ({
      ...prev,
      queue: [...prev.queue, { id: destId, mode: 'cut', ending: prev.nextMode === 'outro' ? 'outro' : 'cut', starting: introEdge ? 'intro' : 'cut' }],
    }));
  }
  function commitRow(row) {
    if (row.kind === 'transition') commitTransition(row.edgeId, row.destId);
    else commitCutOrOutro(row.destId);
  }
  function commitForId(id) {
    if (isTransitionMode) {
      const edge = transitionCandidates(visibleEdges, fromId, usedIds).find(e => e.r === id);
      if (edge) commitTransition(edge.id, id);
    } else if (nextCandidateIds.has(id)) {
      commitCutOrOutro(id);
    }
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

  function startSet(songId, starting) {
    const song = songs[songId];
    const introEdge = starting === 'intro' ? findEdge(e => e.type === 'intro' && e.r === songId) : null;
    engine.startMain(song, introEdge);
    setSession(prev => ({
      ...prev, nowPlayingId: songId, startMethod: starting,
      queue: [], isPlaying: true, timeLeft: song ? song.durationSec : 210, setEnded: false, nextMode: 'transition',
    }));
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
    if (nextCandidateIds.has(id)) return 'next';
    if (laterCandidateIds.has(id)) return 'later';
    return null;
  }, [session.nowPlayingId, queueIds, nextCandidateIds, laterCandidateIds]);

  // ---------------- edges: tiered coloring, all solid, no per-edge labels ----------------
  // Only meaningful in Transition mode — a cut/outro candidate isn't backed
  // by a specific edge, so there's nothing on the canvas to highlight for it.
  const transitionEdges = useMemo(() => transitionEdgesRaw.map(e => {
    let tier = 'base';
    if (isTransitionMode && e.l === fromId && nextCandidateIds.has(e.r)) tier = 'next';
    else if (isTransitionMode && hoveredId && e.l === hoveredId && laterCandidateIds.has(e.r)) tier = 'later';
    return { ...e, _tier: tier };
  }), [transitionEdgesRaw, isTransitionMode, fromId, nextCandidateIds, hoveredId, laterCandidateIds]);

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

  // ---------------- graph hover-card: one click, commits immediately ----------------
  const hoverCardFor = useCallback((id) => {
    if (!hasStarted || hoveredId !== id || !nextCandidateIds.has(id)) return null;
    return {
      label: isTransitionMode ? 'Set as next — transition' : session.nextMode === 'outro' ? 'Set as next — outro' : 'Set as next — cut',
      onCommit: () => commitForId(id),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStarted, hoveredId, nextCandidateIds, isTransitionMode, session.nextMode, fromId, usedIds, visibleEdges]);

  const cueBarPct = nowSong && nowSong.durationSec ? Math.round((1 - session.timeLeft / nowSong.durationSec) * 100) : 0;

  // Spotify-style dual display: once we're within CROSSFADE_LOOKAHEAD_SEC of
  // the committed transition's real cue point, show both songs instead of
  // just Playing.
  const queueHead = session.queue[0];
  const committedEdge = (queueHead && queueHead.mode === 'transition' && queueHead.edgeId)
    ? edges.find(e => e.id === queueHead.edgeId) : null;
  let mixingIntoSong = null, crossfadePct = 0;
  if (nowSong && queueHead && queueHead.mode === 'transition') {
    const triggerAt = committedEdge && committedEdge.outSeconds != null ? committedEdge.outSeconds : nowSong.durationSec;
    if (triggerAt - elapsed <= 8) {
      mixingIntoSong = songs[queueHead.id] || null;
      crossfadePct = clamp(Math.round((1 - Math.max(0, triggerAt - elapsed) / 8) * 100), 0, 100);
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
            onRequestEndSet={requestEndSet} endQueued={queueIds.includes(END)}
            nowPlayingId={session.nowPlayingId} nowElapsedSec={elapsed} nowDurationSec={nowSong ? nowSong.durationSec : 0}
          />
          <QueueBar songs={songs} nowPlayingId={session.nowPlayingId} queue={session.queue} autoHistory={session.autoHistory} onRemoveQueueItem={removeQueueFrom} onRemoveQueueItemOnly={removeQueueOne} />
        </div>

        <SequencePane
          songs={songs} session={session} venueName={venueName}
          hasStarted={hasStarted} nowSong={nowSong} cueBarPct={cueBarPct} hasOutroForPlaying={hasOutroForPlaying}
          mixingIntoSong={mixingIntoSong} crossfadePct={crossfadePct}
          nextRows={nextRows} laterRows={laterRows} setHoveredId={setHoveredId}
          onTogglePlaying={togglePlaying} onResumeSet={resumeSet} onStartSet={startSet} onSetNextMode={setNextMode}
          onCommitRow={commitRow} onSkipNext={skipNow} onRequestEndSet={requestEndSet}
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
