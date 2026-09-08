import React, { useEffect, useRef, useState } from 'react';
import { fmtBytes } from '../core.js';
import { resolveAudioUrl, isLocalAudioMarker } from '../localAudioStore.js';
import { extractDominantColor, derivePalette } from '../dominantColor.js';

// `song.audioUrl`/`edge.audioUrl` may be a `local:` marker (audio stored in
// IndexedDB, no backend configured — see localAudioStore.js) rather than a
// real fetchable URL. Anywhere one of those gets handed straight to an
// `<audio src>` or a download `<a href>` needs to resolve it to a live
// `blob:` URL first — this hook does that once per marker/URL and re-runs
// if it changes (e.g. a song's audio gets replaced).
export function useResolvedAudioUrl(url) {
  // Lazy-init to the real URL immediately when it isn't a marker at all
  // (a cover's data:/https: URL, most of the time) — otherwise every
  // `<AlbumArt>` would flash its empty placeholder for one tick while the
  // always-async effect below resolves a value it already had.
  const [resolved, setResolved] = useState(() => (url && !isLocalAudioMarker(url) ? url : null));
  useEffect(() => {
    let cancelled = false;
    if (!url) { setResolved(null); return undefined; }
    if (!isLocalAudioMarker(url)) { setResolved(url); return undefined; }
    resolveAudioUrl(url).then((real) => { if (!cancelled) setResolved(real); });
    return () => { cancelled = true; };
  }, [url]);
  return resolved;
}

// The color-match feature: a song with cover art gets a playing/next/later
// palette derived from that art instead of the app's fixed accent blue
// (see dominantColor.js) — null (the fixed blue stays in charge, styles.css
// already handles that as the default) until a cover exists and its color
// has actually been decoded.
export function usePalette(coverUrl) {
  const resolvedUrl = useResolvedAudioUrl(coverUrl);
  const [palette, setPalette] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!resolvedUrl) { setPalette(null); return undefined; }
    // extractDominantColor is designed to always resolve, never reject —
    // this catch is just insurance against a future bug there (or in
    // derivePalette) turning into an unhandled rejection instead of
    // quietly falling back to the fixed accent-blue palette like every
    // other real failure path here already does.
    extractDominantColor(resolvedUrl)
      .then((rgb) => { if (!cancelled) setPalette(derivePalette(rgb)); })
      .catch(() => { if (!cancelled) setPalette(null); });
    return () => { cancelled = true; };
  }, [resolvedUrl]);
  return palette;
}

export function Icon({ path, size = 15, strokeWidth = 1.6, filled = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={strokeWidth}>
      {path}
    </svg>
  );
}

export const ICONS = {
  perform: <polygon points="6,4 20,12 6,20" fill="currentColor" />,
  library: <><circle cx="7" cy="7" r="3"></circle><circle cx="17" cy="7" r="3"></circle><circle cx="7" cy="17" r="3"></circle><circle cx="17" cy="17" r="3"></circle></>,
  upload: <><path d="M12 16V4"></path><path d="M6 10l6-6 6 6"></path><path d="M4 20h16"></path></>,
  addAudio: <><path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><line x1="8" y1="12" x2="16" y2="12"></line></>,
  settings: <><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"></path></>,
  close: <><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></>,
  play: <polygon points="6,4 20,12 6,20" fill="currentColor" />,
  pause: <><rect x="5" y="4" width="5" height="16" fill="currentColor"></rect><rect x="14" y="4" width="5" height="16" fill="currentColor"></rect></>,
  chevron: <polyline points="9,6 15,12 9,18"></polyline>,
  chevronLeft: <polyline points="15,6 9,12 15,18"></polyline>,
  swap: <><path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><line x1="8" y1="12" x2="16" y2="12"></line></>,
  target: <><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor"></circle></>,
  grid: <><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect></>,
  hand: <><path d="M8 13V5a1.5 1.5 0 0 1 3 0v6"></path><path d="M11 11V4a1.5 1.5 0 0 1 3 0v7"></path><path d="M14 11V6a1.5 1.5 0 0 1 3 0v8"></path><path d="M8 12l-1.5-1.5a1.5 1.5 0 0 0-2.3 1.9L7 17a6 6 0 0 0 5.5 3.3h1a6 6 0 0 0 6-6v-3"></path></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="20" y1="20" x2="15.5" y2="15.5"></line></>,
  skip: <><polygon points="5,4 15,12 5,20" fill="currentColor"></polygon><rect x="17" y="4" width="2.5" height="16" fill="currentColor"></rect></>,
  skipBack: <><polygon points="19,4 9,12 19,20" fill="currentColor"></polygon><rect x="4.5" y="4" width="2.5" height="16" fill="currentColor"></rect></>,
  stop: <rect x="5" y="5" width="14" height="14" fill="currentColor"></rect>,
  volume: <><polygon points="3,9 8,9 13,4 13,20 8,15 3,15" fill="currentColor"></polygon><path d="M16.5 8.5a5 5 0 0 1 0 7"></path></>,
};

