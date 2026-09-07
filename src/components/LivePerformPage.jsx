import React, { useState, useMemo, useCallback } from 'react';
import {
  END, getVisibleEdges, queueTailId, transitionCandidates, cutCandidates, fmtTime, clamp,
} from '../core.js';
import { useTransportControls } from '../playbackControls.js';
import { Icon, ICONS, ConfirmModal, SongPicker, AlbumArt, usePalette } from './shared.jsx';

// A dedicated, non-graph live-performance screen — the node graph is great
// for building the library's structure but a bad fit for "glance at this
// while performing", so this reads left to right instead: what's playing,
// then every way it could end, then every way the next song could start,
// then the next song itself — all flat lists of cards, nothing gated
// behind a mode toggle first. Deliberately its own component rather than a
// second render path grafted onto PerformPage.jsx: it only ever touches
// the manual queue (session.queue) through the same core.js/audioEngine.js
// functions the graph already goes through (wireConnection/performAdvance/
// transitionTriggerElapsed and friends), so the two UIs can never disagree
// about what a hop actually does even though each owns its own glue code.
function ProgressBar({ pct, direction }) {
  return (
    <div className="live-progress-track">
      <div className={'live-progress-fill live-progress-' + direction} style={{ width: clamp(pct, 0, 100) + '%' }} />
    </div>
  );
}

function LiveCard({ title, artist, coverUrl, selected, disabled, onClick, progress, children, style, dark }) {
  return (
    <button
      className={'live-card' + (selected ? ' live-card-selected' : '') + (disabled ? ' live-card-disabled' : '') + (dark ? ' live-card-playing' : '')}
      style={style} onClick={onClick} disabled={disabled}
    >
      <div className="live-card-top">
        {coverUrl !== undefined && <AlbumArt className="live-card-art" url={coverUrl} />}
        <div className="live-card-text">
          <div className="live-card-title">{title}</div>
          {artist && <div className="live-card-artist">{artist}</div>}
          {children}
        </div>
      </div>
      {progress != null && <ProgressBar pct={progress.pct} direction={progress.direction} />}
    </button>
  );
}

