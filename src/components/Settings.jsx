import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isSyncConfigured, isUploadConfigured, getProfileName, setProfileName } from '../core.js';
import { estimateSeamlessLength } from '../graphEstimate.js';
import { useTheme } from '../theme.js';
import { engine, AudioEngine } from '../audioEngine.js';
import { Field } from './shared.jsx';

const SHORTCUTS = [
  { keys: '/', where: 'Graph, Library', does: 'Focus the search box' },
  { keys: 'Space', where: 'Graph', does: 'Play / pause' },
  { keys: '← →', where: 'Graph search', does: 'Step through search matches' },
  { keys: 'Enter', where: 'Graph search', does: 'Jump to the focused match' },
  { keys: 'Esc', where: 'Anywhere', does: 'Close the open menu, popover, or search' },
];

// Feature-detected (see AudioEngine.outputDeviceSupported) — not every
// browser supports routing playback to a specific device yet.
function OutputDevicePicker() {
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState(engine.getOutputDeviceId());
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices.enumerateDevices()
      .then((all) => { if (!cancelled) setDevices(all.filter(d => d.kind === 'audiooutput')); })
      .catch(() => { if (!cancelled) setError('Could not list audio output devices.'); });
    return () => { cancelled = true; };
  }, []);

  async function change(deviceId) {
    setSelected(deviceId);
    try { await engine.setOutputDevice(deviceId); } catch (e) { setError('Could not switch to that device — it may need a page reload, or isn\'t available right now.'); }
  }

  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-title">Playback device</div>
        <div className="settings-row-sub">
          Route the set's audio to a specific output — a USB mixer interface, not just whatever the OS default is.
          {devices.length > 0 && devices.every(d => !d.label) && ' Device names are hidden until this page has some kind of microphone permission granted (a browser privacy rule, not an Eskimo Studio choice) — the list still works by position.'}
        </div>
      </div>
      <select className="input" style={{ maxWidth: 240 }} value={selected} onChange={(e) => change(e.target.value)}>
        <option value="">System default</option>
        {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Output ${i + 1}`}</option>)}
      </select>
      {error && <div className="error-note">{error}</div>}
    </div>
  );
}

export default function SettingsPage({
  venueName, setVenueName, songs, edges, session, playlists, onClearAll, onRestore, onSetAutoplay, onSetTransitionOnly,
  crateId, isCrateSyncConfigured, onStartSharedCrate, creatingCrate,
}) {
  const estimate = useMemo(() => estimateSeamlessLength(songs, edges), [songs, edges]);
  const { theme, setTheme } = useTheme();
  const [profileName, setProfileNameState] = useState(() => getProfileName() || '');
  function saveProfileName(name) {
    setProfileNameState(name);
    setProfileName(name);
  }
  const [confirmingReset, setConfirmingReset] = useState(false);
  const fileInputRef = useRef(null);
  const [importError, setImportError] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const crateShareUrl = crateId ? window.location.origin + window.location.pathname + '?crate=' + crateId : '';
  function copyCrateLink() {
    navigator.clipboard.writeText(crateShareUrl).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }
  function leaveCrate() {
    window.location.href = window.location.pathname;
  }

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
      <div className="settings-card" style={{ marginBottom: 20 }}>
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

      <div className="section-label" style={{ marginTop: 20 }}>Profile</div>
      <div className="settings-card" style={{ marginBottom: 20 }}>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div className="settings-row-title">Your name</div>
            <div className="settings-row-sub">Credits whatever you add to a shared crate — a song or a built transition shows this name to your collaborators. Not shown anywhere in a solo library.</div>
            <input className="input" style={{ marginTop: 8, maxWidth: 280 }} value={profileName} onChange={(e) => saveProfileName(e.target.value)} placeholder="e.g. Nomi" />
          </div>
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 20 }}>Shared crate</div>
      <div className="settings-card" style={{ marginBottom: 20 }}>
        {crateId ? (
          <>
            <div className="settings-row">
              <div>
                <div className="settings-row-title">You're in a shared crate</div>
                <div className="settings-row-sub">Songs and audio pieces here are live-shared with anyone who has this link — your set wiring and playback stay private to this browser.</div>
              </div>
              <span className="tag tag-good">LIVE</span>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-title">Share link</div>
                <div className="settings-row-sub" style={{ wordBreak: 'break-all' }}>{crateShareUrl}</div>
              </div>
              <button className="btn btn-ghost" onClick={copyCrateLink}>{linkCopied ? 'Copied!' : 'Copy link'}</button>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-title">Leave this crate</div>
                <div className="settings-row-sub">Goes back to your own personal library — nothing shared here is deleted.</div>
              </div>
              <button className="btn btn-ghost" onClick={leaveCrate}>Leave…</button>
            </div>
          </>
        ) : (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Start a shared crate</div>
              <div className="settings-row-sub">
                {isCrateSyncConfigured
                  ? 'Turns your current library into a live-shared one and gives you a link — send it to producer friends and they can open the real editor and add songs/audio straight into the same pool.'
                  : 'Not set up yet — Supabase isn’t configured (see TODO.md).'}
              </div>
            </div>
            <button className="btn btn-primary" onClick={onStartSharedCrate} disabled={!isCrateSyncConfigured || creatingCrate}>
              {creatingCrate ? (<><span className="spinner" /> Creating…</>) : 'Start sharing'}
            </button>
          </div>
        )}
      </div>

      <div className="form-card">
        <Field label="Venue / session name">
          <input className="input" value={venueName} onChange={(e) => setVenueName(e.target.value)} placeholder="e.g. Friday Warehouse" />
        </Field>
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Appearance</div>
      <div className="settings-card">
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
        {AudioEngine.outputDeviceSupported() && <OutputDevicePicker />}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Keyboard shortcuts</div>
      <div className="settings-card">
        {SHORTCUTS.map((s) => (
          <div className="settings-row" key={s.keys}>
            <div>
              <div className="settings-row-title">{s.does}</div>
              <div className="settings-row-sub">{s.where}</div>
            </div>
            <span className="tag mono-num">{s.keys}</span>
          </div>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Backup</div>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Download a backup</div>
            <div className="settings-row-sub">Saves your whole library and set state to a JSON file.</div>
          </div>
          <button className="btn btn-ghost" onClick={downloadBackup}>Download</button>
        </div>
        {crateId ? (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Restore from a backup</div>
              <div className="settings-row-sub">Not available inside a shared crate — restoring would replace the whole shared pool for everyone. Leave the crate first if you need to restore your own library.</div>
            </div>
          </div>
        ) : (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Restore from a backup</div>
              <div className="settings-row-sub">Replaces everything currently in the browser.</div>
            </div>
            <button className="btn btn-ghost" onClick={() => fileInputRef.current && fileInputRef.current.click()}>Restore…</button>
            <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => handleImportFile(e.target.files)} />
          </div>
        )}
        {importError && <div className="error-note">{importError}</div>}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Autoplay</div>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Autoplay</div>
            <div className="settings-row-sub">picks randomly when nothing's queued</div>
          </div>
          <button className={'switch' + (session.autoplay ? ' on' : '')} onClick={() => onSetAutoplay(!session.autoplay)} />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-title">Transition-only</div>
            <div className="settings-row-sub">a dead end stops the set instead of cutting</div>
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
      <div className="settings-card">
        {crateId ? (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Clear all data</div>
              <div className="settings-row-sub">Not available inside a shared crate — this would wipe the shared pool for everyone, not just your own browser. Use "Leave this crate" above instead.</div>
            </div>
          </div>
        ) : (
          <div className="settings-row">
            <div>
              <div className="settings-row-title">Clear all data</div>
              <div className="settings-row-sub">
                Wipes every song, transition, and set state saved in this browser. This does not undo — download a backup first if you're not sure.
                {(isSyncConfigured || isUploadConfigured) && ' Cloud sync/audio uploads are configured, so this also clears the copy other devices or browsers pull from — not just this one.'}
              </div>
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
        )}
      </div>
    </div>
  );
}