// A real cover thumbnail when a song has one (url), otherwise the same
// decorative diagonal-stripe placeholder as before.
export function AlbumArt({ className, style, url }) {
  const resolved = useResolvedAudioUrl(url);
  if (resolved) return <img className={'art-swatch art-photo ' + (className || '')} style={style} src={resolved} alt="" />;
  return <div className={'art-swatch ' + (className || '')} style={style} />;
}

export function SongPicker({ songs, value, onChange, allowFree, freeLabel, placeholder }) {
  const [editing, setEditing] = useState(!value);
  const [query, setQuery] = useState('');
  const chosen = value ? songs[value] : null;

  if (!editing && chosen) {
    return (
      <div className="picker-chip">
        <AlbumArt className="picker-chip-art" url={chosen.coverUrl} />
        <div className="picker-chip-text">
          <div className="picker-chip-title">{chosen.title}</div>
          <div className="picker-chip-artist">{chosen.artist}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(true); setQuery(''); }}>Change</button>
      </div>
    );
  }
  if (!editing && !chosen) {
    return (
      <div className="picker-chip picker-chip-free">
        <div className="picker-chip-text"><div className="picker-chip-title">{freeLabel}</div></div>
        <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(true); setQuery(''); }}>Change</button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const results = Object.values(songs)
    .filter(s => !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q))
    .slice(0, 8);

  return (
    <div className="picker-open">
      <input className="input" autoFocus placeholder={placeholder || 'Search songs…'} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="picker-results">
        {allowFree && (
          <button className="picker-result picker-result-free" onClick={() => { onChange(null); setEditing(false); }}>{freeLabel}</button>
        )}
        {results.map(s => (
          <button key={s.id} className="picker-result" onClick={() => { onChange(s.id); setEditing(false); }}>
            <span className="picker-result-title">{s.title}</span>
            <span className="picker-result-artist">{s.artist}</span>
          </button>
        ))}
        {results.length === 0 && <div className="picker-result-empty">no matches</div>}
      </div>
    </div>
  );
}

// A click-to-pick cover thumbnail — shows the current art (real photo or
// placeholder swatch via AlbumArt) plus a small "Add/Change cover" label.
// Upload sequencing (local preview vs. the real uploaded/data URL) is the
// caller's job via onFile; this is just the picker chrome.
export function CoverPicker({ url, onFile, size = 48 }) {
  const inputRef = useRef(null);
  return (
    <div className="cover-picker" onClick={() => inputRef.current && inputRef.current.click()}>
      <input
        ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) onFile(f); e.target.value = ''; }}
      />
      <AlbumArt className="cover-picker-art" style={{ width: size, height: size }} url={url} />
      <span className="cover-picker-label">{url ? 'Change cover' : 'Add cover'}</span>
    </div>
  );
}

// A real confirm dialog — centered, backdrop-blocking, deliberately harder
// to trigger by accident than an inline row in a scrolling list. Used for
// anything that should require an actual second step to happen (End Set).
// Escape cancels and the Cancel button gets initial focus (the safer
// default action) — a keyboard user landing here can always back out
// without hunting for a mouse-only close target.
export function Field({ label, children }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

export function Dropzone({ file, onFile, hint }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(fileList) {
    if (fileList && fileList[0]) onFile(fileList[0]);
  }
  return (
    <div
      className={'dropzone' + (dragging ? ' dropzone-active' : '')}
      onClick={() => inputRef.current && inputRef.current.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
    >
      <input ref={inputRef} type="file" style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
      <Icon path={ICONS.upload} size={16} />
      {file ? (
        <div className="dropzone-file">
          <div className="dropzone-file-name">{file.name}</div>
          <div className="dropzone-file-size">{fmtBytes(file.size)}</div>
        </div>
      ) : (
        <div className="dropzone-hint">{hint}</div>
      )}
    </div>
  );
}
