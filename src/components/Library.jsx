import React, { useMemo, useState } from 'react';
import { libraryRows } from '../core.js';
import { Icon, ICONS, Field, AlbumArt } from './shared.jsx';

function LibraryRow({ row, song, edges, songs, open, onToggle, onUpdateSong, onDeleteSong, onDeleteEdge, selected, onToggleSelect }) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(song.title);
  const [draftArtist, setDraftArtist] = useState(song.artist);
  const [draftBpm, setDraftBpm] = useState(String(song.bpm));
  const [draftKey, setDraftKey] = useState(song.key);
  const [confirmingDeleteSong, setConfirmingDeleteSong] = useState(false);
  const [confirmingDeleteEdgeId, setConfirmingDeleteEdgeId] = useState(null);

  function saveEdits() {
    const bpmNum = Number(draftBpm);
    onUpdateSong(song.id, {
      title: draftTitle.trim() || song.title, artist: draftArtist.trim() || song.artist,
      bpm: Number.isFinite(bpmNum) && bpmNum > 0 ? bpmNum : song.bpm, key: draftKey.trim() || song.key,
    });
    setEditing(false);
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
        <AlbumArt className="lib-art" />
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
          {!editing ? (
            <div className="drawer-actions-row">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit details</button>
              {song.audioUrl ? (
                <a className="btn btn-ghost btn-sm" href={song.audioUrl} download target="_blank" rel="noreferrer">Download reference</a>
              ) : (
                <span className="hint-text" style={{ alignSelf: 'center' }}>no reference master uploaded</span>
              )}
              {!confirmingDeleteSong ? (
                <button className="btn btn-danger btn-sm" onClick={() => setConfirmingDeleteSong(true)}>Delete song</button>
              ) : (
                <>
                  <span className="hint-text" style={{ alignSelf: 'center' }}>removes every transition/intro/outro touching it</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingDeleteSong(false)}>Cancel</button>
                  <button className="btn btn-danger btn-sm" onClick={() => onDeleteSong(song.id)}>Confirm delete</button>
                </>
              )}
            </div>
          ) : (
            <div className="lib-edit-row">
              <Field label="Title"><input className="input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} /></Field>
              <Field label="Artist"><input className="input" value={draftArtist} onChange={(e) => setDraftArtist(e.target.value)} /></Field>
              <Field label="BPM"><input className="input" value={draftBpm} onChange={(e) => setDraftBpm(e.target.value)} /></Field>
              <Field label="Key"><input className="input" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} /></Field>
              <button className="btn btn-primary btn-sm" onClick={saveEdits}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          )}
          <div>
            <div className="section-label">Built audio</div>
            <div className="lib-pieces">
              {ownEdges.map(e => (
                <div key={e.id} className="drawer-frag">
                  <div className="drawer-frag-row">
                    <span className="drawer-frag-label">{labelOf(e)}</span>
                    <div className="drawer-frag-actions">
                      {e.audioUrl && <audio controls src={e.audioUrl} style={{ height: 26 }} />}
                      {confirmingDeleteEdgeId !== e.id ? (
                        <button className="btn btn-ghost btn-xs" onClick={() => setConfirmingDeleteEdgeId(e.id)}>Remove</button>
                      ) : (
                        <>
                          <button className="btn btn-ghost btn-xs" onClick={() => setConfirmingDeleteEdgeId(null)}>Cancel</button>
                          <button className="btn btn-danger btn-xs" onClick={() => { onDeleteEdge(e.id); setConfirmingDeleteEdgeId(null); }}>Confirm</button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="drawer-frag-dest">{destText(e)}</div>
                </div>
              ))}
              {ownEdges.length === 0 && <div className="empty-note-sm">nothing built for this song yet</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LibraryPage({ songs, edges, goUpload, onUpdateSong, onDeleteSong, onDeleteEdge, onQueueSongs }) {
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
          <button className="btn btn-primary" onClick={goUpload}>Upload a song</button>
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
