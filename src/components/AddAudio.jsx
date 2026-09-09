import React, { useEffect, useMemo, useState } from 'react';
import { uid, fmtTime, uploadAudioIfConfigured, occludedTransitions } from '../core.js';
import { detectSpliceForKnownSongs } from '../audioDetect.js';
import { Field, Dropzone, SongPicker } from './shared.jsx';
import TransitionPreviewPlayer from './TransitionPreviewPlayer.jsx';

// Auto-detecting WHICH song(s) out of the whole library a dropped file
// connects turned out to be the wrong job for a correlation algorithm to
// guess at — direct instruction: the DJ picks the type and the song(s) by
// hand, up front; what's still worth automating is the actual splice
// TIMECODE against whichever song(s) they picked (see audioDetect.js's
// detectSpliceForKnownSongs).
export default function AddAudioPage({ songs, edges, onAddEdge, onViewSong, goUpload, onLoadExample }) {
  const [type, setType] = useState(null); // 'transition' | 'intro' | 'outro' | null
  const [leftId, setLeftId] = useState(null);
  const [rightId, setRightId] = useState(null);
  const [file, setFile] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progressSide, setProgressSide] = useState(null); // 'left' | 'right' | null
  const [detectedCue, setDetectedCue] = useState(null); // detectSpliceForKnownSongs() result, {} on failure, or null before it's run
  const [fragLabel, setFragLabel] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const [uploading, setUploading] = useState(false);

  const songIds = Object.keys(songs);
  // a local, playable URL for the dropped file — used only for the plain
  // <audio> fallback when neither side has a reference master to build the
  // real waveform preview against
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  function reset() {
    setType(null); setLeftId(null); setRightId(null); setFile(null);
    setAnalyzing(false); setProgressSide(null); setDetectedCue(null);
    setFragLabel(''); setError('');
  }

  const leftSong = leftId ? songs[leftId] : null;
  const rightSong = rightId ? songs[rightId] : null;
  const sameSongBothSides = type === 'transition' && !!leftId && !!rightId && leftId === rightId;
  const songsReady = !sameSongBothSides && (
    type === 'transition' ? !!(leftId && rightId)
    : type === 'outro' ? !!leftId
    : type === 'intro' ? !!rightId
    : false
  );
  const typeLabel = type ? ({ transition: 'Transition', intro: 'Intro', outro: 'Outro' })[type] : '—';
  const missingReference = songsReady && (
    (leftSong && !leftSong.audioUrl) || (rightSong && !rightSong.audioUrl)
  );

  // Runs the real detection the moment both "what is this" (type + song(s))
  // and "here's the file" are known, in whichever order the DJ happens to
  // supply them. Discards a stale result (the cleanup flag) if any of these
  // change again before the scan finishes, rather than clobbering a newer
  // selection's state — same generation-guard pattern TransitionPreviewPlayer
  // itself already uses for its own decode effect.
  useEffect(() => {
    if (!file || !songsReady) { setDetectedCue(null); return undefined; }
    let cancelled = false;
    setAnalyzing(true); setProgressSide(null); setDetectedCue(null); setError('');
    detectSpliceForKnownSongs(file, { leftSong, rightSong }, (side) => { if (!cancelled) setProgressSide(side); })
      .then((res) => { if (!cancelled) setDetectedCue(res); })
      .catch((e) => {
        console.warn('Eskimo Studio: splice detection failed', e);
        if (!cancelled) {
          setDetectedCue({});
          setError('Could not analyze this file against the reference master — you can still save it, it\'ll just play start to end with no detected splice point.');
        }
      })
      .finally(() => { if (!cancelled) setAnalyzing(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, songsReady, leftId, rightId, type]);

  const cue = detectedCue ? { outSeconds: detectedCue.leftOutSeconds, inSeconds: detectedCue.rightInSeconds } : null;
  // A long outro/intro variant (see occludedTransitions, core.js) can start
  // diverging from the plain master well before its own cue point — surface
  // any already-built transition that would clash with this one before it's
  // saved, since nothing later filters it (only one ending is ever active
  // per song at a time).
  const conflicts = (cue && (type === 'outro' || type === 'intro') && (cue.outSeconds != null || cue.inSeconds != null))
    ? occludedTransitions(edges, { type, l: leftId, r: rightId, outSeconds: cue.outSeconds, inSeconds: cue.inSeconds })
    : [];

  // There's no separate "unverified" state to fix later — you listen to it
  // right here before it ever becomes part of the graph, so anything saved
  // is verified by definition (see core.js's edge.verified: always true).
  async function saveEdge() {
    if (!type) { setError('Pick what kind of audio this is first.'); return; }
    if (sameSongBothSides) { setError('Left and right are the same song — a transition can\'t lead a song into itself. Pick a different song on one side.'); return; }
    if (!songsReady) { setError('Pick the song' + (type === 'transition' ? 's' : '') + ' this connects first.'); return; }
    if (!file) { setError('Drop the produced audio file.'); return; }
    setUploading(true);
    const audio = await uploadAudioIfConfigured(file);
    setUploading(false);
    const edge = {
      id: uid('e'), type,
      l: leftId || undefined, r: rightId || undefined,
      verified: true, label: fragLabel.trim() || undefined, audioUrl: audio.audioUrl || null,
      outSeconds: detectedCue && detectedCue.leftOutSeconds != null ? detectedCue.leftOutSeconds : undefined,
      inSeconds: detectedCue && detectedCue.rightInSeconds != null ? detectedCue.rightInSeconds : undefined,
      // Where inside the CLIP's OWN audio (not the surrounding songs') its
      // real content starts/ends — an outro clip commonly still carries the
      // original song's tail before its own new material, and an intro clip
      // commonly still carries a lead-in into the destination's own opening
      // after its own new material ends. Stored whenever the corresponding
      // song side was actually matched (detectSpliceForKnownSongs only ever
      // computes leftClipStartSec when a leftSong existed, rightClipEndSec
      // when a rightSong existed) — not gated to Outro/Intro by type, since
      // a Transition has both sides and this same metadata is exactly what
      // lets Library's own "listen to the built audio" preview trim a
      // saved Transition down to its real content too, not just Outro/
      // Intro. The live engine only ever reads clipStartSec off an outro
      // edge and clipEndSec off an intro edge (audioEngine.js) — a
      // Transition splices at outSeconds/inSeconds on the real decks
      // instead — so storing both here on a Transition is inert for real
      // playback, just useful metadata for the preview. undefined falls
      // back to playing the clip from/to its own natural start/end, same
      // as when there's no detected cue at all.
      clipStartSec: detectedCue && detectedCue.leftClipStartSec != null ? detectedCue.leftClipStartSec : undefined,
      clipEndSec: detectedCue && detectedCue.rightClipEndSec != null ? detectedCue.rightClipEndSec : undefined,
    };
    onAddEdge(edge);
    setSaved({ label: type, songId: rightId || leftId });
    reset();
  }

  if (songIds.length === 0) {
    return (
      <div className="page page-scroll page-narrow-wide">
        <div className="page-title">Add Audio</div>
        <div className="empty-state">
          <div className="empty-state-title">Add a song first</div>
          <div className="empty-state-sub">You'll need at least one song in the library before there's anything to connect.</div>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={goUpload}>Upload a song</button>
            {onLoadExample && <button className="btn btn-ghost" onClick={onLoadExample}>Load an example graph</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-scroll page-narrow-wide">
      <div className="page-title">Add Audio</div>
      <div className="page-sub">Tell us what this is and which song(s) it connects, then drop the produced file — listen to make sure it's right, then save. There's no separate verify step after the fact. A remix is a new song (Upload Song), not audio to attach here.</div>

      <div className="form-card">
        <Field label="What kind of audio is this?">
          <div className="seq-row-toggles segmented">
            <button type="button" className={'seq-toggle' + (type === 'transition' ? ' active' : '')} aria-pressed={type === 'transition'} onClick={() => setType('transition')}>Transition</button>
            <button type="button" className={'seq-toggle' + (type === 'intro' ? ' active' : '')} aria-pressed={type === 'intro'} onClick={() => setType('intro')}>Intro</button>
            <button type="button" className={'seq-toggle' + (type === 'outro' ? ' active' : '')} aria-pressed={type === 'outro'} onClick={() => setType('outro')}>Outro</button>
          </div>
        </Field>

        {type && (
          <div className="pair-grid">
            {(type === 'transition' || type === 'outro') && (
              <div>
                <div className="field-label">{type === 'outro' ? 'Which song does it play out of?' : 'Left side (what it plays out of)'}</div>
                <SongPicker songs={songs} value={leftId} onChange={setLeftId} placeholder="Search songs…" />
              </div>
            )}
            {(type === 'transition' || type === 'intro') && (
              <div>
                <div className="field-label">{type === 'intro' ? 'Which song does it play into?' : 'Right side (what it plays into)'}</div>
                <SongPicker songs={songs} value={rightId} onChange={setRightId} placeholder="Search songs…" />
              </div>
            )}
          </div>
        )}

        {sameSongBothSides && (
          <div className="error-note">
            Left and right are both {leftSong.title} — a transition can't lead a song into itself. Pick a different song on one side.
          </div>
        )}

        {missingReference && (
          <div className="hint-text" style={{ marginBottom: 12 }}>
            {[leftSong && !leftSong.audioUrl ? leftSong.title : null, rightSong && !rightSong.audioUrl ? rightSong.title : null].filter(Boolean).join(' and ')}
            {' '}{(leftSong && !leftSong.audioUrl) && (rightSong && !rightSong.audioUrl) ? 'have' : 'has'} no reference master uploaded — upload one on Upload Song to
            enable detection. You can still save without a detected splice point (the clip plays start to end).
          </div>
        )}

        {songsReady && (
          <Field label="Produced audio">
            <Dropzone file={file} onFile={setFile} hint="drop the finished transition, intro, or outro render" />
          </Field>
        )}

        {file && songsReady && (
          <Field label="Listen before you save it">
            {(leftSong && leftSong.audioUrl) || (rightSong && rightSong.audioUrl) ? (
              <TransitionPreviewPlayer
                file={file} leftSong={leftSong} rightSong={rightSong}
                outSeconds={cue ? cue.outSeconds : null} inSeconds={cue ? cue.inSeconds : null}
                clipStartSec={detectedCue ? detectedCue.leftClipStartSec : null}
                clipEndSec={detectedCue ? detectedCue.rightClipEndSec : null}
              />
            ) : (
              <div className="audio-preview"><audio controls src={previewUrl} /></div>
            )}
          </Field>
        )}

        {analyzing && (
          <div className="hint-text analyzing-hint">
            <span className="spinner" />
            {progressSide ? `Analyzing against ${(progressSide === 'left' ? leftSong : rightSong).title}…` : 'Analyzing…'}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="error-note">
            This {type} takes over at {fmtTime(type === 'outro' ? cue.outSeconds : cue.inSeconds)} —
            {' '}{conflicts.length} existing transition{conflicts.length > 1 ? 's' : ''} off this song cue{' '}
            {type === 'outro' ? 'later' : 'earlier'} than that and would clash if this one plays: {' '}
            {conflicts.map(e => (songs[type === 'outro' ? e.r : e.l] || {}).title || '?').join(', ')}
          </div>
        )}

        {songsReady && (
          <Field label="Note (optional)">
            <input className="input" value={fragLabel} onChange={(e) => setFragLabel(e.target.value)} placeholder="e.g. Tempo drop into verse" />
          </Field>
        )}

        {error && <div className="error-note">{error}</div>}
        {songsReady && file && (
          <button className="btn btn-primary btn-self-start" onClick={saveEdge} disabled={uploading || analyzing}>
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
