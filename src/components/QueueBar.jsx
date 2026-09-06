import React, { useEffect, useRef } from 'react';
import { END } from '../core.js';
import { AlbumArt } from './shared.jsx';

// The live, scrollable record of a set: what already played (autoplay's
// past picks), what's playing now, and what's committed to play next.
// Auto-scrolls to keep "now" in view as autoplay advances — this is the
// natural home for an autoplay/infinite-playlist run, since it's the one
// place the whole sequence is visible at a glance instead of one hop at a
// time.
export default function QueueBar({ songs, nowPlayingId, queue, autoHistory, onRemoveQueueItem }) {
  const nowRef = useRef(null);

  useEffect(() => {
    if (nowRef.current) nowRef.current.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [nowPlayingId]);

  const isEmpty = !nowPlayingId && queue.length === 0 && autoHistory.length === 0;

  return (
    <div className="queue-bar">
      <div className="queue-bar-label">Queue</div>
      <div className="queue-bar-scroll">
        {isEmpty && <div className="queue-bar-empty">start the set, or turn on autoplay, to see the run here</div>}

        {autoHistory.map((h, i) => {
          const s = songs[h.id];
          if (!s) return null;
          return (
            <React.Fragment key={'h' + i}>
              <div className="queue-chip queue-chip-autoplay">
                <AlbumArt className="queue-chip-art" url={s.coverUrl} />
                {s.title}
              </div>
              <span className="queue-arrow">→</span>
            </React.Fragment>
          );
        })}

        {nowPlayingId && songs[nowPlayingId] && (
          <div className="queue-chip queue-chip-playing" ref={nowRef}>
            <AlbumArt className="queue-chip-art" url={songs[nowPlayingId].coverUrl} />
            {songs[nowPlayingId].title}
          </div>
        )}

        {queue.map((q, i) => (
          <React.Fragment key={q.id + i}>
            <span className="queue-arrow">→</span>
            <div className="queue-chip">
              {q.id !== END && <AlbumArt className="queue-chip-art" url={songs[q.id] && songs[q.id].coverUrl} />}
              {q.id === END ? 'End Set' : (songs[q.id] ? songs[q.id].title : '(deleted)')}
              <button className="queue-chip-remove" onClick={() => onRemoveQueueItem(i)}>✕</button>
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
