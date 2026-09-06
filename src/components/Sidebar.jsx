import React from 'react';
import { Icon, ICONS } from './shared.jsx';

export default function Sidebar({ tab, setTab, songCount, edgeCount, venueName }) {
  const items = [
    { id: 'live', label: 'Live', icon: ICONS.play },
    { id: 'perform', label: 'Graph', icon: ICONS.perform, disabled: true },
    { id: 'library', label: 'Library', icon: ICONS.library },
    { id: 'upload', label: 'Upload Song', icon: ICONS.upload },
    { id: 'addAudio', label: 'Add Audio', icon: ICONS.addAudio },
    { id: 'settings', label: 'Settings', icon: ICONS.settings },
  ];
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-word">eskimo</div>
        <div className="sidebar-brand-sub">STUDIO</div>
      </div>
      {items.map(it => (
        <button
          key={it.id}
          className={'nav-btn' + (tab === it.id ? ' active' : '') + (it.disabled ? ' nav-btn-disabled' : '')}
          onClick={() => { if (!it.disabled) setTab(it.id); }}
          disabled={it.disabled}
          data-tooltip={it.disabled ? 'Node graph — temporarily disabled, see Live' : undefined}
        >
          <Icon path={it.icon} size={15} />
          {it.label}
        </button>
      ))}
      <div className="sidebar-footer">
        {venueName || 'Untitled session'}<br />{songCount} songs · {edgeCount} audio pieces
      </div>
    </div>
  );
}
