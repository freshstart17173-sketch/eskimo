import React, { useMemo, useState } from 'react';
import { uid, fmtTime, pseudoCuePoints, pickDetectedSongs, uploadAudioIfConfigured } from '../core.js';
import { detectMatch } from '../audioDetect.js';
import { Field, Dropzone, SongPicker } from './shared.jsx';

export default function AddAudioPage({ songs, onAddEdge, onViewSong, goUpload, onLoadExample }) {
  const [file, setFile] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } | null
  const [detected, setDetected] = useState(false);
  const [usedRealDetection, setUsedRealDetection] = useState(false);
  const [realCue, setRealCue] = useState(null); // { outSeconds, inSeconds } | null
  const [leftId, setLeftId] = useState(null);
  const [rightId, setRightId] = useState(null);
  const [fragLabel, setFragLabel] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const [uploading, setUploading] = useState(false);

  const songIds = Object.keys(songs);
  const referenceableSongs = Object.values(songs).filter(s => s.audioUrl);
  // a local, playable URL for the dropped file — this is what lets you
  // actually listen before it's added, instead of trusting the match blind
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  function reset() {
    setFile(null); setAnalyzing(false); setDetected(false); setProgress(null);
    setLeftId(null); setRightId(null); setFragLabel(''); setError(''); setRealCue(null);
  }

  async function handleFile(f) {
    setFile(f); setAnalyzing(true); setDetected(false); setSaved(null); setProgress(null);
    try {
      if (referenceableSongs.length > 0) {
        // Real detection: cross-correlate this file's head/tail against every
        // song that has a real reference track (see src/audioDetect.js).
        const { leftId: l, rightId: r, leftOutSeconds, rightInSeconds } = await detectMatch(f, referenceableSongs, (done, total) => setProgress({ done, total }));
        setLeftId(l); setRightId(r);
        setRealCue((l || r) ? { outSeconds: leftOutSeconds, inSeconds: rightInSeconds } : null);
        setUsedRealDetection(true);
      } else {
        // No reference audio anywhere yet — nothing to correlate against, so
        // fall back to the deterministic placeholder matcher.
        const seed = f.name + '|' + f.size;
        const [a, b] = pickDetectedSongs(songIds, seed, 2);
        setLeftId(a || null); setRightId(b || null);
        setRealCue(null);
        setUsedRealDetection(false);
      }
    } catch (e) {
      console.warn('Eskimo Studio: audio detection failed, falling back to placeholder matching', e);
      const seed = f.name + '|' + f.size;
      const [a, b] = pickDetectedSongs(songIds, seed, 2);
      setLeftId(a || null); setRightId(b || null);
      setRealCue(null);
      setUsedRealDetection(false);
    }
    setAnalyzing(false); setDetected(true);
  }

  const leftSong = leftId ? songs[leftId] : null;
  const rightSong = rightId ? songs[rightId] : null;
  const derivedType = leftId && rightId ? 'transition' : rightId ? 'intro' : leftId ? 'outro' : null;
  const pseudoCue = detected ? pseudoCuePoints(leftId, rightId) : null;
  const cue = detected
    ? {
        outSeconds: (realCue && realCue.outSeconds != null) ? realCue.outSeconds : pseudoCue.outSeconds,
        inSeconds: (realCue && realCue.inSeconds != null) ? realCue.inSeconds : pseudoCue.inSeconds,
      }
    : null;

  // There's no separate "unverified" state to fix later — you listen to it
  // right here before it ever becomes part of the graph, so anything saved
  // is verified by definition (see core.js's edge.verified: always true).
  async function saveEdge() {
    if (!derivedType) { setError('This needs at least one song — pick a left and/or right side.'); return; }
    setUploading(true);
    const audio = await uploadAudioIfConfigured(file);
    setUploading(false);
    const edge = {
      id: uid('e'), type: derivedType,
      l: leftId || undefined, r: rightId || undefined,
      verified: true, label: fragLabel.trim() || undefined, audioUrl: audio.audioUrl || null,
      outSeconds: cue ? cue.outSeconds : undefined, inSeconds: cue ? cue.inSeconds : undefined,
    };
    onAddEdge(edge);
    setSaved({ label: derivedType, songId: rightId || leftId });
    reset();
  }

  const typeLabel = derivedType ? ({ transition: 'Transition', intro: 'Intro', outro: 'Outro' })[derivedType] : '—';

  if (songIds.length === 0) {
    return (
      <div className="page page-scroll page-narrow-wide">
        <div className="page-title">Add Audio</div>
        <div className="empty-state">
          <div className="empty-state-title">Add a song first</div>
          <div className="empty-state-sub">You'll need at least one song in the library before there's anything to connect.</div>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={goUpload}>Upload a song</button>
            <button className="btn btn-ghost" onClick={onLoadExample}>Load an example graph</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-scroll page-narrow-wide">
      <div className="page-title">Add Audio</div>
      <div className="page-sub">Drop a produced transition, intro, or outro, listen to make sure it's right, then save — there's no separate verify step after the fact. A remix is a new song (Upload Song), not audio to attach here.</div>
      {referenceableSongs.length === 0 && (
        <div className="hint-text" style={{ marginBottom: 12 }}>
          No songs have a reference master uploaded yet, so detection below is placeholder matching, not real analysis —
          upload masters on Upload Song to turn on real detection.
        </div>
      )}

      <div className="form-card">
        <Field label="Produced audio">
          <Dropzone file={file} onFile={handleFile} hint="drop the finished transition, intro, or outro render" />
        </Field>
        {previewUrl && (
          <Field label="Listen before you save it">
            <div className="audio-preview"><audio controls src={previewUrl} /></div>
          </Field>
        )}

        {analyzing && (
          <div className="hint-text analyzing-hint">
            <span className="spinner" />
            {progress
              ? `Checking reference track ${progress.done} of ${progress.total}…`
              : (referenceableSongs.length > 0 ? 'Analyzing audio against your reference tracks…' : 'Analyzing audio…')}
          </div>
        )}

        {detected && (
          <>
            <div className="detected-label">Detected{usedRealDetection ? '' : ' (placeholder match)'}</div>
            <div className="pair-grid">
              <div>
                <div className="field-label">Left side (what it plays out of)</div>
                <SongPicker songs={songs} value={leftId} onChange={setLeftId} allowFree freeLabel="Free — starts the set" />
              </div>
              <div>
                <div className="field-label">Right side (what it plays into)</div>
                <SongPicker songs={songs} value={rightId} onChange={setRightId} allowFree freeLabel="Free — ends the set" />
              </div>
            </div>

            <div className="detected-summary">
              <span className="tag tag-neutral">Type: {typeLabel}</span>
              {leftSong && rightSong && (
                <>
                  <span className="tag tag-accent">{leftSong.bpm} → {rightSong.bpm} BPM</span>
                  <span className="tag tag-good">{leftSong.key} → {rightSong.key}</span>
                </>
              )}
            </div>

            {cue && (
              <div className="cue-grid">
                {leftSong && (
                  <div>
                    <div className="field-label">{leftSong.title} — detected out point</div>
                    <div className="waveform-bar">
                      <div className="waveform-marker" style={{ left: '71%' }} />
                      <div className="waveform-marker-label" style={{ left: '71%' }}>OUT <span className="mono-num">{fmtTime(cue.outSeconds)}</span></div>
                    </div>
                  </div>
                )}
                {rightSong && (
                  <div>
                    <div className="field-label">{rightSong.title} — detected in point</div>
                    <div className="waveform-bar">
                      <div className="waveform-marker" style={{ left: '12%' }} />
                      <div className="waveform-marker-label" style={{ left: '12%' }}>IN <span className="mono-num">{fmtTime(cue.inSeconds)}</span></div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <Field label="Note (optional)">
              <input className="input" value={fragLabel} onChange={(e) => setFragLabel(e.target.value)} placeholder="e.g. Tempo drop into verse" />
            </Field>
          </>
        )}

        {error && <div className="error-note">{error}</div>}
        {detected && (
          <button className="btn btn-primary btn-self-start" onClick={saveEdge} disabled={uploading}>
            {uploading ? (<><span className="spinner" /> Uploading…</>) : 'Sounds right — save ' + typeLabel}
          </button>
        )}

        {saved && (
          <div className="success-note">
            <span>Saved to the graph.</span>
            {saved.songId && <button className="btn btn-primary btn-sm" onClick={() => onViewSong(saved.songId)}>View in Library</button>}
          </div>
        )}
      </div>
    </div>
  );
}