export default function LivePerformPage({ songs, edges, session, setSession }) {
  const [pendingEnding, setPendingEnding] = useState('cut'); // 'cut' | 'outro' — applies once a Next-song card is clicked; a Transition card commits fully on its own
  const [pendingStart, setPendingStart] = useState(null); // null (auto: intro if produced) | 'none' | 'intro'
  const [endSetModalOpen, setEndSetModalOpen] = useState(false);
  const [endSetEnding, setEndSetEnding] = useState('cut');
  const [startPickId, setStartPickId] = useState(null);
  const [startPickMode, setStartPickMode] = useState('cut');

  const hasStarted = session.nowPlayingId !== null;
  const visibleEdges = useMemo(() => getVisibleEdges(edges), [edges]);
  const findEdge = useCallback((pred) => visibleEdges.find(pred), [visibleEdges]);
  const { startSet, togglePlaying, skipNow, resumeSet } = useTransportControls({ songs, visibleEdges, setSession });
  const fromId = useMemo(() => (hasStarted ? queueTailId(session.nowPlayingId, session.queue) : null), [hasStarted, session.nowPlayingId, session.queue]);
  const usedIds = useMemo(() => new Set([session.nowPlayingId, ...session.queue.map(q => q.id)]), [session.nowPlayingId, session.queue]);
  const nowSong = hasStarted ? songs[session.nowPlayingId] : null;
  const elapsed = nowSong ? nowSong.durationSec - session.timeLeft : 0;
  const hasOutroForPlaying = !!findEdge(e => e.type === 'outro' && e.l === session.nowPlayingId);
  const palette = usePalette(nowSong ? nowSong.coverUrl : null);

  // Every produced transition off the playing song — each one already
  // names its own destination, so each is a fully self-contained "ending"
  // choice (see transitionCandidates, core.js). Same soonest-first-then-
  // uncommitted sort and cue-passed drop as the graph's own Next list.
  const transitionRows = useMemo(() => {
    if (!hasStarted || !fromId) return [];
    return transitionCandidates(visibleEdges, fromId, usedIds).map(e => {
      const dest = songs[e.r];
      const hasCue = e.outSeconds != null;
      const secondsLeft = hasCue ? Math.max(0, e.outSeconds - elapsed) : session.timeLeft;
      const basisSec = hasCue ? e.outSeconds : (nowSong ? nowSong.durationSec : 210);
      return { edgeId: e.id, destId: e.r, destTitle: dest.title, destArtist: dest.artist, destCoverUrl: dest.coverUrl, hasCue, secondsLeft, basisSec };
    })
      .filter(r => !(r.hasCue && r.secondsLeft <= 0))
      .sort((a, b) => {
        if (a.hasCue && b.hasCue) return a.secondsLeft - b.secondsLeft;
        if (a.hasCue) return -1;
        if (b.hasCue) return 1;
        return 0;
      });
  }, [hasStarted, fromId, visibleEdges, usedIds, songs, elapsed, nowSong, session.timeLeft]);

  // Every other song in the library, for a None/Outro ending — `hasIntro`
  // says whether the "Intro" start option would even apply to it.
  const nextSongCandidates = useMemo(() => {
    if (!hasStarted) return [];
    return cutCandidates(songs, usedIds)
      .map(id => {
        const s = songs[id];
        const introEdge = findEdge(e => e.type === 'intro' && e.r === id);
        return { destId: id, destTitle: s.title, destArtist: s.artist, destCoverUrl: s.coverUrl, hasIntro: !!introEdge };
      })
      .sort((a, b) => a.destTitle.localeCompare(b.destTitle));
  }, [hasStarted, songs, usedIds, findEdge]);

  const visibleNextSongCandidates = useMemo(() => {
    if (pendingStart === 'intro') return nextSongCandidates.filter(c => c.hasIntro);
    return nextSongCandidates;
  }, [nextSongCandidates, pendingStart]);

  // Time left in the playing song itself — the countdown every None/
  // Outro/start-mode card shares, since none of them have their own
  // earlier cue point the way a transition does; they're all live until
  // the song they're attached to actually ends.
  const songCountdownPct = nowSong ? (session.timeLeft / nowSong.durationSec) * 100 : 0;

  function commitTransition(edgeId, destId) {
    setSession(prev => ({ ...prev, queue: [...prev.queue, { id: destId, mode: 'transition', edgeId }] }));
  }
  function commitCutOrOutro(destId) {
    const introEdge = findEdge(e => e.type === 'intro' && e.r === destId);
    const starting = pendingStart === 'none' ? 'cut' : (introEdge ? 'intro' : 'cut');
    setSession(prev => ({ ...prev, queue: [...prev.queue, { id: destId, mode: 'cut', ending: pendingEnding, starting }] }));
    setPendingEnding('cut');
    setPendingStart(null);
  }

  // startSet/togglePlaying/skipNow/resumeSet come from useTransportControls
  // above — the same functions PerformPage.jsx uses, so the graph and this
  // flat live screen can never quietly diverge on what any of them do.
  function pickStart(songId, starting) {
    startSet(songId, starting);
    setStartPickId(null);
  }
  function requestEndSet() {
    setEndSetEnding(hasOutroForPlaying ? 'outro' : 'cut');
    setEndSetModalOpen(true);
  }
  function confirmEndSet() {
    // Same fix as the graph's own End Set: the outro's own edgeId lets
    // transitionTriggerElapsed (core.js) hand off at its real cue point
    // instead of waiting out the full song duration.
    const outroEdgeId = endSetEnding === 'outro' ? ((findEdge(e => e.type === 'outro' && e.l === session.nowPlayingId) || {}).id || null) : null;
    setSession(prev => ({ ...prev, queue: [...prev.queue, { id: END, ending: endSetEnding, edgeId: outroEdgeId }] }));
    setEndSetModalOpen(false);
  }

  return (
    <div className="live-page">
      {!hasStarted ? (
        <div className="live-start-card">
          <div className="section-label">Start the set</div>
          <SongPicker songs={songs} value={startPickId} onChange={setStartPickId} placeholder="Search songs…" />
          {startPickId && (
            <>
              <div className="seq-row-toggles segmented" style={{ marginTop: 9 }}>
                <button className={'seq-toggle' + (startPickMode === 'cut' ? ' active' : '')} onClick={() => setStartPickMode('cut')}>Cut</button>
                <button className={'seq-toggle' + (startPickMode === 'intro' ? ' active' : '')} onClick={() => setStartPickMode('intro')}>Intro</button>
              </div>
              <button className="btn btn-primary" style={{ width: '100%', marginTop: 9 }} onClick={() => pickStart(startPickId, startPickMode)}>Start playing</button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="live-columns" key={session.nowPlayingId}>
            <div className="live-column">
              <div className="live-column-title">Playing</div>
              <LiveCard
                title={nowSong.title} artist={nowSong.artist} coverUrl={nowSong.coverUrl}
                progress={{ pct: (elapsed / nowSong.durationSec) * 100, direction: 'elapsed' }}
                style={palette ? { background: palette.playing, borderColor: palette.playing } : undefined}
                dark
              >
                <div className="live-card-time mono-num">{fmtTime(elapsed)} / {fmtTime(nowSong.durationSec)}</div>
              </LiveCard>
            </div>

            <div className="live-column">
              <div className="live-column-title">How it ends</div>
              <div className="live-card-list">
                <LiveCard
                  title="None" selected={pendingEnding === 'cut'}
                  progress={{ pct: songCountdownPct, direction: 'countdown' }}
                  onClick={() => setPendingEnding('cut')}
                />
                {hasOutroForPlaying && (
                  <LiveCard
                    title="Outro" selected={pendingEnding === 'outro'}
                    progress={{ pct: songCountdownPct, direction: 'countdown' }}
                    onClick={() => setPendingEnding('outro')}
                  />
                )}
                {transitionRows.map(r => (
                  <LiveCard
                    key={r.edgeId} title={'Transition → ' + r.destTitle} coverUrl={r.destCoverUrl}
                    progress={{ pct: (r.secondsLeft / r.basisSec) * 100, direction: 'countdown' }}
                    onClick={() => commitTransition(r.edgeId, r.destId)}
                  />
                ))}
                {transitionRows.length === 0 && !hasOutroForPlaying && (
                  <div className="live-empty">only None built for this song</div>
                )}
              </div>
            </div>

            <div className="live-column">
              <div className="live-column-title">Next song starts via</div>
              <div className="live-card-list">
                <LiveCard title="None" selected={pendingStart === null || pendingStart === 'none'} onClick={() => setPendingStart('none')} progress={{ pct: songCountdownPct, direction: 'countdown' }} />
                <LiveCard title="Intro" selected={pendingStart === 'intro'} onClick={() => setPendingStart('intro')} progress={{ pct: songCountdownPct, direction: 'countdown' }} />
              </div>
              <div className="live-column-hint">applies to the song you pick next</div>
            </div>

            <div className="live-column">
              <div className="live-column-title">Next song</div>
              <div className="live-card-list">
                {visibleNextSongCandidates.map(c => (
                  <LiveCard
                    key={c.destId} title={c.destTitle} artist={c.destArtist} coverUrl={c.destCoverUrl}
                    progress={{ pct: songCountdownPct, direction: 'countdown' }}
                    onClick={() => commitCutOrOutro(c.destId)}
                  />
                ))}
                {visibleNextSongCandidates.length === 0 && <div className="live-empty">nothing else to pick</div>}
              </div>
            </div>
          </div>

          <div className="live-controls">
            <button className="toolbar-btn" onClick={togglePlaying}>
              <Icon path={session.isPlaying ? ICONS.pause : ICONS.play} filled={!session.isPlaying} size={13} /> {session.isPlaying ? 'Pause' : 'Play'}
            </button>
            <button className="toolbar-btn" onClick={skipNow}>
              <Icon path={ICONS.skip} filled size={13} /> Skip
            </button>
            <button className="toolbar-end-set-btn" onClick={requestEndSet} data-tooltip="Play this out, then stop">
              <Icon path={ICONS.stop} filled size={12} /> End set
            </button>
            <button className="toolbar-stop-set-btn" onClick={resumeSet} data-tooltip="Stop right now">
              <Icon path={ICONS.stop} filled size={12} /> Stop set
            </button>
          </div>
        </>
      )}

      {session.setEnded && (
        <div className="success-note">
          <span>Set ended{nowSong ? ` — ${nowSong.title} had nowhere built to go next` : ''}.</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-primary btn-sm" onClick={() => startSet(session.nowPlayingId, session.startMethod || 'cut')}>Play again</button>
            <button className="btn btn-ghost btn-sm" onClick={resumeSet}>Pick another</button>
          </div>
        </div>
      )}

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
