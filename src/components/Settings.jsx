import React, { useMemo, useRef, useState } from 'react';
import { isSyncConfigured, isUploadConfigured } from '../core.js';
import { estimateSeamlessLength } from '../graphEstimate.js';
import { useTheme } from '../theme.js';
import { Field } from './shared.jsx';

export default function SettingsPage({ venueName, setVenueName, songs, edges, session, playlists, onClearAll, onRestore, onSetAutoplay, onSetTransitionOnly }) {
  const estimate = useMemo(() => estimateSeamlessLength(songs, edges), [songs, edges]);
  const { theme, setTheme } = useTheme();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const fileInputRef = useRef(null);
  const [importError, setImportError] = useState('');

  function downloadBackup() {
    const data = { songs, edges, session, venueName, playlists };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'eskimo-studio-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportFile(fileList) {
    const f = fileList && fileList[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.songs || !data.edges || !data.session) throw new Error('missing fields');
        onRestore(data);
        setImportError('');
      } catch (e) {
        setImportError('That file doesn’t look like an Eskimo Studio backup.');
      }
    };
    reader.readAsText(f);
  }

  return (
    <div className="page page-scroll page-narrow">
      <div className="page-title">Settings</div>
      <div className="page-sub">Data always lives in this browser first. See TODO.md to turn on cloud sync + audio storage.</div>

      <div className="section-label">Cloud sync</div>
      <div className="form-card" style={{ marginBottom: 20 }}>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Supabase sync</div>
            <div className="settings-row-sub">{isSyncConfigured ? 'Configured — this browser syncs in the background once anonymous sign-ins are enabled (see TODO.md).' : 'Not set up yet — add your project keys in src/config.js.'}</div>
          </div>
          <span className={'tag ' + (isSyncConfigured ? 'tag-good' : 'tag-warn')}>{isSyncConfigured ? 'ON' : 'OFF'}</span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Audio uploads</div>
            <div className="settings-row-sub">{isUploadConfigured ? 'Configured — dropped files upload to your R2 bucket.' : 'Not set up yet — deploy worker/upload-worker.js and add its URL.'}</div>
          </div>
          <span className={'tag ' + (isUploadConfigured ? 'tag-good' : 'tag-warn')}>{isUploadConfigured ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      <div className="form-card">
        <Field label="Venue / session name">
          <input className="input" value={venueName} onChange={(e) => setVenueName(e.target.value)} placeholder="e.g. Friday Warehouse" />
        </Field>
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Appearance</div>
      <div className="form-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Theme</div>
            <div className="settings-row-sub">A device preference, not part of your library — it isn't saved in a backup file.</div>
          </div>
          <div className="segmented">
            <button className={'seq-toggle' + (theme === 'light' ? ' active' : '')} onClick={() => setTheme('light')}>Light</button>
            <button className={'seq-toggle' + (theme === 'system' ? ' active' : '')} onClick={() => setTheme('system')}>System</button>
            <button className={'seq-toggle' + (theme === 'dark' ? ' active' : '')} onClick={() => setTheme('dark')}>Dark</button>
          </div>
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Backup</div>
      <div className="form-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Download a backup</div>
            <div className="settings-row-sub">Saves your whole library and set state to a JSON file.</div>
          </div>
          <button className="btn btn-ghost" onClick={downloadBackup}>Download</button>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Restore from a backup</div>
            <div className="settings-row-sub">Replaces everything currently in the browser.</div>
          </div>
          <button className="btn btn-ghost" onClick={() => fileInputRef.current && fileInputRef.current.click()}>Restore…</button>
          <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => handleImportFile(e.target.files)} />
        </div>
        {importError && <div className="error-note">{importError}</div>}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Autoplay</div>
      <div className="autoplay-card">
        <div className="autoplay-row">
          <div>
            <div className="autoplay-row-title">Autoplay</div>
            <div className="autoplay-row-sub">picks randomly when nothing's queued</div>
          </div>
          <button className={'switch' + (session.autoplay ? ' on' : '')} onClick={() => onSetAutoplay(!session.autoplay)} />
        </div>
        <div className="autoplay-row">
          <div>
            <div className="autoplay-row-title">Transition-only</div>
            <div className="autoplay-row-sub">a dead end stops the set instead of cutting</div>
          </div>
          <button className={'switch' + (session.transitionOnly ? ' on' : '')} onClick={() => onSetTransitionOnly(!session.transitionOnly)} />
        </div>
        {estimate.totalSongs > 0 && (
          <div className="estimate-note">
            {estimate.hasLoop
              ? <>This graph has a closed loop — transition-only autoplay can run <b>forever</b> once it's in one. Up to <span className="mono-num">{estimate.upperBound}</span> of {estimate.totalSongs} songs reachable before it must repeat.</>
              : <>No closed loop yet, so transition-only autoplay will eventually dead-end. Up to <span className="mono-num">{estimate.upperBound}</span> of {estimate.totalSongs} songs reachable in one run.</>}
          </div>
        )}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Reset</div>
      <div className="form-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Clear all data</div>
            <div className="settings-row-sub">Wipes every song, transition, and set state saved in this browser. This does not undo — download a backup first if you're not sure.</div>
          </div>
          {!confirmingReset ? (
            <button className="btn btn-danger" onClick={() => setConfirmingReset(true)}>Clear…</button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingReset(false)}>Cancel</button>
              <button className="btn btn-danger btn-sm" onClick={onClearAll}>Confirm — clear everything</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
