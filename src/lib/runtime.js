import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { open as tauriOpen, save as tauriSave } from '@tauri-apps/plugin-dialog';

const STORAGE_KEY = 'terminox_servers';
const FOLDER_STORAGE_KEY = 'terminox_folders';

export const FOLDER_COLLAPSE_STORAGE_KEY = 'terminox_folder_collapse';
export const UNGROUPED_COLLAPSE_ID = '__ungrouped__';
export const SESSION_FOLDER_ID = '__sessions__';
export const SESSION_FOLDER_NAME = 'Sessions';
export const SESSION_SHORTCUT_STORAGE_KEY = 'terminox_session_shortcuts';
export const SESSION_SHORTCUT_LIMIT = 300;
export const RECENT_SESSION_STORAGE_KEY = 'terminox_recent_local_sessions';
export const RECENT_SESSION_LIMIT = 20;

export const isTauri = Boolean(window.__TAURI_INTERNALS__);

const getServers = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
};

const setServers = (servers) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
};

const getFolders = () => {
  try {
    return JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY)) || [];
  } catch {
    return [];
  }
};

const setFolders = (folders) => {
  localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders));
};

const browserInvoke = async (cmd, args) => {
  if (cmd === 'get_servers') return getServers();
  if (cmd === 'get_folders') return getFolders();
  if (cmd === 'save_server') {
    const srv = args.server;
    const list = getServers();
    const idx = list.findIndex((server) => server.id === srv.id);
    if (idx >= 0) list[idx] = srv;
    else list.push(srv);
    setServers(list);
    return;
  }
  if (cmd === 'save_folder') {
    const folder = args.folder;
    const list = getFolders();
    const idx = list.findIndex((item) => item.id === folder.id);
    if (idx >= 0) list[idx] = folder;
    else list.push(folder);
    setFolders(list);
    return;
  }
  if (cmd === 'delete_server') {
    setServers(getServers().filter((server) => server.id !== args.serverId));
    return;
  }
  if (cmd === 'delete_folder') {
    const folderId = String(args.folderId || '');
    setFolders(getFolders().filter((folder) => folder.id !== folderId));
    const servers = getServers().map((server) =>
      server.folder_id === folderId ? { ...server, folder_id: null } : server
    );
    setServers(servers);
    return;
  }
  if (cmd === 'reorder_servers') {
    const ids = Array.isArray(args?.serverIds) ? args.serverIds.map((id) => String(id)) : [];
    if (!ids.length) return;
    const list = getServers();
    const byId = new Map(list.map((server) => [String(server.id), server]));
    const reordered = [];
    ids.forEach((id) => {
      if (byId.has(id)) {
        reordered.push(byId.get(id));
        byId.delete(id);
      }
    });
    byId.forEach((server) => reordered.push(server));
    setServers(reordered);
    return;
  }
  if (cmd === 'lookup_ip_location') throw new Error('Location lookup requires the desktop app');
  if (cmd === 'geocode_location') throw new Error('Text location lookup requires the desktop app');
  if (cmd === 'get_host_device_info') {
    return {
      hostname: 'Browser Preview',
      os_name: navigator.platform || 'Unknown',
      os_version: 'n/a',
      arch: 'n/a',
      cpu_cores: navigator.hardwareConcurrency || 0,
      total_memory_mb: 0,
      terminal_workspace: '.',
    };
  }
  if (cmd === 'start_local_terminal') throw new Error('Local terminal requires the desktop app');
  if (cmd.startsWith('local_shell_')) throw new Error('Local terminal requires the desktop app');
  if (cmd.startsWith('sftp_')) throw new Error('SFTP requires the desktop app');
  if (cmd === 'check_server_status') {
    return { status: 'unknown', latency_ms: null, reason: 'Browser preview mode', ip: null };
  }
  if (cmd === 'ssh_probe_metrics') throw new Error('Metrics refresh requires the desktop app');
  if (cmd === 'ssh_clear_known_host') return 0;
  if (cmd === 'ssh_connect') throw new Error('SSH requires the desktop app');
  if (cmd.startsWith('telnet_')) throw new Error('Telnet requires the desktop app');
  if (cmd === 'open_devtools') {
    console.log('[TermiNox] Browser preview mode — DevTools are already open in your browser console');
    return;
  }
  if (cmd === 'open_external_url') {
    const url = String(args?.url || '').trim();
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
};

export const invoke = isTauri ? tauriInvoke : browserInvoke;
export const listen = isTauri ? tauriListen : async () => () => {};
export const open = isTauri ? tauriOpen : async () => null;
export const saveDialog = isTauri ? tauriSave : async () => null;

if (!isTauri) {
  console.warn('[TermiNox] Browser preview mode — SSH disabled, using localStorage');
}
