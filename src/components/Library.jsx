import React, { useEffect, useMemo, useRef, useState } from 'react';
import { libraryRows, uploadCoverIfPossible, uploadExtraFileIfPossible, occludedTransitions, fmtBytes, emptySession } from '../core.js';
import { isLocalAudioMarker, resolveAudioUrl } from '../localAudioStore.js';
import { Icon, ICONS, Field, AlbumArt, CoverPicker, SongPicker, useResolvedAudioUrl } from './shared.jsx';

// A `blob:`/`local:`-resolved URL only exists inside THIS browser — a
// single-song export bundle (see exportSong below) needs to actually be
// portable to somebody else's browser, so anything backed by local
// IndexedDB storage gets fetched and re-embedded as a `data:` URI (already
// self-contained, no server involved) rather than left as a URL that
// would silently fail to resolve anywhere else. A real http(s) URL (the
// backend-configured path) is already portable and passes through as-is.
async function portableUrl(url) {
  if (!url || !isLocalAudioMarker(url)) return url || null;
  const resolved = await resolveAudioUrl(url);
  if (!resolved) return null;
  const blob = await fetch(resolved).then(r => r.blob());
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// `audioUrl` may be a `local:` marker (IndexedDB, no backend configured —
// see localAudioStore.js) rather than a real URL, and resolving it is
// async — split into their own components so each row's hook call is
// independent of how many rows there are (a hook can't safely live inside
// a `.map()` callback in the parent's own render body).
function DownloadReferenceLink({ song }) {
  const resolvedUrl = useResolvedAudioUrl(song.audioUrl);
  if (!song.audioUrl) return <span className="hint-text" style={{ alignSelf: 'center' }}>no reference master uploaded</span>;
  if (!resolvedUrl) return <span className="hint-text" style={{ alignSelf: 'center' }}>loading reference…</span>;
  return <a className="btn btn-ghost btn-sm" href={resolvedUrl} download target="_blank" rel="noreferrer">Download reference</a>;
}
function EdgeAudioPreview({ edge }) {
  const resolvedUrl = useResolvedAudioUrl(edge.audioUrl);
  if (!edge.audioUrl) return null;
  return resolvedUrl ? <audio controls src={resolvedUrl} style={{ height: 26 }} /> : null;
}
// A song's own extra files — stems, the original project file, anything
// beyond the master itself a collaborator dropped in to help build a
// better transition (see UploadSong/AddAudio's own upload path, which
// this deliberately mirrors — same local/worker storage, just a plain
// {id, name, size, url} entry instead of a dedicated audioUrl field).
function ExtraFileRow({ file, onRemove }) {
  const resolvedUrl = useResolvedAudioUrl(file.url);
  return (
    <div className="lib-extra-file">
      <span className="lib-extra-file-name">{file.name}</span>
      <span className="lib-extra-file-size mono-num">{fmtBytes(file.size)}</span>
      {resolvedUrl
        ? <a className="btn btn-ghost btn-xs" href={resolvedUrl} download={file.name} target="_blank" rel="noreferrer">Download</a>
        : <span className="hint-text">loading…</span>}
      <button className="btn btn-ghost btn-xs" onClick={onRemove}>Remove</button>
    </div>
  );
}

function LibraryRow({ row, song, edges, songs, open, onToggle, onUpdateSong, onDeleteSong, onDeleteEdge, onDuplicateSong, onRemoveExtraFile, selected, onToggleSelect }) {
  const [editing, setEditing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const extraFileInputRef = useRef(null);
  const [draftTitle, setDraftTitle] = useState(song.title);
  const [draftArtist, setDraftArtist] = useState(song.artist);
  const [draftBpm, setDraftBpm] = useState(String(song.bpm));
  const [draftKey, setDraftKey] = useState(song.key);
  const [draftMashupA, setDraftMashupA] = useState((song.mashupOf && song.mashupOf[0]) || null);
  const [draftMashupB, setDraftMashupB] = useState((song.mashupOf && song.mashupOf[1]) || null);
  // Other songs only — picking itself as one of its own two mashup parts
  // wouldn't mean anything.
  const pickableSongs = useMemo(() => {
    const { [song.id]: _omit, ...rest } = songs;
    return rest;
  }, [songs, song.id]);

  function saveEdits() {
    const bpmNum = Number(draftBpm);
    onUpdateSong(song.id, {
      title: draftTitle.trim() || song.title, artist: draftArtist.trim() || song.artist,
      bpm: Number.isFinite(bpmNum) && bpmNum > 0 ? bpmNum : song.bpm, key: draftKey.trim() || song.key,
      mashupOf: (draftMashupA && draftMashupB) ? [draftMashupA, draftMashupB] : null,
    });
    setEditing(false);
  }
  async function changeCover(file) {
    const coverUrl = await uploadCoverIfPossible(file);
    onUpdateSong(song.id, { coverUrl });
  }
  async function attachFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAttaching(true);
    const uploaded = (await Promise.all(files.map(uploadExtraFileIfPossible))).filter(Boolean);
    setAttaching(false);
    if (uploaded.length === 0) return;
    onUpdateSong(song.id, { extraFiles: [...(song.extraFiles || []), ...uploaded] });
  }
  function removeExtraFile(fileId) {
    onRemoveExtraFile(song.id, fileId);
  }
  // A portable single-song bundle — the same {songs, edges, session,
  // venueName, playlists} shape Settings' own full-library backup uses
  // (filtered to just this song + its own built audio), so Settings'
  // existing Restore already knows how to bring it back in on the
  // receiving end without a second, bundle-specific import path. Any
  // `local:`-marker audio (this browser's own IndexedDB, not a real URL)
  // gets re-embedded as a `data:` URI first — otherwise the marker would
  // silently fail to resolve to anything on someone else's machine.
  async function exportSong() {
    setExporting(true);
    try {
      const ownEdgesNow = edges.filter(e => e.l === song.id || e.r === song.id);
      const exportedSong = {
        ...song,
        audioUrl: await portableUrl(song.audioUrl),
        coverUrl: await portableUrl(song.coverUrl),
        extraFiles: await Promise.all((song.extraFiles || []).map(async (f) => ({ ...f, url: await portableUrl(f.url) }))),
      };
      const exportedEdges = await Promise.all(ownEdgesNow.map(async (e) => ({ ...e, audioUrl: await portableUrl(e.audioUrl) })));
      const data = {
        songs: { [song.id]: exportedSong }, edges: exportedEdges,
        session: emptySession(), venueName: '', playlists: [],
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'eskimo-song-' + song.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }
  function destText(e) {
    if (e.type === 'outro') return 'ends set';
    if (e.type === 'intro') return 'cold-open';
    const other = e.l === song.id ? e.r : e.l;
    return (e.l === song.id ? '→ ' : '← ') + (songs[other] ? songs[other].title : '');
  }
  function labelOf(e) { return e.type === 'outro' ? 'Outro' : e.type === 'intro' ? 'Intro' : 'Transition'; }
  const ownEdges = edges.filter(e => e.l === song.id || e.r === song.id);

  return (
    <div className={'lib-row' + (open ? ' lib-row-open' : '')}>
      <div className="lib-row-head">
        <input className="lib-checkbox" type="checkbox" checked={selected} onClick={(e) => e.stopPropagation()} onChange={onToggleSelect} title="Select for playlist queueing" />
        <span className="lib-chevron" onClick={onToggle}><Icon path={ICONS.chevron} size={13} /></span>
        <AlbumArt className="lib-art" url={song.coverUrl} />
        <div className="lib-title-wrap" onClick={onToggle}>
          <span className="lib-title">{row.title}</span>
          <span className="lib-artist">{row.artist}</span>
          {song.contributedBy && <span className="lib-contributor">added by {song.contributedBy}</span>}
        </div>
        <div className="lib-tags" onClick={onToggle}>
          <span className="tag tag-accent">{row.bpm}</span>
          <span className="tag tag-good">{row.key}</span>
          {row.isDeadEnd && <span className="tag tag-warn">dead end</span>}
          {song.audioUrl && isLocalAudioMarker(song.audioUrl) && (
            <span className="tag" data-tooltip="This reference audio lives in this browser's own storage, not a shared backend — it won't be visible on another device or to a crate collaborator">local only</span>
          )}
        </div>
        <div className="lib-io mono-num" onClick={onToggle}>↓{row.inCount} ↑{row.outCount}</div>
      </div>
      {open && (
        <div className="lib-body">
          <CoverPicker url={song.coverUrl} onFile={changeCover} />
          {!editing ? (
            <div className="drawer-actions-row">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit details</button>
              <DownloadReferenceLink song={song} />
              <button className="btn btn-ghost btn-sm" onClick={() => onDuplicateSong(song.id)} data-tooltip="Seed a new song from this one's BPM/key/cover — for a remix or alternate edit">Duplicate</button>
              <button className="btn btn-ghost btn-sm" onClick={exportSong} disabled={exporting} data-tooltip="Download this song + its built audio as a shareable file — bring it into another library via Settings → Restore">
                {exporting ? (<><span className="spinner" /> Exporting…</>) : 'Export'}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => onDeleteSong(song.id)}>Delete song</button>
            </div>
          ) : (
            <div className="lib-edit-row">
              <Field label="Title"><input className="input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} /></Field>
              <Field label="Artist"><input className="input" value={draftArtist} onChange={(e) => setDraftArtist(e.target.value)} /></Field>
              <Field label="BPM"><input className="input" value={draftBpm} onChange={(e) => setDraftBpm(e.target.value)} /></Field>
              <Field label="Key"><input className="input" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} /></Field>
              <Field label="Mashup of (optional) — part 1">
                <SongPicker songs={pickableSongs} value={draftMashupA} onChange={setDraftMashupA} allowFree freeLabel="Not a mashup" />
              </Field>
              {draftMashupA && (
                <Field label="Mashup of — part 2">
                  <SongPicker songs={pickableSongs} value={draftMashupB} onChange={setDraftMashupB} allowFree freeLabel="Pick the other half" />
                </Field>
              )}
              <button className="btn btn-primary btn-sm" onClick={saveEdits}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          )}
          {!editing && song.mashupOf && songs[song.mashupOf[0]] && songs[song.mashupOf[1]] && (
            <div className="hint-text">Mashup of {songs[song.mashupOf[0]].title} × {songs[song.mashupOf[1]].title}</div>
          )}
          <div>
            <div className="section-label">Built audio</div>
            <div className="lib-pieces">
              {ownEdges.map(e => {
                const clashes = occludedTransitions(edges, e);
                return (
                  <div key={e.id} className="drawer-frag">
                    <div className="drawer-frag-row">
                      <span className="drawer-frag-label">{labelOf(e)}</span>
                      <div className="drawer-frag-actions">
                        <EdgeAudioPreview edge={e} />
                        <button className="btn btn-ghost btn-xs" onClick={() => onDeleteEdge(e.id)}>Remove</button>
                      </div>
                    </div>
                    <div className="drawer-frag-dest">
                      {destText(e)}
                      {e.contributedBy && <span className="lib-contributor lib-contributor-inline"> · built by {e.contributedBy}</span>}
                    </div>
                    {clashes.length > 0 && (
                      <div className="hint-text" style={{ color: 'var(--danger)' }}>
                        takes over before {clashes.length} transition{clashes.length > 1 ? 's' : ''} off this song — clashes if picked: {' '}
                        {clashes.map(c => (songs[e.type === 'outro' ? c.r : c.l] || {}).title || '?').join(', ')}
                      </div>
                    )}
                  </div>
                );
              })}
              {ownEdges.length === 0 && <div className="empty-note-sm">nothing built for this song yet</div>}
            </div>
          </div>
          <div>
            <div className="section-label">
              Extra files
              <button className="btn btn-ghost btn-xs" style={{ marginLeft: 8, textTransform: 'none' }} onClick={() => extraFileInputRef.current && extraFileInputRef.current.click()} disabled={attaching}>
                {attaching ? (<><span className="spinner" /> Uploading…</>) : '+ Add file'}
              </button>
              <input ref={extraFileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { attachFiles(e.target.files); e.target.value = ''; }} />
            </div>
            <div className="lib-pieces">
              {(song.extraFiles || []).map(f => <ExtraFileRow key={f.id} file={f} onRemove={() => removeExtraFile(f.id)} />)}
              {(!song.extraFiles || song.extraFiles.length === 0) && (
                <div className="empty-note-sm">stems, project files (.flp/.als/…), anything else worth sharing for this song</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const SORT_OPTIONS = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'bpm', label: 'BPM' },
  { key: 'key', label: 'Key' },
  { key: 'deadend', label: 'Dead ends first' },
  { key: 'added', label: 'Recently added' },
];

export default function LibraryPage({ songs, edges, goUpload, onUpdateSong, onDeleteSong, onDeleteEdge, onDuplicateSong, onRemoveExtraFile, onQueueSongs, onLoadExample }) {
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]); // ordered — selection order is play order
  const [sortKey, setSortKey] = useState('title');
  // 'added' and 'deadend' read more naturally newest/dead-ends-first by
  // default — flipping the starting direction per key beats making
  // someone click "descending" the instant they pick either of those.
  const [sortDir, setSortDir] = useState('asc');
  const searchRef = useRef(null);

  // Matches the identical-looking search box on the Graph page (PerformPage.jsx)
  // — same "/" focus shortcut, so the two don't quietly diverge in discoverability.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== '/') return;
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
      if (typing) return;
      e.preventDefault();
      searchRef.current && searchRef.current.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const totalSongs = Object.keys(songs).length;
  const rows = useMemo(() => libraryRows(songs, edges, search, sortKey, sortDir), [songs, edges, search, sortKey, sortDir]);

  function changeSortKey(key) {
    setSortKey(key);
    // 'added' sorts by id (ascending = oldest first) — 'desc' shows newest
    // first. 'deadend' sorts on !isDeadEnd (ascending already puts a dead
    // end's `false` before a wired song's `true`), so 'asc' already reads
    // as "dead ends first" with no direction flip needed.
    setSortDir(key === 'added' ? 'desc' : 'asc');
  }

  function toggleSelect(id) {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }
  function queueSelected() {
    onQueueSongs(selectedIds);
    setSelectedIds([]);
  }

  if (totalSongs === 0) {
    return (
      <div className="page page-scroll">
        <div className="page-header"><div className="page-title">Library</div></div>
        <div className="empty-state">
          <div className="empty-state-title">No songs yet</div>
          <div className="empty-state-sub">Upload your first track to start building your library.</div>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={goUpload}>Upload a song</button>
            {onLoadExample && <button className="btn btn-ghost" onClick={onLoadExample}>Load an example graph</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-scroll">
      <div className="page-header">
        <div className="page-title">Library</div>
        <button className="btn btn-primary" onClick={goUpload}>+ New song</button>
      </div>
      <div className="page-sub">Every song in the crate. Click a row for its built transitions and to edit it — check a run of rows, in the order you want them, to queue them all as a playlist.</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <input ref={searchRef} className="input" style={{ maxWidth: 320 }} placeholder="Find a song or artist… (/)" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ maxWidth: 170 }} value={sortKey} onChange={(e) => changeSortKey(e.target.value)} aria-label="Sort library by">
          {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
        <button className="icon-btn" onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))} aria-label={sortDir === 'asc' ? 'Ascending' : 'Descending'} data-tooltip={sortDir === 'asc' ? 'Ascending — click to reverse' : 'Descending — click to reverse'}>
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {selectedIds.length > 0 && (
        <div className="lib-select-bar">
          <span className="lib-select-bar-count">{selectedIds.length} selected, in pick order</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedIds([])}>Clear</button>
            <button className="btn btn-accent btn-sm" onClick={queueSelected}>Queue as playlist</button>
          </div>
        </div>
      )}

      <div>
        {rows.map(r => (
          <LibraryRow key={r.id} row={r} song={songs[r.id]} edges={edges} songs={songs} open={openId === r.id}
            onToggle={() => setOpenId(id => (id === r.id ? null : r.id))}
            selected={selectedIds.includes(r.id)} onToggleSelect={() => toggleSelect(r.id)}
            onUpdateSong={onUpdateSong} onDeleteSong={onDeleteSong} onDeleteEdge={onDeleteEdge}
            onDuplicateSong={onDuplicateSong} onRemoveExtraFile={onRemoveExtraFile} />
        ))}
      </div>
      {rows.length === 0 && <div className="empty-note">no songs match "{search}"</div>}
    </div>
  );
}
