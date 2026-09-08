import React, { useMemo, useState } from 'react';
import { libraryRows, uploadCoverIfPossible, occludedTransitions } from '../core.js';
import { Icon, ICONS, Field, AlbumArt, CoverPicker, SongPicker, useResolvedAudioUrl } from './shared.jsx';

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

function LibraryRow({ row, song, edges, songs, open, onToggle, onUpdateSong, onDeleteSong, onDeleteEdge, selected, onToggleSelect }) {
  const [editing, setEditing] = useState(false);
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
        </div>
        <div className="lib-tags" onClick={onToggle}>
          <span className="tag tag-accent">{row.bpm}</span>
          <span className="tag tag-good">{row.key}</span>
          {row.isDeadEnd && <span className="tag tag-warn">dead end</span>}
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
                    <div className="drawer-frag-dest">{destText(e)}</div>
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
        </div>
      )}
    </div>
  );
}

export default function LibraryPage({ songs, edges, goUpload, onUpdateSong, onDeleteSong, onDeleteEdge, onQueueSongs, onLoadExample }) {
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]); // ordered — selection order is play order

  const totalSongs = Object.keys(songs).length;
  const rows = useMemo(() => libraryRows(songs, edges, search, 'title', 'asc'), [songs, edges, search]);

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
      <input className="input" style={{ maxWidth: 320, marginBottom: 16 }} placeholder="Find a song or artist…" value={search} onChange={(e) => setSearch(e.target.value)} />

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
            onUpdateSong={onUpdateSong} onDeleteSong={onDeleteSong} onDeleteEdge={onDeleteEdge} />
        ))}
      </div>
      {rows.length === 0 && <div className="empty-note">no songs match "{search}"</div>}
    </div>
  );
}
