import React, { useEffect, useMemo, useState } from 'react';
import { uid, mockDuration, uploadAudioIfConfigured, uploadCoverIfPossible } from '../core.js';
import { analyzeAudio } from '../audioAnalyze.js';
import { Field, Dropzone, CoverPicker } from './shared.jsx';

export default function UploadSongPage({ onAddSong, onViewSong, existingCount }) {
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

  return (
    <div className="page page-scroll page-narrow">
      <div className="page-title">Upload Song</div>
      <div className="page-sub">Add a new master to the library. A remix is just its own song here — give it its own title/BPM/key and connect it with Add Audio like anything else.</div>

      <div className="form-card">
        <Field label="Cover art (optional)"><CoverPicker url={coverPreviewUrl} onFile={setCoverFile} /></Field>
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Faultline Blue" /></Field>
        <Field label="Artist"><input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="e.g. Nomi Sato" /></Field>
        <div className="form-grid-2">
          <Field label="BPM"><input className="input" value={bpm} onChange={(e) => setBpm(e.target.value)} placeholder="126" inputMode="numeric" /></Field>
          <Field label="Key"><input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="A min" /></Field>
        </div>
        <Field label="Master audio">
          <Dropzone file={file} onFile={setFile} hint="drop lossless master (WAV/AIFF/FLAC preferred; MP3 accepted, flagged)" />
          {analyzing && (
            <div className="hint-text analyzing-hint">
              <span className="spinner" />
              Reading duration…
            </div>
          )}
          {!analyzing && analyzed && (
            <div className="detected-summary">
              Detected {Math.round(analyzed.durationSec)}s — BPM/Key aren't auto-detected, type them in above.
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
