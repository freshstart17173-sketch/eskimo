import React, { useEffect, useMemo, useState } from 'react';
import { uid, mockDuration, uploadAudioIfConfigured, uploadCoverIfPossible } from '../core.js';
import { analyzeAudio } from '../audioAnalyze.js';
import { Field, Dropzone, CoverPicker } from './shared.jsx';

// A plausible title guess from a bare filename — strips the extension and
// turns the underscores/dashes a lot of exported filenames use in place
// of spaces back into actual spaces. Only used for the batch-drop path
// below; the single-file form always lets the DJ type a real title
// directly, so this never overrides anything they've actually entered.
function titleFromFilename(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;
}

// Same-title-and-artist match against the existing library — a soft
// warning, never a block: a DJ might genuinely want two same-named
// entries (a radio edit vs. an extended mix, say), so this only flags
// the possibility rather than refusing the upload.
function findDuplicate(songs, title, artist) {
  const t = title.trim().toLowerCase(), a = (artist.trim() || 'unknown').toLowerCase();
  if (!t) return null;
  return Object.values(songs).find(s => s.title.toLowerCase() === t && s.artist.toLowerCase() === a) || null;
}

export default function UploadSongPage({ onAddSong, onViewSong, existingCount, songs }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [bpm, setBpm] = useState('');
  const [key, setKey] = useState('');
  const [file, setFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzed, setAnalyzed] = useState(null);
  const coverPreviewUrl = useMemo(() => (coverFile ? URL.createObjectURL(coverFile) : null), [coverFile]);

  // Detected but editable — same contract as Add Audio's detection flow:
  // fill BPM/Key only while the DJ hasn't already typed something in.
  useEffect(() => {
    if (!file) { setAnalyzed(null); return; }
    let cancelled = false;
    setAnalyzing(true);
    analyzeAudio(file).then((result) => {
      if (cancelled) return;
      setAnalyzed(result);
      setBpm((prev) => (prev.trim() || result.bpm == null ? prev : String(Math.round(result.bpm))));
      setKey((prev) => (prev.trim() || !result.key ? prev : result.key));
    }).catch((e) => {
      console.warn('Eskimo Studio: could not analyze dropped audio', e);
      if (!cancelled) setAnalyzed(null);
    }).finally(() => { if (!cancelled) setAnalyzing(false); });
    return () => { cancelled = true; };
  }, [file]);

  const duplicate = useMemo(() => findDuplicate(songs, title, artist), [songs, title, artist]);

  async function save() {
    if (!title.trim()) { setError('Give the song a title.'); return; }
    const bpmNum = Number(bpm);
    if (bpm.trim() && (!Number.isFinite(bpmNum) || bpmNum <= 0)) { setError('BPM should be a positive number.'); return; }
    setError('');
    setUploading(true);
    const audio = await uploadAudioIfConfigured(file);
    const coverUrl = coverFile ? await uploadCoverIfPossible(coverFile) : null;
    setUploading(false);
    const id = uid('s');
    const song = {
      id, title: title.trim(), artist: artist.trim() || 'Unknown',
      x: 60 + (existingCount * 47) % 1180, y: 60 + (existingCount * 83) % 700,
      bpm: bpmNum || 120, key: key.trim() || '—',
      durationSec: (analyzed && analyzed.durationSec) || mockDuration(title + artist), audioUrl: audio.audioUrl || null, coverUrl,
    };
    onAddSong(song);
    setSaved({ id, title: song.title });
    setTitle(''); setArtist(''); setBpm(''); setKey(''); setFile(null); setCoverFile(null); setAnalyzed(null);
  }

  // ---------------------------------------------------------------------
  // Batch mode — dropping more than one file at once. Each file becomes
  // its own song with a filename-guessed title (no cover, BPM/key filled
  // in only when detection was confident) — the DJ fixes up any of that
  // afterward in Library, same as retitling a mis-guessed single upload
  // would work today. Sequential, not parallel: decoding several
  // multi-minute masters at once for BPM/key analysis is real CPU work,
  // and a plain top-to-bottom progress list is easier to follow than N
  // spinners racing each other.
  // ---------------------------------------------------------------------
  const [batch, setBatch] = useState(null); // [{ file, status, title, dup }] | null
  const [batchRunning, setBatchRunning] = useState(false);

  async function startBatch(files) {
    const items = files.map((f) => ({
      file: f, status: 'pending', title: titleFromFilename(f.name),
      dup: null, bpm: null, key: null,
    }));
    setBatch(items);
    setBatchRunning(true);
    // Local running count so a duplicate check against songs ALREADY
    // added earlier in this same batch works without waiting on React
    // state (which wouldn't have committed yet mid-loop).
    let currentSongs = { ...songs };
    for (let i = 0; i < items.length; i++) {
      setBatch((prev) => prev.map((it, j) => (j === i ? { ...it, status: 'analyzing' } : it)));
      let analyzedItem = null;
      try { analyzedItem = await analyzeAudio(items[i].file); } catch (e) { /* fall back to placeholder duration below */ }
      setBatch((prev) => prev.map((it, j) => (j === i ? { ...it, status: 'uploading' } : it)));
      const audio = await uploadAudioIfConfigured(items[i].file).catch(() => ({ audioUrl: null }));
      const dup = findDuplicate(currentSongs, items[i].title, 'Unknown');
      const id = uid('s');
      const song = {
        id, title: items[i].title, artist: 'Unknown',
        x: 60 + ((existingCount + i) * 47) % 1180, y: 60 + ((existingCount + i) * 83) % 700,
        bpm: (analyzedItem && analyzedItem.bpm != null) ? Math.round(analyzedItem.bpm) : 120,
        key: (analyzedItem && analyzedItem.key) || '—',
        durationSec: (analyzedItem && analyzedItem.durationSec) || mockDuration(items[i].title),
        audioUrl: audio.audioUrl || null, coverUrl: null,
      };
      currentSongs = { ...currentSongs, [id]: song };
      onAddSong(song);
      setBatch((prev) => prev.map((it, j) => (j === i ? { ...it, status: 'done', dup, bpm: song.bpm, key: song.key } : it)));
    }
    setBatchRunning(false);
  }

  if (batch) {
    const doneCount = batch.filter(it => it.status === 'done').length;
    return (
      <div className="page page-scroll page-narrow">
        <div className="page-title">Upload Song</div>
        <div className="page-sub">Adding {batch.length} songs — {doneCount} of {batch.length} done{batchRunning ? '…' : '.'}</div>
        <div className="form-card">
          <div className="lib-pieces">
            {batch.map((it, i) => (
              <div key={i} className="drawer-frag">
                <div className="drawer-frag-row">
                  <span className="drawer-frag-label">{it.title}</span>
                  <span className="hint-text">
                    {it.status === 'pending' && 'waiting…'}
                    {it.status === 'analyzing' && (<><span className="spinner" /> analyzing…</>)}
                    {it.status === 'uploading' && (<><span className="spinner" /> uploading…</>)}
                    {it.status === 'done' && (it.bpm ? `${it.bpm} BPM, ${it.key}` : 'added')}
                  </span>
                </div>
                {it.dup && <div className="hint-text" style={{ color: 'var(--danger)' }}>same title already in the library — rename one of them in Library if this wasn't intentional</div>}
              </div>
            ))}
          </div>
          {!batchRunning && (
            <div className="drawer-actions-row" style={{ marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={onViewSong}>View in Library</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setBatch(null)}>Add more</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page page-scroll page-narrow">
      <div className="page-title">Upload Song</div>
      <div className="page-sub">Add a new master to the library. A remix is just its own song here — give it its own title/BPM/key and connect it with Add Audio like anything else. Drop more than one file at once to add them all quickly (title guessed from the filename, edit details in Library after).</div>

      <div className="form-card">
        <Field label="Cover art (optional)"><CoverPicker url={coverPreviewUrl} onFile={setCoverFile} /></Field>
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Faultline Blue" />
        </Field>
        {duplicate && (
          <div className="hint-text" style={{ color: 'var(--danger)', marginTop: -8, marginBottom: 8 }}>
            "{duplicate.title}" by {duplicate.artist} is already in the library — this'll add a second, separate entry, not replace it.
          </div>
        )}
        <Field label="Artist"><input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="e.g. Nomi Sato" /></Field>
        <div className="form-grid-2">
          <Field label="BPM"><input className="input" value={bpm} onChange={(e) => setBpm(e.target.value)} placeholder="126" inputMode="numeric" /></Field>
          <Field label="Key"><input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="A min" /></Field>
        </div>
        <Field label="Master audio">
          <Dropzone
            file={file} onFile={setFile} multiple
            onFiles={(files) => { if (files.length > 1) startBatch(files); else setFile(files[0]); }}
            hint="drop lossless master(s) (WAV/AIFF/FLAC preferred; MP3 accepted, flagged) — drop several at once to batch-add them"
          />
          {analyzing && (
            <div className="hint-text analyzing-hint">
              <span className="spinner" />
              Reading duration…
            </div>
          )}
          {!analyzing && analyzed && (
            <div className="detected-summary">
              Detected {Math.round(analyzed.durationSec)}s
              {analyzed.bpm != null || analyzed.key ? ' — ' : ''}
              {analyzed.bpm != null && analyzed.key ? `${Math.round(analyzed.bpm)} BPM, ${analyzed.key} detected — still editable above.`
                : analyzed.bpm != null ? `${Math.round(analyzed.bpm)} BPM detected — still editable above. Key wasn't confident enough to guess; type it in if you know it.`
                : analyzed.key ? `${analyzed.key} detected — still editable above. BPM wasn't confident enough to guess; type it in if you know it.`
                : ' — BPM/Key weren’t confident enough to guess (a quiet, sparse, or heavily processed track can do this); type them in above.'}
            </div>
          )}
        </Field>
        {error && <div className="error-note">{error}</div>}
        <button className="btn btn-primary btn-self-start" onClick={save} disabled={uploading}>
          {uploading ? (<><span className="spinner" /> Uploading…</>) : 'Add to library'}
        </button>
        {saved && (
          <div className="success-note">
            <span>Added "{saved.title}" to the library.</span>
            <button className="btn btn-primary btn-sm" onClick={() => onViewSong(saved.id)}>View in Library</button>
          </div>
        )}
      </div>
    </div>
  );
}
