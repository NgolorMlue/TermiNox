/* ══════════════════════════════════════════════════════════
   TermiNox — Real SSH Terminal App
   Tauri 2 + russh + xterm.js
══════════════════════════════════════════════════════════ */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import RFB from './assets/novnc/rfb.js';
import {
  FOLDER_COLLAPSE_STORAGE_KEY,
  RECENT_SESSION_LIMIT,
  RECENT_SESSION_STORAGE_KEY,
  SESSION_FOLDER_ID,
  SESSION_FOLDER_NAME,
  SESSION_SHORTCUT_LIMIT,
  SESSION_SHORTCUT_STORAGE_KEY,
  UNGROUPED_COLLAPSE_ID,
  invoke,
  isTauri,
  listen,
  open,
  saveDialog,
} from './lib/runtime.js';
import {
  SERVER_ICON_OPTIONS_HTML,
  folderIconSvg,
  isSessionFolderId,
  normalizeConnectionProtocol,
  normalizeFolderName,
  normalizeServerIcon,
  serverIconLabel,
  serverIconSvg,
  serverProtocol,
  withSystemFolders,
} from './lib/server-model.js';
import { askInputModal } from './lib/input-modal.js';
import { showAlert, showConfirm, showDangerConfirm, showInput, showError } from './lib/modal-system.js';
import { showToastWarning } from './lib/toast-system.js';
import {
  getServerMapCoords,
  hasValidMapCoords,
  latencyColor,
  normalizeCoordinate,
  safeMapFlyTo,
  sDot,
} from './lib/map-helpers.js';
import {
  addSessionShortcut as addSessionShortcutEntry,
  findLocalTabIdByHistoryId as findLocalTabIdByHistoryIdInTabs,
  findSshTabIdByHistoryId as findSshTabIdByHistoryIdInTabs,
  loadRecentSessions as loadRecentSessionsFromStorage,
  loadSessionShortcuts as loadSessionShortcutsFromStorage,
  normalizeRecentSessionEntry as normalizeRecentSessionEntryFromStorage,
  normalizeSessionShortcutEntry,
  normalizeSessionShortcutType,
  recentSessionMeta,
  removeMostRecentSession as removeMostRecentSessionEntry,
  removeSessionShortcut as removeSessionShortcutEntry,
  renderRecentSessionHistory as renderRecentSessionHistoryView,
  saveRecentSessions as saveRecentSessionsToStorage,
  saveSessionShortcuts as saveSessionShortcutsToStorage,
  sessionShortcutDisplayName,
  sessionShortcutMeta,
  syncRecentSessionViewport as syncRecentSessionViewportView,
  trackRecentSession as trackRecentSessionEntry,
} from './lib/session-history.js';
import { createLayoutController } from './lib/layout-controller.js';
import {
  buildAttentionIssues,
  buildServiceBrowserUrl,
  clamp,
  escapeHtml,
  formatUpdatedAgo,
  inferBrowserScheme,
  normalizeUrlHost,
  renderMetricsServiceRows,
  renderSensitiveValue as renderSensitiveValueHelper,
  seedFromServer,
  seededInt,
  seededSeries,
  seriesAvg,
  shortErrorText,
  sparklineSvg,
} from './lib/metrics-helpers.js';

/* ══════════════════════════════════════════════════════════
   SERVER STATE  (loaded from Rust backend)
══════════════════════════════════════════════════════════ */
let SRV = [];   // populated on startup from config
let FOLDERS = [];
let selId = null;
let mainDashboardActive = false;
let hostDeviceInfo = null;
const LIVE_METRICS = new Map();
const SERVER_INTEL = new Map();
const SERVER_INTEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
let metricsSensitiveMasked = true;
let metricsLiveEnabled = true;
let statusRefreshInFlight = false;
const STATUS_REFRESH_INTERVAL_MS = 15000;
const METRICS_LIVE_REFRESH_INTERVAL_MS = 4000;
const TERMINAL_INPUT_FLUSH_MS = 2;
const TERMINAL_OUTPUT_FLUSH_MS = 4;
const WSL_FALLBACK_DELAY_MS = 60000;
const WSL_MISSING_PROMPT_MARKER = 'the windows subsystem for linux is not installed';
let recentLocalSessions = [];
let SESSION_SHORTCUTS = [];
let sidebarSuppressClickUntilMs = 0;
let sidebarPointerDragState = null;
let collapsedFolderIds = loadCollapsedFolders();
let layoutController = null;
const SESSION_SHORTCUT_FOLDER_DEFS = Object.freeze([
  { id: 'session-folder-local_shell', type: 'local_shell', name: 'Local Shell' },
  { id: 'session-folder-wsl_shell', type: 'wsl_shell', name: 'WSL' },
  { id: 'session-folder-vnc', type: 'vnc', name: 'VNC' },
  { id: 'session-folder-rdp', type: 'rdp', name: 'RDP' },
  { id: 'session-folder-mosh', type: 'mosh', name: 'MOSH' },
  { id: 'session-folder-rsh', type: 'rsh', name: 'RSH' },
  { id: 'session-folder-ftp', type: 'ftp', name: 'FTP' },
  { id: 'session-folder-serial', type: 'serial', name: 'Serial' },
]);
const SESSION_SHORTCUT_FOLDER_ID_SET = new Set(SESSION_SHORTCUT_FOLDER_DEFS.map((folder) => folder.id));

function defaultSessionShortcutFolderId(type) {
  const normalizedType = normalizeSessionShortcutType(type);
  const match = SESSION_SHORTCUT_FOLDER_DEFS.find((folder) => folder.type === normalizedType);
  return match ? match.id : SESSION_SHORTCUT_FOLDER_DEFS[0].id;
}

function normalizeSessionShortcutFolderId(folderId, type) {
  const id = String(folderId || '').trim();
  if (SESSION_SHORTCUT_FOLDER_ID_SET.has(id)) return id;
  return defaultSessionShortcutFolderId(type);
}

function sessionShortcutFolderName(folderId) {
  const normalizedId = normalizeSessionShortcutFolderId(folderId);
  const folder = SESSION_SHORTCUT_FOLDER_DEFS.find((item) => item.id === normalizedId);
  return folder ? folder.name : 'Sessions';
}
function normalizeFolderId(value) {
  const id = String(value || '').trim();
  if (!id) return null;
  if (!FOLDERS.some((folder) => folder.id === id)) return null;
  return id;
}

function folderNameById(folderId) {
  const id = String(folderId || '').trim();
  if (!id) return '';
  const folder = FOLDERS.find((item) => item.id === id);
  return folder ? folder.name : '';
}

function loadCollapsedFolders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDER_COLLAPSE_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return new Set();
    const ids = parsed
      .map((id) => String(id || '').trim())
      .filter((id) => id.length > 0);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders() {
  try {
    localStorage.setItem(FOLDER_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedFolderIds)));
  } catch {
    // Ignore localStorage failures.
  }
}

function isFolderCollapsed(folderId) {
  return collapsedFolderIds.has(String(folderId || '').trim());
}

function toggleFolderCollapsed(folderId) {
  const id = String(folderId || '').trim();
  if (!id) return;
  if (collapsedFolderIds.has(id)) collapsedFolderIds.delete(id);
  else collapsedFolderIds.add(id);
  saveCollapsedFolders();
  renderSidebar();
  if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
  refreshRailActive();
  refreshSidebarBadges();
}

function updateAvgPingRefreshButton() {
  const btn = document.getElementById('h-avgping-refresh-btn');
  if (!btn) return;
  btn.disabled = statusRefreshInFlight;
  btn.classList.toggle('is-loading', statusRefreshInFlight);
  btn.title = statusRefreshInFlight ? 'Refreshing server ping...' : 'Refresh server ping';
  btn.setAttribute('aria-busy', statusRefreshInFlight ? 'true' : 'false');
}

function updateHeaderStats() {
  const total = SRV.length;
  const online = SRV.filter(s => s.status === 'online').length;
  const latencies = SRV.map(s => s.latencyMs).filter(v => typeof v === 'number');
  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)}ms`
    : '\u2014';

  document.getElementById('h-online').textContent = online;
  document.getElementById('h-total').textContent = total;
  document.getElementById('h-avgping').textContent = avgLatency;
  updateAvgPingRefreshButton();
  const sbCount = document.getElementById('sb-count');
  if (sbCount) sbCount.textContent = `${total}`;
  const sbNodeSummary = document.getElementById('sb-node-summary');
  if (sbNodeSummary) sbNodeSummary.textContent = `${total}`;
  renderMainDashboard();
}

function formatMemoryMb(value) {
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb <= 0) return '\u2014';
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function loadSessionShortcuts() {
  return loadSessionShortcutsFromStorage((entry) => {
    const shortcut = normalizeSessionShortcutEntry(entry);
    if (!shortcut) return null;
    return {
      ...shortcut,
      folderId: normalizeSessionShortcutFolderId(shortcut.folderId, shortcut.type),
    };
  });
}

function saveSessionShortcuts() {
  saveSessionShortcutsToStorage(SESSION_SHORTCUTS);
}

function addSessionShortcut(entry) {
  const type = normalizeSessionShortcutType(entry?.type);
  SESSION_SHORTCUTS = addSessionShortcutEntry(SESSION_SHORTCUTS, {
    ...entry,
    type,
    folderId: normalizeSessionShortcutFolderId(entry?.folderId, type),
  });
  saveSessionShortcuts();
  renderSidebar();
  refreshSidebarBadges();
}

function removeSessionShortcut(shortcutId) {
  SESSION_SHORTCUTS = removeSessionShortcutEntry(SESSION_SHORTCUTS, shortcutId);
  saveSessionShortcuts();
  renderSidebar();
  refreshSidebarBadges();
}

function findSessionShortcutById(shortcutId) {
  const id = String(shortcutId || '').trim();
  if (!id) return null;
  return SESSION_SHORTCUTS.find((item) => item.id === id) || null;
}

function defaultSessionShortcutName(type, payload = {}) {
  if (type === 'local_shell') return `Local ${localShellLabel(payload.shellType || 'powershell')}`;
  if (type === 'wsl_shell') return 'Local WSL';
  if (type === 'serial') return `Serial ${payload.serialPort || ''}`.trim() || 'Serial';

  const host = String(payload.host || '').trim();
  const port = Number(payload.port);
  if (type === 'vnc') {
    const resolvedPort = Number.isFinite(port) && port > 0 ? port : 5900;
    return `VNC ${host}:${resolvedPort}`;
  }
  if (host && Number.isFinite(port) && port > 0) return `${String(type || '').toUpperCase()} ${host}:${port}`;
  if (host) return `${String(type || '').toUpperCase()} ${host}`;
  return sessionShortcutDisplayName({ type, payload, name: '' }, localShellLabel);
}

function updateSessionShortcut(shortcutId, updater) {
  const existing = findSessionShortcutById(shortcutId);
  if (!existing) return null;
  const next = updater(existing);
  if (!next) return null;
  const normalizedNext = normalizeSessionShortcutEntry(next);
  if (!normalizedNext) return null;
  const hydratedNext = {
    ...normalizedNext,
    folderId: normalizeSessionShortcutFolderId(normalizedNext.folderId, normalizedNext.type),
  };
  SESSION_SHORTCUTS = SESSION_SHORTCUTS.map((item) => (item.id === existing.id ? hydratedNext : item));
  saveSessionShortcuts();
  renderSidebar();
  refreshSidebarBadges();
  return hydratedNext;
}

function findVncTabIdByShortcutId(shortcutId) {
  const id = String(shortcutId || '').trim();
  if (!id) return null;
  const match = Object.entries(termTabs).find(([, tab]) => tab.mode === 'vnc' && tab.shortcutId === id);
  return match ? match[0] : null;
}

function sessionShortcutConnectionState(shortcut) {
  if (!shortcut || shortcut.type !== 'vnc') return 'saved';
  const tab = Object.values(termTabs).find((item) => item.mode === 'vnc' && item.shortcutId === shortcut.id);
  if (!tab) return 'saved';
  return String(tab.connStatus || 'disconnected');
}

function sessionShortcutIndicatorColor(shortcut) {
  const state = sessionShortcutConnectionState(shortcut);
  if (state === 'connected') return '#00ffaa';
  if (state === 'error') return '#ff3b5c';
  if (state === 'connecting') return '#f5a623';
  return '#3a5570';
}

function sessionShortcutStatusLabel(shortcut) {
  const state = sessionShortcutConnectionState(shortcut);
  if (state === 'connected') return 'CONNECTED';
  if (state === 'connecting') return 'CONNECTING';
  if (state === 'error') return 'ERROR';
  if (state === 'disconnected') return 'DISCONNECTED';
  return 'SAVED';
}

function loadRecentSessions() {
  return loadRecentSessionsFromStorage((entry) => normalizeRecentSessionEntryFromStorage(entry, normalizeLocalShellType));
}

function saveRecentSessions() {
  saveRecentSessionsToStorage(recentLocalSessions);
}

function renderRecentSessionHistory() {
  renderRecentSessionHistoryView({
    recentSessions: recentLocalSessions,
    escapeHtml,
    localShellLabel,
    restoreRecentSession,
  });
}

function syncRecentSessionViewport() {
  syncRecentSessionViewportView();
}

function trackRecentSession(sessionEntry) {
  recentLocalSessions = trackRecentSessionEntry(
    recentLocalSessions,
    sessionEntry,
    (entry) => normalizeRecentSessionEntryFromStorage(entry, normalizeLocalShellType)
  );
  saveRecentSessions();
  renderRecentSessionHistory();
}

function trackRecentLocalSession(sessionEntry) {
  trackRecentSession({ ...sessionEntry, mode: 'local' });
}

function trackRecentSshSession(sessionEntry) {
  trackRecentSession({ ...sessionEntry, mode: 'ssh' });
}

function removeMostRecentSession() {
  const result = removeMostRecentSessionEntry(recentLocalSessions);
  recentLocalSessions = result.recentSessions;
  if (!result.removed) return null;
  saveRecentSessions();
  renderRecentSessionHistory();
  return result.removed;
}

function findLocalTabIdByHistoryId(historyId) {
  return findLocalTabIdByHistoryIdInTabs(termTabs, historyId);
}

function findSshTabIdByHistoryId(historyId) {
  return findSshTabIdByHistoryIdInTabs(termTabs, historyId);
}

async function refreshHostDeviceInfo() {
  try {
    hostDeviceInfo = await invoke('get_host_device_info');
  } catch {
    hostDeviceInfo = null;
  }
  renderMainDashboard();
}

function renderMainDashboard() {
  const info = hostDeviceInfo;
  const hostEl = document.getElementById('dash-hostname');
  const osEl = document.getElementById('dash-os');
  const coresEl = document.getElementById('dash-cpu-cores');
  const memEl = document.getElementById('dash-memory');
  const pathEl = document.getElementById('dash-terminal-path');

  if (hostEl) hostEl.textContent = info?.hostname || '\u2014';
  if (osEl) {
    const osName = info?.os_name || 'Unknown OS';
    const osVersion = info?.os_version ? ` ${info.os_version}` : '';
    const arch = info?.arch ? ` (${info.arch})` : '';
    osEl.textContent = `${osName}${osVersion}${arch}`;
  }
  if (coresEl) coresEl.textContent = info?.cpu_cores ? String(info.cpu_cores) : '\u2014';
  if (memEl) memEl.textContent = formatMemoryMb(info?.total_memory_mb || 0);
  if (pathEl) pathEl.textContent = `Terminal workspace: ${info?.terminal_workspace || '\u2014'}`;
  renderMainServerList();
  renderRecentSessionHistory();
  if (mainDashboardActive) {
    ensureDashboardMap();
    renderDashboardMapMarkers(false);
    if (dashMap) setTimeout(() => { dashMap.invalidateSize(); }, 0);
  }
}

function renderMainServerList() {
  const listEl = document.getElementById('dash-server-list');
  if (!listEl) return;

  if (!SRV.length) {
    listEl.innerHTML = '<div class="dash-server-empty">No servers configured.</div>';
    return;
  }

  listEl.innerHTML = SRV.map((server) => {
    const pingText = typeof server.latencyMs === 'number'
      ? `${server.latencyMs}ms`
      : server.status === 'offline' ? 'OFF' : '\u2014';
    const pingColor = latencyColor(server.latencyMs, server.status);
    const activeClass = server.id === selId ? ' active' : '';
    return `<button class="dash-server-item${activeClass}" type="button" data-server-id="${escapeHtml(server.id)}" title="Select ${escapeHtml(server.name)}">
      <span class="dash-server-dot" style="background:${sDot(server.status)};box-shadow:0 0 6px ${sDot(server.status)}"></span>
      <span class="dash-server-name">${escapeHtml(server.name)}</span>
      <span class="dash-server-latency" style="color:${pingColor}">${pingText}</span>
    </button>`;
  }).join('');

  listEl.querySelectorAll('.dash-server-item').forEach((item) => {
    item.addEventListener('click', () => {
      const serverId = item.dataset.serverId || '';
      if (!serverId) return;
      selectSrv(serverId, { keepMain: true });
    });
  });
}

function hasTerminalTabsOpen() {
  return Object.keys(termTabs).length > 0;
}

function hasVisibleTerminalTabsForSelection() {
  return Object.values(termTabs).some((tab) => tab.mode === 'local' || tab.pinned || tab.srvId === selId);
}

function updateMainTerminalLayout() {
  const bottomSection = document.getElementById('bottom-section');
  const dashSection = document.getElementById('dashboard-section');
  const maxBtn = document.getElementById('tab-maximize-btn');
  if (!bottomSection || !dashSection) return;

  if (!mainDashboardActive) {
    bottomSection.classList.remove('terminal-collapsed');
    bottomSection.style.flex = '';
    bottomSection.style.height = '';
    dashSection.style.flex = '';
    dashSection.style.height = '';
    if (maxBtn) maxBtn.style.display = '';
    return;
  }

  const hasTabs = mainDashboardActive ? hasVisibleTerminalTabsForSelection() : hasTerminalTabsOpen();
  if (!hasTabs) {
    bottomSection.classList.add('terminal-collapsed');
    bottomSection.style.flex = '0 0 38px';
    bottomSection.style.height = '38px';
    dashSection.style.display = '';
    dashSection.style.flex = '1 1 auto';
    dashSection.style.height = 'auto';
    if (maxBtn) maxBtn.style.display = 'none';
    return;
  }

  if (layoutController?.isMaximized()) {
    bottomSection.classList.remove('terminal-collapsed');
    bottomSection.style.flex = '1 1 auto';
    bottomSection.style.height = 'auto';
    dashSection.style.display = 'none';
    dashSection.style.flex = '0 0 0';
    dashSection.style.height = '0';
    if (maxBtn) maxBtn.style.display = '';
    return;
  }

  bottomSection.classList.remove('terminal-collapsed');
  dashSection.style.display = '';
  bottomSection.style.flex = '0 0 50%';
  bottomSection.style.height = '50%';
  dashSection.style.flex = '0 0 50%';
  dashSection.style.height = '50%';
  if (maxBtn) maxBtn.style.display = '';
}

function setMainDashboardActive(active) {
  mainDashboardActive = Boolean(active);
  const mainBtn = document.getElementById('sb-main-tab');
  const mapSection = document.getElementById('map-section');
  const dashSection = document.getElementById('dashboard-section');
  const metricsBtn = document.getElementById('tab-metrics-btn');
  if (mainBtn) mainBtn.classList.toggle('active', mainDashboardActive);
  if (mapSection) mapSection.style.display = mainDashboardActive ? 'none' : '';
  if (dashSection) dashSection.style.display = mainDashboardActive ? '' : 'none';
  if (metricsBtn) metricsBtn.style.display = mainDashboardActive ? 'none' : '';
  if (mainDashboardActive) {
    selectSrv(null, { keepMain: true });
    renderMainDashboard();
    void refreshHostDeviceInfo();
    setTerminalPickerVisible(false);
    hideTabAddMenu();
    setTimeout(() => {
      if (dashMap) {
        dashMap.invalidateSize();
        renderDashboardMapMarkers(true);
      }
    }, 140);
  }
  if (!mainDashboardActive) {
    setTerminalPickerVisible(false);
    hideTabAddMenu();
    setTimeout(() => { map.invalidateSize(); }, 120);
  }
  updateMainTerminalLayout();
}

function setTerminalPickerVisible(visible) {
  const picker = document.getElementById('dash-terminal-picker');
  if (!picker) return;
  picker.style.display = visible ? 'flex' : 'none';
}

function normalizeLocalShellType(shellType) {
  const value = String(shellType || '').toLowerCase();
  if (value === 'cmd' || value === 'bash' || value === 'zsh' || value === 'wsl') return value;
  return 'powershell';
}

function localShellLabel(shellType) {
  const kind = normalizeLocalShellType(shellType);
  if (kind === 'cmd') return 'CMD';
  if (kind === 'bash') return 'Bash';
  if (kind === 'zsh') return 'Zsh';
  if (kind === 'wsl') return 'WSL';
  return 'PowerShell';
}

recentLocalSessions = loadRecentSessions();
SESSION_SHORTCUTS = loadSessionShortcuts();

async function startLocalTerminalFromDashboard(terminalType) {
  const terminalKind = normalizeLocalShellType(terminalType);
  const terminalLabel = localShellLabel(terminalKind);
  const btn = document.getElementById('dash-start-local-terminal-btn');
  const status = document.getElementById('dash-status');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting...';
  }
  setTerminalPickerVisible(false);
  if (status) {
    status.classList.remove('error');
    status.textContent = `Launching ${terminalLabel}...`;
  }

  try {
    const tid = addLocalTermTab(terminalKind);
    if (!tid) throw new Error('Could not create local terminal tab');
    if (status) {
      status.classList.remove('error');
      status.textContent = `${terminalLabel} tab opened.`;
    }
  } catch (err) {
    if (status) {
      status.classList.add('error');
      status.textContent = `Failed to start local terminal: ${String(err)}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start Local Terminal';
    }
  }
}

async function removePreviousSessionFromDashboard() {
  const status = document.getElementById('dash-status');
  const removed = removeMostRecentSession();
  if (!removed) {
    if (status) {
      status.classList.remove('error');
      status.textContent = 'No previous session in history.';
    }
    return;
  }

  const openTabId = removed.mode === 'ssh'
    ? findSshTabIdByHistoryId(removed.id)
    : findLocalTabIdByHistoryId(removed.id);
  if (openTabId) {
    await closeTab(null, openTabId);
  }

  if (status) {
    status.classList.remove('error');
    if (removed.mode === 'ssh') {
      const label = removed.serverName || removed.host || 'SSH';
      status.textContent = `${label} session removed.`;
    } else {
      status.textContent = `${localShellLabel(removed.shell || 'powershell')} session removed.`;
    }
  }
}

async function restoreRecentSession(sessionId) {
  const status = document.getElementById('dash-status');
  const entry = recentLocalSessions.find((item) => item.id === sessionId);
  if (!entry) {
    if (status) {
      status.classList.add('error');
      status.textContent = 'Selected recent session was not found.';
    }
    return;
  }

  try {
    if (entry.mode === 'ssh') {
      const existingSshTabId = findSshTabIdByHistoryId(entry.id);
      if (existingSshTabId) {
        setActiveTab(existingSshTabId);
        if (status) {
          status.classList.remove('error');
          status.textContent = `${entry.serverName || entry.host || 'SSH'} session restored (already open).`;
        }
        return;
      }

      const server = SRV.find((item) => item.id === entry.serverId)
        || SRV.find((item) => item.host === entry.host && Number(item.port) === Number(entry.port || 22));
      if (!server) throw new Error('Server for this SSH session is no longer configured');

      selectSrv(server.id, { keepMain: true });
      const tid = addTermTab({
        serverId: server.id,
        historyId: entry.id,
        usernameOverride: entry.username || undefined,
      });
      if (!tid) throw new Error('Could not restore SSH session');
      setActiveTab(tid);
      if (status) {
        status.classList.remove('error');
        status.textContent = `${server.name} SSH session restored.`;
      }
      return;
    }

    const existingLocalTabId = findLocalTabIdByHistoryId(entry.id);
    const shell = normalizeLocalShellType(entry.shell || 'powershell');
    const shellLabel = localShellLabel(shell);
    if (existingLocalTabId) {
      setActiveTab(existingLocalTabId);
      if (status) {
        status.classList.remove('error');
        status.textContent = `${shellLabel} session restored (already open).`;
      }
      return;
    }

    const tid = addLocalTermTab(shell, { historyId: entry.id });
    if (!tid) throw new Error('Could not restore session');
    setActiveTab(tid);
    if (status) {
      status.classList.remove('error');
      status.textContent = `${shellLabel} session restored.`;
    }
  } catch (err) {
    if (status) {
      status.classList.add('error');
      status.textContent = `Session restore failed: ${String(err)}`;
    }
  }
}

async function refreshServerStatuses() {
  if (statusRefreshInFlight || SRV.length === 0) {
    updateHeaderStats();
    return;
  }

  statusRefreshInFlight = true;
  updateAvgPingRefreshButton();

  try {
    await Promise.all(SRV.map(async (server) => {
      try {
        const result = await invoke('check_server_status', {
          host: server.host,
          port: server.port,
          timeoutMs: 2500,
        });
        const status = result?.status;
        server.status = status === 'online' || status === 'offline' || status === 'unknown'
          ? status
          : 'unknown';
        server.latencyMs = typeof result?.latency_ms === 'number' ? Math.max(0, Math.round(result.latency_ms)) : null;
        server.resolvedIp = typeof result?.ip === 'string' ? result.ip : server.resolvedIp || null;
        server.statusReason = typeof result?.reason === 'string' ? result.reason : null;
      } catch {
        server.status = 'unknown';
        server.latencyMs = null;
        server.statusReason = null;
      }
    }));
  } finally {
    statusRefreshInFlight = false;
    const repaint = () => {
      updateHeaderStats();
      renderSidebar();
      renderMapMarkers();
      if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
      refreshRailActive();
      refreshSidebarBadges();
      refreshSftpBrowserTab();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(repaint, { timeout: 200 });
    } else {
      setTimeout(repaint, 0);
    }
  }
}

/* ══════════════════════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════════════════════ */
function clearSidebarDragState() {
  sidebarPointerDragState = null;
  document.querySelectorAll('.snode').forEach((node) => {
    node.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
  });
  document.querySelectorAll('.sb-folder-drop-target').forEach((node) => {
    node.classList.remove('drag-over-folder');
  });
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
}

function beginSidebarPointerDrag(ev, item, nodeEl) {
  if (ev.button !== 0) return;
  const itemType = item && typeof item === 'object' ? String(item.type || 'server') : 'server';
  const itemId = item && typeof item === 'object' ? String(item.id || '').trim() : String(item || '').trim();
  if (!itemId) return;
  sidebarPointerDragState = {
    itemType,
    itemId,
    nodeEl,
    startX: ev.clientX,
    startY: ev.clientY,
    active: false,
    targetType: null,
    targetId: null,
    targetFolderId: null,
    insertBefore: true,
  };
  window.addEventListener('mousemove', onSidebarPointerDragMove);
  window.addEventListener('mouseup', onSidebarPointerDragEnd);
}

function onSidebarPointerDragMove(ev) {
  const state = sidebarPointerDragState;
  if (!state) return;

  if (!state.active) {
    const dx = Math.abs(ev.clientX - state.startX);
    const dy = Math.abs(ev.clientY - state.startY);
    if (dx < 4 && dy < 4) return;
    state.active = true;
    state.nodeEl.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }

  const hovered = document.elementFromPoint(ev.clientX, ev.clientY);
  const targetNode = hovered instanceof Element ? hovered.closest('.snode') : null;
  const targetFolder = hovered instanceof Element ? hovered.closest('.sb-folder-drop-target') : null;

  document.querySelectorAll('.snode').forEach((node) => {
    node.classList.remove('drag-over-before', 'drag-over-after');
  });
  document.querySelectorAll('.sb-folder-drop-target').forEach((node) => {
    node.classList.remove('drag-over-folder');
  });

  if (targetNode) {
    const targetId = state.itemType === 'session'
      ? String(targetNode.dataset.shortcutId || '').trim()
      : String(targetNode.dataset.serverId || '').trim();
    if (!targetId || targetId === state.itemId) {
      state.targetType = null;
      state.targetId = null;
      state.targetFolderId = null;
      return;
    }

    if (state.itemType === 'server' && !targetNode.dataset.serverId) {
      state.targetType = null;
      state.targetId = null;
      state.targetFolderId = null;
      return;
    }
    if (state.itemType === 'session' && !targetNode.dataset.shortcutId) {
      state.targetType = null;
      state.targetId = null;
      state.targetFolderId = null;
      return;
    }

    const targetFolderId = state.itemType === 'session'
      ? normalizeSessionShortcutFolderId(targetNode.dataset.sessionFolderId || '', findSessionShortcutById(targetId)?.type)
      : SRV.find((server) => server.id === targetId)?.folderId || null;
    const rect = targetNode.getBoundingClientRect();
    const insertBefore = (ev.clientY - rect.top) < (rect.height / 2);
    targetNode.classList.toggle('drag-over-before', insertBefore);
    targetNode.classList.toggle('drag-over-after', !insertBefore);
    state.targetType = state.itemType;
    state.targetId = targetId;
    state.targetFolderId = targetFolderId;
    state.insertBefore = insertBefore;
    return;
  }

  if (targetFolder) {
    const dropKind = String(targetFolder.dataset.dropKind || 'server');
    if (dropKind !== state.itemType) {
      state.targetType = null;
      state.targetId = null;
      state.targetFolderId = null;
      return;
    }
    const folderId = state.itemType === 'session'
      ? normalizeSessionShortcutFolderId(
        String(targetFolder.dataset.dropSessionFolderId || '').trim(),
        findSessionShortcutById(state.itemId)?.type
      )
      : normalizeFolderId(String(targetFolder.dataset.dropFolderId || '').trim());
    targetFolder.classList.add('drag-over-folder');
    state.targetType = 'folder';
    state.targetId = '';
    state.targetFolderId = folderId;
    return;
  }

  if (!targetNode && !targetFolder) {
    state.targetType = null;
    state.targetId = null;
    state.targetFolderId = null;
    return;
  }
}

function updateServerFolderLocal(serverId, folderId) {
  const server = SRV.find((item) => item.id === serverId);
  if (!server) return false;
  const nextFolderId = normalizeFolderId(folderId);
  const prevFolderId = normalizeFolderId(server.folderId);
  if (prevFolderId === nextFolderId) return false;
  server.folderId = nextFolderId;
  if (server._raw && typeof server._raw === 'object') {
    server._raw.folder_id = nextFolderId;
  }
  return true;
}

function updateSessionShortcutFolderLocal(shortcutId, folderId) {
  const shortcut = findSessionShortcutById(shortcutId);
  if (!shortcut) return false;
  const nextFolderId = normalizeSessionShortcutFolderId(folderId, shortcut.type);
  const prevFolderId = normalizeSessionShortcutFolderId(shortcut.folderId, shortcut.type);
  if (prevFolderId === nextFolderId) return false;
  shortcut.folderId = nextFolderId;
  return true;
}

async function applyAndPersistSidebarMutation({ reorderChanged = false, folderChanged = false, movedServerId = '' } = {}) {
  if (!reorderChanged && !folderChanged) return;
  try {
    if (folderChanged && movedServerId) {
      const moved = SRV.find((item) => item.id === movedServerId);
      if (moved) {
        await saveServerModel(moved, { folder_id: moved.folderId || null });
      }
    }
    if (reorderChanged) {
      await persistServerOrder();
    }
  } catch (error) {
    console.error('Failed to persist sidebar mutation:', error);
    await loadServers();
    return;
  }

  updateHeaderStats();
  renderSidebar();
  if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
  refreshRailActive();
  refreshSidebarBadges();
  renderServerList();
}

function applyAndPersistSessionSidebarMutation() {
  saveSessionShortcuts();
  renderSidebar();
  refreshSidebarBadges();
}

function onSidebarPointerDragEnd(ev) {
  const state = sidebarPointerDragState;
  window.removeEventListener('mousemove', onSidebarPointerDragMove);
  window.removeEventListener('mouseup', onSidebarPointerDragEnd);
  if (!state) return;

  if (state.itemType === 'session') {
    let changed = false;
    let reorderChanged = false;
    let folderChanged = false;
    if (state.active) {
      sidebarSuppressClickUntilMs = Date.now() + 250;
      if (state.targetType === 'session' && state.targetId) {
        reorderChanged = moveSessionShortcutOrder(state.itemId, state.targetId, state.insertBefore);
        folderChanged = updateSessionShortcutFolderLocal(state.itemId, state.targetFolderId);
        changed = reorderChanged || folderChanged;
      } else if (state.targetType === 'folder') {
        folderChanged = updateSessionShortcutFolderLocal(state.itemId, state.targetFolderId);
        reorderChanged = moveSessionShortcutOrderToEnd(state.itemId);
        changed = reorderChanged || folderChanged;
      } else {
        const list = document.getElementById('sb-list');
        if (list) {
          const rect = list.getBoundingClientRect();
          const inList = ev.clientX >= rect.left
            && ev.clientX <= rect.right
            && ev.clientY >= rect.top
            && ev.clientY <= rect.bottom;
          if (inList) {
            reorderChanged = moveSessionShortcutOrderToEnd(state.itemId);
            changed = reorderChanged;
          }
        }
      }
    }

    clearSidebarDragState();
    if (changed) applyAndPersistSessionSidebarMutation();
    return;
  }

  let changed = false;
  let reorderChanged = false;
  let folderChanged = false;
  let movedServerId = state.itemId;
  if (state.active) {
    sidebarSuppressClickUntilMs = Date.now() + 250;
    if (state.targetType === 'server' && state.targetId) {
      reorderChanged = moveServerOrder(state.itemId, state.targetId, state.insertBefore);
      folderChanged = updateServerFolderLocal(state.itemId, state.targetFolderId);
      changed = reorderChanged || folderChanged;
    } else if (state.targetType === 'folder') {
      folderChanged = updateServerFolderLocal(state.itemId, state.targetFolderId);
      reorderChanged = moveServerOrderToEnd(state.itemId);
      changed = reorderChanged || folderChanged;
    } else {
      const list = document.getElementById('sb-list');
      if (list) {
        const rect = list.getBoundingClientRect();
        const inList = ev.clientX >= rect.left
          && ev.clientX <= rect.right
          && ev.clientY >= rect.top
          && ev.clientY <= rect.bottom;
        if (inList) {
          reorderChanged = moveServerOrderToEnd(state.itemId);
          changed = reorderChanged;
        }
      }
    }
  }

  clearSidebarDragState();
  if (changed) void applyAndPersistSidebarMutation({ reorderChanged, folderChanged, movedServerId });
}

function moveServerOrder(draggedId, targetId, insertBefore) {
  const from = SRV.findIndex((server) => server.id === draggedId);
  const to = SRV.findIndex((server) => server.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;

  const [moved] = SRV.splice(from, 1);
  let insertAt = to;
  if (from < to) insertAt -= 1;
  if (!insertBefore) insertAt += 1;
  insertAt = Math.max(0, Math.min(insertAt, SRV.length));
  SRV.splice(insertAt, 0, moved);
  return true;
}

function moveServerOrderToEnd(serverId) {
  const from = SRV.findIndex((server) => server.id === serverId);
  if (from < 0 || from === SRV.length - 1) return false;
  const [moved] = SRV.splice(from, 1);
  SRV.push(moved);
  return true;
}

function moveSessionShortcutOrder(draggedId, targetId, insertBefore) {
  const from = SESSION_SHORTCUTS.findIndex((shortcut) => shortcut.id === draggedId);
  const to = SESSION_SHORTCUTS.findIndex((shortcut) => shortcut.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;

  const [moved] = SESSION_SHORTCUTS.splice(from, 1);
  let insertAt = to;
  if (from < to) insertAt -= 1;
  if (!insertBefore) insertAt += 1;
  insertAt = Math.max(0, Math.min(insertAt, SESSION_SHORTCUTS.length));
  SESSION_SHORTCUTS.splice(insertAt, 0, moved);
  return true;
}

function moveSessionShortcutOrderToEnd(shortcutId) {
  const from = SESSION_SHORTCUTS.findIndex((shortcut) => shortcut.id === shortcutId);
  if (from < 0 || from === SESSION_SHORTCUTS.length - 1) return false;
  const [moved] = SESSION_SHORTCUTS.splice(from, 1);
  SESSION_SHORTCUTS.push(moved);
  return true;
}

async function persistServerOrder() {
  try {
    await invoke('reorder_servers', { serverIds: SRV.map((server) => server.id) });
  } catch (error) {
    console.error('Failed to persist server order:', error);
  }
}

async function launchSessionShortcut(shortcut) {
  if (!shortcut) return;
  const payload = shortcut.payload || {};

  if (shortcut.type === 'local_shell') {
    addLocalTermTab(normalizeLocalShellType(payload.shellType || 'powershell'));
    return;
  }
  if (shortcut.type === 'wsl_shell') {
    addLocalTermTab('wsl');
    return;
  }

  if (shortcut.type === 'vnc') {
    const existingTabId = findVncTabIdByShortcutId(shortcut.id);
    if (existingTabId) {
      setActiveTab(existingTabId);
      return;
    }
    addVncTab({
      host: payload.host || '',
      port: Number(payload.port) || 5900,
      password: payload.password || '',
      label: shortcut.name || `${payload.host}:${payload.port || 5900}`,
      shortcutId: shortcut.id,
    });
    return;
  }

  if (isExternalLauncherSession(shortcut.type)) {
    try {
      const command = buildExternalSessionCommand(shortcut.type, payload);
      await launchExternalCommandSession(command);
    } catch (error) {
      showError(`Failed to launch saved ${shortcut.type.toUpperCase()} session`, error);
    }
  }
}

function renderSidebarServerItem(server, list, rail, options = {}) {
  const pingText = typeof server.latencyMs === 'number' ? `${server.latencyMs}ms` : server.status === 'offline' ? 'OFF' : '\u2014';
  const pingColor = latencyColor(server.latencyMs, server.status);
  const iconSvg = serverIconSvg(server.icon);
  const safeName = escapeHtml(String(server.name || '\u2014'));
  const safeLoc = escapeHtml(String(server.loc || 'Unknown location'));
  const indented = Boolean(options.indented);

  const el = document.createElement('div');
  el.className = `snode reorderable${indented ? ' snode-in-folder' : ''}`;
  el.id = `sn-${server.id}`;
  el.dataset.serverId = server.id;
  el.title = `${server.name} \u00b7 ${server.loc || 'Unknown location'}`;
  el.innerHTML = `<div class="snode-dot" style="background:${sDot(server.status)};box-shadow:0 0 6px ${sDot(server.status)}"></div>
    <span class="snode-icon" title="${serverIconLabel(server.icon)}">${iconSvg}</span>
    <div class="snode-main"><div class="snode-name">${safeName}</div></div>
    <div class="snode-right">
      <span class="snode-tabs" id="stabs-${server.id}" style="display:none"></span>
      <div class="snode-ping" style="color:${pingColor}">${pingText}</div>
    </div>`;
  el.addEventListener('mousedown', (ev) => beginSidebarPointerDrag(ev, { type: 'server', id: server.id }, el));
  el.addEventListener('click', (ev) => {
    if (Date.now() < sidebarSuppressClickUntilMs) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    selectSrv(server.id);
    if (window.innerWidth <= 700) toggleSidebar(false);
  });
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectSrv(server.id);
    showServerContextMenu(ev.clientX, ev.clientY, server.id);
  });
  list.appendChild(el);

  const railItem = document.createElement('div');
  railItem.className = 'sb-rail-item';
  railItem.id = `rail-${server.id}`;
  railItem.innerHTML = `<div class="sb-rail-dot" style="background:${sDot(server.status)};box-shadow:0 0 5px ${sDot(server.status)}"></div>
    <div class="sb-rail-tip"><strong>${safeName}</strong> \u00b7 ${safeLoc}</div>`;
  railItem.addEventListener('click', () => selectSrv(server.id));
  railItem.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectSrv(server.id);
    showServerContextMenu(ev.clientX, ev.clientY, server.id);
  });
  rail.appendChild(railItem);
}

function renderSidebarSessionItem(shortcut, list, options = {}) {
  const indented = Boolean(options.indented);
  const label = escapeHtml(sessionShortcutDisplayName(shortcut));
  const meta = escapeHtml(sessionShortcutMeta(shortcut));
  const indicatorColor = sessionShortcutIndicatorColor(shortcut);
  const statusLabel = sessionShortcutStatusLabel(shortcut);
  const detailText = escapeHtml(meta ? `${meta} · ${statusLabel}` : statusLabel);

  const el = document.createElement('div');
  el.className = `snode snode-session${indented ? ' snode-in-folder' : ''}`;
  el.id = `ssn-${shortcut.id}`;
  el.dataset.shortcutId = shortcut.id;
  el.dataset.sessionFolderId = normalizeSessionShortcutFolderId(shortcut.folderId, shortcut.type);
  el.title = `${sessionShortcutDisplayName(shortcut)} · Left click to launch, right click to remove`;
  el.innerHTML = `<div class="snode-dot" style="background:#ffd84d;box-shadow:0 0 6px #ffd84d88"></div>
    <span class="snode-icon" title="Session Shortcut">${serverIconSvg('terminal')}</span>
    <div class="snode-main"><div class="snode-name">${label}</div></div>
    <div class="snode-right"><div class="snode-ping" style="color:#ffd98a">${meta}</div></div>`;
  el.title = `${sessionShortcutDisplayName(shortcut)} · Left click to connect, right click for actions`;
  el.innerHTML = `<div class="snode-dot" style="background:${indicatorColor};box-shadow:0 0 6px ${indicatorColor}88"></div>
    <span class="snode-icon" title="Session Shortcut">${serverIconSvg('terminal')}</span>
    <div class="snode-main"><div class="snode-name">${label}</div></div>
    <div class="snode-right"><div class="snode-ping" style="color:#ffd98a">${detailText}</div></div>`;

  el.addEventListener('mousedown', (ev) => beginSidebarPointerDrag(ev, { type: 'session', id: shortcut.id }, el));
  el.addEventListener('click', async (ev) => {
    if (Date.now() < sidebarSuppressClickUntilMs) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    await launchSessionShortcut(shortcut);
    if (window.innerWidth <= 700) toggleSidebar(false);
  });

  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showSessionContextMenu(ev.clientX, ev.clientY, shortcut.id);
  });

  list.appendChild(el);
}

function renderSidebar() {
  const list = document.getElementById('sb-list');
  const rail = document.getElementById('sb-rail');
  clearSidebarDragState();
  list.innerHTML = '';
  rail.innerHTML = '';

  if (SRV.length === 0 && FOLDERS.length === 0) {
    list.innerHTML = `<div style="padding:20px 12px;text-align:center;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;line-height:1.8">
      No servers configured.<br>Click the <span style="color:var(--accent2);font-weight:700">+</span> button above<br>to add your first server.
    </div>`;
    return;
  }

  const groupedServers = new Map();
  const sessionShortcuts = SESSION_SHORTCUTS.slice(0, SESSION_SHORTCUT_LIMIT);
  const groupedSessionShortcuts = new Map();
  FOLDERS.forEach((folder) => groupedServers.set(folder.id, []));
  SESSION_SHORTCUT_FOLDER_DEFS.forEach((folder) => groupedSessionShortcuts.set(folder.id, []));
  const ungroupedServers = [];
  SRV.forEach((server) => {
    const folderId = normalizeFolderId(server.folderId);
    if (folderId && groupedServers.has(folderId)) groupedServers.get(folderId).push(server);
    else ungroupedServers.push(server);
  });
  sessionShortcuts.forEach((shortcut) => {
    const folderId = normalizeSessionShortcutFolderId(shortcut.folderId, shortcut.type);
    shortcut.folderId = folderId;
    groupedSessionShortcuts.get(folderId)?.push(shortcut);
  });

  FOLDERS.forEach((folder) => {
    const collapsed = isFolderCollapsed(folder.id);
    const isSystemSessionFolder = isSessionFolderId(folder.id);
    const folderRow = document.createElement('div');
    folderRow.className = `sb-folder-row${isSystemSessionFolder ? ' sb-folder-system' : ' sb-folder-drop-target'}${collapsed ? ' collapsed' : ''}`;
    folderRow.dataset.folderId = folder.id;
    if (!isSystemSessionFolder) {
      folderRow.dataset.dropKind = 'server';
      folderRow.dataset.dropFolderId = folder.id;
    }
    folderRow.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const folderCount = (groupedServers.get(folder.id) || []).length + (isSystemSessionFolder ? sessionShortcuts.length : 0);
    folderRow.innerHTML = `<span class="sb-folder-caret">${collapsed ? '&#9656;' : '&#9662;'}</span><span class="sb-folder-icon">${folderIconSvg(isSystemSessionFolder ? 'sessions' : 'folder')}</span><span class="sb-folder-name">${escapeHtml(folder.name)}</span><span class="sb-folder-count">${folderCount}</span>`;
    folderRow.addEventListener('click', (ev) => {
      if (Date.now() < sidebarSuppressClickUntilMs) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleFolderCollapsed(folder.id);
    });
    if (!isSystemSessionFolder) {
      folderRow.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showFolderContextMenu(ev.clientX, ev.clientY, folder.id);
      });
    }
    list.appendChild(folderRow);

    const members = groupedServers.get(folder.id) || [];
    if (!collapsed) {
      if (isSystemSessionFolder) {
        SESSION_SHORTCUT_FOLDER_DEFS.forEach((sessionFolder) => {
          const sessionFolderCollapsed = isFolderCollapsed(sessionFolder.id);
          const sessionFolderRow = document.createElement('div');
          sessionFolderRow.className = `sb-folder-row sb-folder-drop-target${sessionFolderCollapsed ? ' collapsed' : ''}`;
          sessionFolderRow.dataset.dropKind = 'session';
          sessionFolderRow.dataset.dropSessionFolderId = sessionFolder.id;
          sessionFolderRow.setAttribute('aria-expanded', sessionFolderCollapsed ? 'false' : 'true');
          sessionFolderRow.style.paddingLeft = '20px';
          const sessionFolderItems = groupedSessionShortcuts.get(sessionFolder.id) || [];
          sessionFolderRow.innerHTML = `<span class="sb-folder-caret">${sessionFolderCollapsed ? '&#9656;' : '&#9662;'}</span><span class="sb-folder-icon">${folderIconSvg('folder')}</span><span class="sb-folder-name">${escapeHtml(sessionFolder.name)}</span><span class="sb-folder-count">${sessionFolderItems.length}</span>`;
          sessionFolderRow.addEventListener('click', (ev) => {
            if (Date.now() < sidebarSuppressClickUntilMs) return;
            ev.preventDefault();
            ev.stopPropagation();
            toggleFolderCollapsed(sessionFolder.id);
          });
          list.appendChild(sessionFolderRow);

          if (!sessionFolderCollapsed) {
            sessionFolderItems.forEach((shortcut) => renderSidebarSessionItem(shortcut, list, { indented: true }));
          }
        });
      }
      members.forEach((server) => renderSidebarServerItem(server, list, rail, { indented: true }));
    }
  });

  if (FOLDERS.length) {
    const ungroupedCollapsed = isFolderCollapsed(UNGROUPED_COLLAPSE_ID);
    const ungroupedRow = document.createElement('div');
    ungroupedRow.className = `sb-folder-row sb-folder-row-ghost sb-folder-drop-target${ungroupedCollapsed ? ' collapsed' : ''}`;
    ungroupedRow.dataset.dropKind = 'server';
    ungroupedRow.dataset.dropFolderId = '';
    ungroupedRow.setAttribute('aria-expanded', ungroupedCollapsed ? 'false' : 'true');
    ungroupedRow.innerHTML = `<span class="sb-folder-caret">${ungroupedCollapsed ? '&#9656;' : '&#9662;'}</span><span class="sb-folder-icon">${folderIconSvg('ungrouped')}</span><span class="sb-folder-name">Ungrouped</span><span class="sb-folder-count">${ungroupedServers.length}</span>`;
    ungroupedRow.addEventListener('click', (ev) => {
      if (Date.now() < sidebarSuppressClickUntilMs) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleFolderCollapsed(UNGROUPED_COLLAPSE_ID);
    });
    list.appendChild(ungroupedRow);
  }
  if (ungroupedServers.length && !(FOLDERS.length && isFolderCollapsed(UNGROUPED_COLLAPSE_ID))) {
    ungroupedServers.forEach((server) => renderSidebarServerItem(server, list, rail));
  }
}

/* ══════════════════════════════════════════════════════════
   LEAFLET MAP
══════════════════════════════════════════════════════════ */
const map = L.map('leaflet-map', { center: [20, 10], zoom: 2, minZoom: 1, maxZoom: 10 });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd', maxZoom: 19
}).addTo(map);

const svg = document.getElementById('conn-svg');
let leafletMarkers = {};
let dashMap = null;
let dashLeafletMarkers = {};
let dashMapHasFit = false;
layoutController = createLayoutController({
  map,
  updateMainTerminalLayout,
  getSelectedServerId: () => selId,
});

function createMarkerIcon(s, active) {
  const col = sDot(s.status);
  const ringCol = latencyColor(s.latencyMs, s.status);
  return L.divIcon({
    html: `<div style="width:40px;height:40px;position:relative;display:flex;align-items:center;justify-content:center;">
      <div class="node-ring" style="color:${ringCol};width:22px;height:22px;"></div>
      <div class="node-ring node-ring2" style="color:${ringCol};width:22px;height:22px;"></div>
      <div class="node-marker" style="color:${col};${active ? 'box-shadow:0 0 14px ' + col + '88;border-width:2.5px' : ''}">
        <div class="dot"></div></div>
      <div class="${active ? 'node-label active-label' : 'node-label'}">${s.name}</div>
    </div>`,
    className: '', iconSize: [40, 40], iconAnchor: [20, 20],
  });
}

function renderMapMarkers() {
  // Remove old markers
  Object.values(leafletMarkers).forEach(m => map.removeLayer(m));
  leafletMarkers = {};

  SRV.forEach(s => {
    const coords = getServerMapCoords(s);
    if (!coords) return;
    const m = L.marker([coords.lat, coords.lng], {
      icon: createMarkerIcon(s, s.id === selId),
      zIndexOffset: 100
    }).addTo(map);
    m.on('click', () => selectSrv(s.id));
    m.bindTooltip(
      `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#b8cce0;background:rgba(7,9,13,.95);border:1px solid #1a2840;padding:7px 12px;border-radius:4px"><span style="color:#00bfff;font-weight:700">${s.name}</span> \u00b7 ${s.host}<br><span style="color:#3a5570">${s.loc}</span></div>`,
      { permanent: false, direction: 'top', offset: [0, -18], opacity: 1, className: 'leaflet-tooltip-custom' }
    );
    leafletMarkers[s.id] = m;
  });
  renderDashboardMapMarkers(false);
}

function ensureDashboardMap() {
  if (dashMap) return dashMap;
  const container = document.getElementById('dash-map');
  if (!container) return null;

  dashMap = L.map(container, { center: [20, 10], zoom: 2, minZoom: 1, maxZoom: 10 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(dashMap);

  return dashMap;
}

function renderDashboardMapMarkers(forceFit = false) {
  if (!mainDashboardActive && !dashMap) return;
  const mapInstance = dashMap || ensureDashboardMap();
  if (!mapInstance) return;

  Object.values(dashLeafletMarkers).forEach((marker) => mapInstance.removeLayer(marker));
  dashLeafletMarkers = {};

  const mapServers = SRV
    .map((server) => ({ server, coords: getServerMapCoords(server) }))
    .filter((entry) => Boolean(entry.coords));

  mapServers.forEach(({ server, coords }) => {
    const marker = L.marker([coords.lat, coords.lng], {
      icon: createMarkerIcon(server, server.id === selId),
      zIndexOffset: 100,
    }).addTo(mapInstance);

    marker.on('click', () => selectSrv(server.id, { keepMain: true }));
    marker.bindTooltip(
      `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#b8cce0;background:rgba(7,9,13,.95);border:1px solid #1a2840;padding:7px 12px;border-radius:4px"><span style="color:#00bfff;font-weight:700">${server.name}</span> \u00b7 ${server.host}<br><span style="color:#3a5570">${server.loc}</span></div>`,
      { permanent: false, direction: 'top', offset: [0, -18], opacity: 1, className: 'leaflet-tooltip-custom' },
    );
    dashLeafletMarkers[server.id] = marker;
  });

  if (!mapServers.length) {
    dashMapHasFit = false;
    return;
  }

  if (forceFit || !dashMapHasFit) {
    const bounds = L.latLngBounds(mapServers.map(({ coords }) => [coords.lat, coords.lng]));
    if (bounds.isValid()) {
      mapInstance.fitBounds(bounds.pad(0.2), { animate: false, maxZoom: 4 });
      dashMapHasFit = true;
    }
  }
}

/* ══════════════════════════════════════════════════════════
   TAB STATE
══════════════════════════════════════════════════════════ */
let termTabs = {}, activeTabId = 'metrics', tabCounter = 0;
const sftpBrowserTab = {
  open: false,
  srvId: null,
  tabBtnEl: null,
};
const staticSftpState = {
  path: '.',
  serverId: null,
  loading: false,
  requestSeq: 0,
  colWidths: [280, 72, 88, 160, 100],
  view: 'list',
  pane: 'files',
  entries: [],
  editorPath: '',
  editorOriginal: '',
  editorContent: '',
  editorDirty: false,
  editorLoading: false,
  editorSaving: false,
  editorSize: 0,
  editorModifiedUnix: null,
  editorChmod: '',
  contextPath: '',
};

function refreshSftpBrowserTab() {
  const btn = sftpBrowserTab.tabBtnEl;
  if (!btn) return;
  if (!sftpBrowserTab.open) {
    btn.style.display = 'none';
    btn.classList.remove('active');
    return;
  }

  const srv = SRV.find((s) => s.id === sftpBrowserTab.srvId);
  if (!srv) {
    btn.style.display = 'none';
    btn.classList.remove('active');
    return;
  }

  btn.style.display = '';
  btn.classList.toggle('active', activeTabId === 'sftp');

  const dot = btn.querySelector('.tab-dot');
  const num = btn.querySelector('.tab-num');
  const label = btn.querySelector('.tab-label');
  if (label) label.textContent = 'SFTP';
  if (num) num.textContent = srv.name;
  if (dot) {
    const color = sDot(srv.status);
    dot.style.background = color;
    dot.style.boxShadow = `0 0 5px ${color}`;
  }
}

function closeSftpBrowserTab(e) {
  if (e) e.stopPropagation();
  const wasActive = activeTabId === 'sftp';
  if (sftpBrowserTab.tabBtnEl) {
    sftpBrowserTab.tabBtnEl.remove();
  }
  sftpBrowserTab.open = false;
  sftpBrowserTab.srvId = null;
  sftpBrowserTab.tabBtnEl = null;

  if (wasActive) {
    const vis = Object.entries(termTabs).find(([, t]) => t.mode === 'local' || t.pinned || t.srvId === selId);
    setActiveTab(vis ? vis[0] : 'metrics');
  }
}

function openSftpBrowserTab(serverId) {
  const srv = SRV.find((s) => s.id === serverId);
  if (!srv) return;
  if (serverProtocol(srv) !== 'ssh') {
    showAlert({ title: 'SFTP Unavailable', message: 'SFTP is available only for SSH servers.', variant: 'warning' });
    return;
  }

  if (!sftpBrowserTab.tabBtnEl) {
    const btn = document.createElement('div');
    btn.className = 'tab-term';
    btn.id = 'tabbtn-sftp-browser';
    btn.innerHTML = `
      <div class="tab-term-inner" data-tabid="sftp-browser">
        <div class="tab-dot"></div>
        <span class="tab-label">SFTP</span>
        <span class="tab-num"></span>
      </div>
      <button class="tab-close" data-tabid="sftp-browser">\u00d7</button>`;
    btn.querySelector('.tab-term-inner').addEventListener('click', () => {
      if (sftpBrowserTab.srvId !== null) selectSrv(sftpBrowserTab.srvId);
      setActiveTab('sftp');
    });
    btn.querySelector('.tab-close').addEventListener('click', closeSftpBrowserTab);
    document.getElementById('term-tab-area').insertBefore(btn, document.getElementById('tab-add-btn'));
    sftpBrowserTab.tabBtnEl = btn;
  }

  sftpBrowserTab.open = true;
  sftpBrowserTab.srvId = srv.id;
  refreshSftpBrowserTab();
}

function setActiveTab(id) {
  document.getElementById('tab-metrics-btn').classList.remove('active');
  document.getElementById('tab-sftp-btn').classList.remove('active');
  document.getElementById('metrics-panel').classList.remove('active');
  document.getElementById('sftp-panel').classList.remove('active');
  if (sftpBrowserTab.tabBtnEl) sftpBrowserTab.tabBtnEl.classList.remove('active');
  Object.values(termTabs).forEach(t => {
    t.tabBtnEl.classList.remove('active');
    t.panelEl.classList.remove('active');
  });

  activeTabId = id;

  if (id === 'metrics') {
    document.getElementById('tab-metrics-btn').classList.add('active');
    document.getElementById('metrics-panel').classList.add('active');
    if (selId !== null) {
      renderMetrics(SRV.find(s => s.id === selId));
      if (metricsLiveEnabled && hasLiveSshSessionForServer(selId)) {
        void refreshMetrics(selId);
      }
    } else {
      showMEmpty();
    }
  } else if (id === 'sftp') {
    document.getElementById('tab-sftp-btn').classList.add('active');
    if (sftpBrowserTab.tabBtnEl) sftpBrowserTab.tabBtnEl.classList.add('active');
    document.getElementById('sftp-panel').classList.add('active');
    if (selId !== null) sftpBrowserTab.srvId = selId;
    refreshSftpBrowserTab();
    if (selId !== null) showStaticSftpForServer(); else showStaticSftpEmpty();
  } else {
    const t = termTabs[id];
    if (!t) return;
    t.tabBtnEl.classList.add('active');
    t.panelEl.classList.add('active');
    if (t.terminal) {
      setTimeout(() => { t.fitAddon?.fit(); t.terminal.focus(); }, 50);
    }
  }
  refreshSftpBrowserTab();
}

function refreshTabVisibility() {
  Object.entries(termTabs).forEach(([id, t]) => {
    if (t.mode === 'local') {
      t.tabBtnEl.style.display = '';
      t.tabBtnEl.classList.remove('cross-server');
      const badge = t.tabBtnEl.querySelector('.tab-srv-badge');
      if (badge) badge.style.display = 'none';
      return;
    }

    const visible = t.pinned || t.srvId === selId;
    t.tabBtnEl.style.display = visible ? '' : 'none';
    if (t.pinned && t.srvId !== selId) {
      t.tabBtnEl.classList.add('cross-server');
      const badge = t.tabBtnEl.querySelector('.tab-srv-badge');
      if (badge) badge.style.display = 'inline-flex';
    } else {
      t.tabBtnEl.classList.remove('cross-server');
      const badge = t.tabBtnEl.querySelector('.tab-srv-badge');
      if (badge) badge.style.display = 'none';
    }
  });

  if (activeTabId !== 'metrics' && activeTabId !== 'sftp') {
    const t = termTabs[activeTabId];
    if (!t || (t.mode !== 'local' && !t.pinned && t.srvId !== selId)) {
      const firstVis = Object.entries(termTabs).find(([, tab]) => tab.mode === 'local' || tab.pinned || tab.srvId === selId);
      setActiveTab(firstVis ? firstVis[0] : 'metrics');
    }
  }
}

function refreshAddBtn() {
  const btn = document.getElementById('tab-add-btn');
  if (!btn) return;
  btn.classList.remove('disabled');
  const srv = selId !== null ? SRV.find((s) => s.id === selId) : null;
  const protocolLabel = srv ? String(serverProtocol(srv)).toUpperCase() : 'server';
  btn.dataset.tip = srv
    ? `Left click: New ${protocolLabel} tab. Right click: More options.`
    : 'Right click: Choose terminal type';
  updateTabAddMenuState();
}

function openSelectedServerTerminal() {
  if (selId === null) return false;
  const srv = SRV.find((s) => s.id === selId);
  if (!srv) return false;
  addTermTab({ serverId: srv.id });
  return true;
}

function updateTabAddMenuState() {
  const sshBtn = document.getElementById('tab-add-new-ssh');
  if (!sshBtn) return;
  const srv = selId !== null ? SRV.find((s) => s.id === selId) : null;
  const enabled = Boolean(srv);
  sshBtn.classList.toggle('disabled', !enabled);
  if (!enabled) {
    sshBtn.textContent = 'New Server Connection (Select a server)';
    return;
  }
  const protocolLabel = String(serverProtocol(srv)).toUpperCase();
  sshBtn.textContent = `New ${protocolLabel} Connection (${srv.name})`;
}

function hideTabAddMenu() {
  const menu = document.getElementById('tab-add-menu');
  if (!menu) return;
  menu.style.display = 'none';
}

function showTabAddMenu(position = null) {
  const menu = document.getElementById('tab-add-menu');
  const btn = document.getElementById('tab-add-btn');
  if (!menu || !btn) return;

  updateTabAddMenuState();
  menu.style.display = 'block';
  const menuRect = menu.getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  const rawLeft = position && Number.isFinite(position.x) ? position.x : rect.left;
  const rawTop = position && Number.isFinite(position.y) ? position.y : rect.bottom + 6;
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - menuRect.width - 8));
  const top = Math.max(8, Math.min(rawTop, window.innerHeight - menuRect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function runTabAddMenuAction(action) {
  const value = String(action || '').toLowerCase();
  if (value === 'ssh') {
    if (openSelectedServerTerminal()) hideTabAddMenu();
    return;
  }
  const shell = normalizeLocalShellType(value);
  hideTabAddMenu();
  addLocalTermTab(shell);
}

function toggleTabAddMenu(position = null) {
  const menu = document.getElementById('tab-add-menu');
  if (!menu) return;
  if (menu.style.display === 'none' || !menu.style.display) showTabAddMenu(position);
  else hideTabAddMenu();
}

function refreshSidebarBadges() {
  SRV.forEach(s => {
    const count = Object.values(termTabs).filter(t => t.mode !== 'local' && t.srvId === s.id).length;
    const badge = document.getElementById(`stabs-${s.id}`);
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count === 1 ? '1 tab' : `${count} tabs`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  });
}

function hideServerContextMenu() {
  const menu = document.getElementById('server-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  menu.dataset.serverId = '';
}

function hideFolderContextMenu() {
  const menu = document.getElementById('folder-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  menu.dataset.folderId = '';
}

function hideSessionContextMenu() {
  const menu = document.getElementById('session-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  menu.dataset.shortcutId = '';
}

function showSessionContextMenu(x, y, shortcutId) {
  const menu = document.getElementById('session-context-menu');
  const shortcut = findSessionShortcutById(shortcutId);
  if (!menu || !shortcut) return;

  hideSftpContextMenu();
  hideServerContextMenu();
  hideFolderContextMenu();

  menu.dataset.shortcutId = shortcut.id;
  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="connect_shortcut">Connect</button>',
    '<button class="sftp-menu-item" data-action="edit_shortcut">Edit Config</button>',
    '<button class="sftp-menu-item" data-action="rename_shortcut">Rename</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item danger" data-action="delete_shortcut">Delete</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await runSessionContextAction(btn.dataset.action, shortcut.id);
    });
  });
}

async function buildShortcutUpdateFromModal(existingShortcut) {
  const type = String(document.getElementById('session-type')?.value || existingShortcut?.type || 'local_shell');
  const localShellType = normalizeLocalShellType(document.getElementById('session-local-shell')?.value || 'powershell');
  const vncHost = String(document.getElementById('session-vnc-host')?.value || '').trim();
  const vncPortRaw = String(document.getElementById('session-vnc-port')?.value || '5900').trim();
  const vncPassword = String(document.getElementById('session-vnc-password')?.value || '');
  const externalHost = String(document.getElementById('session-external-host')?.value || '').trim();
  const externalPortRaw = String(document.getElementById('session-external-port')?.value || '').trim();
  const externalUsername = String(document.getElementById('session-external-username')?.value || '').trim();
  const externalPassword = String(document.getElementById('session-external-password')?.value || '');
  const externalSerialPort = String(document.getElementById('session-external-serial-port')?.value || '').trim();
  const externalBaudRaw = String(document.getElementById('session-external-baud')?.value || '115200').trim();

  let payload = {};

  if (type === 'local_shell') {
    payload = { shellType: localShellType };
  } else if (type === 'wsl_shell') {
    payload = {};
  } else if (type === 'vnc') {
    const parsedPort = Number.parseInt(vncPortRaw || '5900', 10);
    if (!vncHost) return { error: 'VNC host is required.' };
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return { error: 'Port must be a valid number between 1 and 65535.' };
    }
    payload = { host: vncHost, port: parsedPort, password: vncPassword };
  } else if (type === 'serial') {
    const baud = Number.parseInt(externalBaudRaw || '115200', 10);
    if (!externalSerialPort) return { error: 'Serial port is required (e.g. COM3).' };
    if (!Number.isInteger(baud) || baud < 50 || baud > 921600) {
      return { error: 'Baud rate must be a valid number between 50 and 921600.' };
    }
    payload = { serialPort: externalSerialPort, baud };
  } else if (isExternalLauncherSession(type)) {
    const port = Number.parseInt(externalPortRaw || '0', 10);
    if (!externalHost) return { error: 'Remote host is required.' };
    if (type !== 'rsh' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return { error: 'Port must be a valid number between 1 and 65535.' };
    }
    payload = {
      host: externalHost,
      port: type === 'rsh' ? null : port,
      username: externalUsername,
      password: externalPassword,
    };
  } else {
    return { error: 'Unsupported session shortcut type.' };
  }

  const previousDefaultName = defaultSessionShortcutName(existingShortcut.type, existingShortcut.payload || {});
  const nextDefaultName = defaultSessionShortcutName(type, payload);
  const previousDefaultFolderId = defaultSessionShortcutFolderId(existingShortcut.type);
  const nextDefaultFolderId = defaultSessionShortcutFolderId(type);
  const currentFolderId = normalizeSessionShortcutFolderId(existingShortcut.folderId, existingShortcut.type);
  const preservedName = existingShortcut.name && existingShortcut.name !== previousDefaultName
    ? existingShortcut.name
    : nextDefaultName;
  const preservedFolderId = currentFolderId === previousDefaultFolderId
    ? nextDefaultFolderId
    : currentFolderId;

  return {
    shortcut: {
      ...existingShortcut,
      type,
      name: preservedName,
      folderId: preservedFolderId,
      payload,
    },
  };
}

async function runSessionContextAction(action, shortcutId) {
  hideSessionContextMenu();
  const shortcut = findSessionShortcutById(shortcutId);
  if (!shortcut) return;

  if (action === 'connect_shortcut') {
    await launchSessionShortcut(shortcut);
    if (window.innerWidth <= 700) toggleSidebar(false);
    return;
  }

  if (action === 'edit_shortcut') {
    openSessionModal(shortcut.type, { shortcut });
    return;
  }

  if (action === 'rename_shortcut') {
    const input = await askInputModal({
      title: 'Rename Session',
      label: 'Session Name',
      value: shortcut.name || sessionShortcutDisplayName(shortcut),
      placeholder: 'Session name',
      submitText: 'Save',
    });
    if (input === null) return;
    const name = String(input || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) return;
    updateSessionShortcut(shortcut.id, (existing) => ({ ...existing, name }));
    return;
  }

  if (action === 'delete_shortcut') {
    const ok = await showDangerConfirm(`Delete saved session "${sessionShortcutDisplayName(shortcut)}"?`);
    if (!ok) return;
    removeSessionShortcut(shortcut.id);
  }
}

function showFolderContextMenu(x, y, folderId) {
  const menu = document.getElementById('folder-context-menu');
  const folder = FOLDERS.find((item) => item.id === folderId);
  if (!menu || !folder || isSessionFolderId(folder.id)) return;

  hideSftpContextMenu();
  hideServerContextMenu();
  hideSessionContextMenu();

  menu.dataset.folderId = folder.id;
  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="edit_folder">Edit Folder</button>',
    '<button class="sftp-menu-item" data-action="rename_folder">Rename Folder</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item danger" data-action="delete_folder">Delete Folder</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await runFolderContextAction(btn.dataset.action, folder.id);
    });
  });
}

async function runFolderContextAction(action, folderId) {
  hideFolderContextMenu();
  const folder = FOLDERS.find((item) => item.id === folderId);
  if (!folder || isSessionFolderId(folder.id)) return;

  if (action === 'edit_folder' || action === 'rename_folder') {
    const label = action === 'rename_folder' ? 'Rename folder' : 'Edit folder name';
    const input = await askInputModal({
      title: label,
      label: 'Folder Name',
      value: folder.name,
      placeholder: 'Folder name',
      submitText: 'Save',
    });
    if (input === null) return;
    const name = normalizeFolderName(input);
    if (!name || name === folder.name) return;
    try {
      await invoke('save_folder', { folder: { id: folder.id, name } });
      await loadServers();
    } catch (error) {
      showError('Folder update failed', error);
    }
    return;
  }

  if (action === 'delete_folder') {
    const first = await showDangerConfirm(`Delete folder "${folder.name}"?`);
    if (!first) return;
    const second = await showDangerConfirm(`Delete folder "${folder.name}" and ungroup its servers?`);
    if (!second) return;
    try {
      await invoke('delete_folder', { folderId: folder.id });
      await loadServers();
    } catch (error) {
      showError('Delete folder failed', error);
    }
  }
}

async function createFolderFromSidebar() {
  const raw = await showInput({ title: 'New Folder', label: 'Folder name', placeholder: 'Enter folder name' });
  if (raw === null || raw === undefined) return;
  const name = normalizeFolderName(raw);
  if (!name) return;
  if (FOLDERS.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
    showAlert({ title: 'Duplicate Name', message: 'Folder name already exists.', variant: 'warning' });
    return;
  }
  try {
    await invoke('save_folder', {
      folder: {
        id: crypto.randomUUID(),
        name,
      },
    });
    await loadServers();
    if (document.getElementById('settings-modal')?.style.display === 'block') {
      renderServerList();
      renderFolderOptions();
    }
  } catch (error) {
    showError('Create folder failed', error);
  }
}

function showServerContextMenu(x, y, serverId) {
  const menu = document.getElementById('server-context-menu');
  const server = SRV.find(s => s.id === serverId);
  if (!menu || !server) return;

  hideSftpContextMenu();
  hideFolderContextMenu();
  hideSessionContextMenu();

  menu.dataset.serverId = server.id;
  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="new_terminal">New Terminal</button>',
    ...(serverProtocol(server) === 'ssh'
      ? ['<button class="sftp-menu-item" data-action="open_sftp">Open SFTP</button>']
      : []),
    ...(serverProtocol(server) === 'ssh'
      ? ['<button class="sftp-menu-item" data-action="connect_as">Connect as</button>']
      : []),
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item" data-action="edit_config">Edit Config</button>',
    ...(serverProtocol(server) === 'ssh'
      ? ['<button class="sftp-menu-item" data-action="clear_known_host">Clear Host Key</button>']
      : []),
    '<button class="sftp-menu-item" data-action="rename">Rename</button>',
    '<button class="sftp-menu-item danger" data-action="delete">Delete</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item" data-action="details">Details</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await runServerContextAction(btn.dataset.action, server.id);
    });
  });
}

async function saveServerModel(server, overrides = {}) {
  if (!server) return;
  const payload = {
    ...(server._raw || {}),
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    protocol: normalizeConnectionProtocol(server.protocol || server?._raw?.protocol),
    icon: normalizeServerIcon(server.icon || server?._raw?.icon),
    location: server.loc,
    lat: server.lat,
    lng: server.lng,
    folder_id: server.folderId || null,
    auth_method: server?._raw?.auth_method || { type: 'Agent' },
    ...overrides,
  };
  await invoke('save_server', { server: payload });
}

async function runServerContextAction(action, serverId) {
  hideServerContextMenu();

  const server = SRV.find(s => s.id === serverId);
  if (!server) return;

  if (action === 'new_terminal') {
    selectSrv(server.id);
    addTermTab({ serverId: server.id });
    return;
  }

  if (action === 'open_sftp') {
    selectSrv(server.id);
    openSftpBrowserTab(server.id);
    setActiveTab('sftp');
    return;
  }

  if (action === 'connect_as') {
    selectSrv(server.id);
    addTermTab({ serverId: server.id, forceUsernamePrompt: true });
    return;
  }

  if (action === 'edit_config') {
    openSettings();
    showServerForm(server);
    return;
  }

  if (action === 'rename') {
    const nextNameRaw = await askInputModal({
      title: 'Rename Server',
      label: 'Server Name',
      value: server.name,
      placeholder: 'Server name',
      submitText: 'Rename',
    });
    if (nextNameRaw === null) return;
    const nextName = nextNameRaw.trim();
    if (!nextName || nextName === server.name) return;
    try {
      await saveServerModel(server, { name: nextName });
      await loadServers();
    } catch (err) {
      showError('Rename failed', err);
    }
    return;
  }

  if (action === 'clear_known_host') {
    const confirmed = await showConfirm({
      title: 'Clear Trusted Host Key',
      message: `Clear trusted host key for "${server.name}" (${server.host}:${server.port})?\n\nThe next connection will trust and store the current host key again.`,
      variant: 'warning',
      confirmText: 'Clear',
    });
    if (!confirmed) return;
    try {
      const removed = await invoke('ssh_clear_known_host', { serverId: server.id });
      showAlert({ title: 'Host Key Cleared', message: `Known host entries cleared: ${Number(removed) || 0}`, variant: 'info' });
    } catch (err) {
      showError('Clear host key failed', err);
    }
    return;
  }

  if (action === 'delete') {
    const firstConfirm = await showDangerConfirm(`Delete server "${server.name}"?`);
    if (!firstConfirm) return;
    const secondConfirm = await showDangerConfirm({
      title: 'Confirm Permanent Deletion',
      message: `Delete "${server.name}" permanently? This cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!secondConfirm) return;
    try {
      await invoke('delete_server', { serverId: server.id });
      await loadServers();
    } catch (err) {
      showError('Delete server failed', err);
    }
    return;
  }

  if (action === 'details') {
    const pingText = typeof server.latencyMs === 'number' ? `${server.latencyMs}ms` : '\u2014';
    showAlert({
      title: 'Server Details',
      message: [
        `Name: ${server.name}`,
        `Host: ${server.host}:${server.port}`,
        `Protocol: ${String(server.protocol || 'ssh').toUpperCase()}`,
        `Username: ${server.username}`,
        `Icon: ${serverIconLabel(server.icon)}`,
        `Folder: ${folderNameById(server.folderId) || '\u2014'}`,
        `Location: ${server.loc || '\u2014'}`,
        `Coordinates: ${server.lat}, ${server.lng}`,
        `Status: ${server.status || 'unknown'}`,
        `Latency: ${pingText}`,
        `Auth: ${server.authLabel || '\u2014'}`,
      ].join('\n'),
      variant: 'info',
    });
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '\u2014';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUnixTimestamp(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts) || ts <= 0) return '\u2014';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '\u2014';
  }
}

function remoteParentPath(path) {
  const p = String(path || '.').trim();
  if (!p || p === '.') return '.';
  if (p === '/') return '/';
  const normalized = p.replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return normalized.slice(0, idx);
}

function remoteBaseName(path) {
  const value = String(path || '').replace(/\/+$/, '');
  if (!value || value === '/') return '';
  const idx = value.lastIndexOf('/');
  if (idx < 0) return value;
  return value.slice(idx + 1);
}

function remoteJoinPath(base, childName) {
  const name = String(childName || '').trim().replace(/[\\/]/g, '');
  if (!name) return String(base || '.').trim() || '.';
  const root = String(base || '.').trim() || '.';
  if (root === '/') return `/${name}`;
  if (root === '.') return name;
  return `${root.replace(/\/+$/, '')}/${name}`;
}

function selectedSftpServer() {
  if (selId === null) throw new Error('Select a node first');
  const srv = SRV.find(s => s.id === selId);
  if (!srv) throw new Error('Selected server no longer exists');
  if (serverProtocol(srv) !== 'ssh') throw new Error('SFTP is only available for SSH servers.');
  return srv;
}

const sftpCredentialCache = new Map();

function cacheSftpCredentials(serverId, username, password = null) {
  if (!serverId) return;
  const existing = sftpCredentialCache.get(serverId) || {};
  const next = { ...existing };
  if (typeof username === 'string' && username.trim()) next.username = username.trim();
  if (typeof password === 'string') next.password = password;
  sftpCredentialCache.set(serverId, next);
}

function resolveSftpAuthOverrides(server) {
  if (serverProtocol(server) === 'telnet') {
    throw new Error('SFTP is available only for SSH servers.');
  }

  const cached = sftpCredentialCache.get(server.id) || {};
  const configuredUsername = String(server.username || '').trim();
  const username = String(cached.username || configuredUsername).trim();
  if (!username) {
    throw new Error('Missing SFTP username. Open a terminal and connect once, or set username in Server Config.');
  }

  const overrides = {};
  if (username !== configuredUsername) overrides.usernameOverride = username;

  const authType = server?._raw?.auth_method?.type;
  if (authType === 'Password') {
    const configuredPassword = String(server?._raw?.auth_method?.password ?? '');
    const cachedPassword = typeof cached.password === 'string' ? cached.password : null;
    if (!configuredPassword) {
      if (cachedPassword === null) {
        throw new Error('Missing SFTP password. Open a terminal and connect once, or save password in Server Config.');
      }
      overrides.passwordOverride = cachedPassword;
    }
  }

  return overrides;
}

async function invokeSftp(command, server, payload = {}) {
  const overrides = resolveSftpAuthOverrides(server);
  return invoke(command, {
    serverId: server.id,
    ...payload,
    ...overrides,
  });
}

function setSftpControlsDisabled(disabled) {
  const refreshEl = document.getElementById('sftp-refresh-btn');
  const goEl = document.getElementById('sftp-go-btn');
  const upEl = document.getElementById('sftp-up-btn');
  const uploadEl = document.getElementById('sftp-upload-btn');
  const newFileEl = document.getElementById('sftp-new-file-btn');
  const listViewEl = document.getElementById('sftp-view-list-btn');
  const gridViewEl = document.getElementById('sftp-view-grid-btn');
  const filesPaneEl = document.getElementById('sftp-pane-files-btn');
  const editorPaneEl = document.getElementById('sftp-pane-editor-btn');
  if (refreshEl) refreshEl.disabled = disabled;
  if (goEl) goEl.disabled = disabled;
  if (upEl) upEl.disabled = disabled;
  if (uploadEl) uploadEl.disabled = disabled;
  if (newFileEl) newFileEl.disabled = disabled;
  if (listViewEl) listViewEl.disabled = disabled;
  if (gridViewEl) gridViewEl.disabled = disabled;
  if (filesPaneEl) filesPaneEl.disabled = disabled;
  if (editorPaneEl && staticSftpState.editorPath) editorPaneEl.disabled = disabled;
}

function setStaticSftpStatus(message, isError = false) {
  const statusEl = document.getElementById('sftp-status-static');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateSftpViewButtons() {
  const listViewEl = document.getElementById('sftp-view-list-btn');
  const gridViewEl = document.getElementById('sftp-view-grid-btn');
  if (listViewEl) listViewEl.classList.toggle('active', staticSftpState.view === 'list');
  if (gridViewEl) gridViewEl.classList.toggle('active', staticSftpState.view === 'grid');
}

function setSftpViewMode(mode) {
  const next = mode === 'grid' ? 'grid' : 'list';
  if (staticSftpState.view === next) return;
  staticSftpState.view = next;
  updateSftpViewButtons();
  renderStaticSftpRows(staticSftpState.entries || []);
}

function resetSftpEditorState() {
  staticSftpState.pane = 'files';
  staticSftpState.editorPath = '';
  staticSftpState.editorOriginal = '';
  staticSftpState.editorContent = '';
  staticSftpState.editorDirty = false;
  staticSftpState.editorLoading = false;
  staticSftpState.editorSaving = false;
  staticSftpState.editorSize = 0;
  staticSftpState.editorModifiedUnix = null;
  staticSftpState.editorChmod = '';
}

async function confirmDiscardSftpEditorChanges() {
  if (!staticSftpState.editorDirty) return true;
  return await showConfirm({
    title: 'Unsaved Changes',
    message: 'You have unsaved changes in the editor. Discard them?',
    variant: 'warning',
    confirmText: 'Discard',
    cancelText: 'Keep Editing',
  });
}

function updateSftpPaneButtons() {
  const filesBtn = document.getElementById('sftp-pane-files-btn');
  const editorBtn = document.getElementById('sftp-pane-editor-btn');
  const isFiles = staticSftpState.pane !== 'editor';
  if (filesBtn) filesBtn.classList.toggle('active', isFiles);
  if (editorBtn) {
    editorBtn.classList.toggle('active', !isFiles);
    editorBtn.disabled = !staticSftpState.editorPath;
  }
}

function renderSftpEditorPanel() {
  const tableWrapEl = document.getElementById('sftp-table-wrap-static');
  const navEl = document.getElementById('sftp-nav');
  const viewToggleEl = document.querySelector('.sftp-view-toggle');
  const uploadBtn = document.getElementById('sftp-upload-btn');
  const newFileBtn = document.getElementById('sftp-new-file-btn');
  const refreshBtn = document.getElementById('sftp-refresh-btn');
  const editorWrapEl = document.getElementById('sftp-editor-wrap');
  const editorFileEl = document.getElementById('sftp-editor-file');
  const editorMetaEl = document.getElementById('sftp-editor-meta');
  const editorDirtyEl = document.getElementById('sftp-editor-dirty');
  const editorTextEl = document.getElementById('sftp-editor-text');
  const editorSaveEl = document.getElementById('sftp-editor-save-btn');
  if (!tableWrapEl || !editorWrapEl || !editorTextEl || !editorSaveEl) return;

  const inEditor = staticSftpState.pane === 'editor';
  tableWrapEl.style.display = inEditor ? 'none' : 'flex';
  editorWrapEl.style.display = inEditor ? 'flex' : 'none';
  if (navEl) navEl.style.display = inEditor ? 'none' : 'grid';
  if (viewToggleEl) viewToggleEl.style.display = inEditor ? 'none' : 'flex';
  if (uploadBtn) uploadBtn.style.display = inEditor ? 'none' : '';
  if (newFileBtn) newFileBtn.style.display = inEditor ? 'none' : '';
  if (refreshBtn) refreshBtn.style.display = inEditor ? 'none' : '';

  const modified = formatUnixTimestamp(staticSftpState.editorModifiedUnix);
  if (editorFileEl) editorFileEl.textContent = staticSftpState.editorPath || 'No file selected';
  if (editorMetaEl) {
    editorMetaEl.textContent = staticSftpState.editorPath
      ? `${formatBytes(staticSftpState.editorSize)} | Modified ${modified} | ${staticSftpState.editorChmod || 'mode unavailable'} | UTF-8 text`
      : '';
  }
  if (editorDirtyEl) editorDirtyEl.style.display = staticSftpState.editorDirty ? 'inline' : 'none';
  if (editorTextEl.value !== staticSftpState.editorContent) editorTextEl.value = staticSftpState.editorContent || '';
  editorTextEl.disabled = staticSftpState.editorLoading || staticSftpState.editorSaving || !staticSftpState.editorPath;
  editorSaveEl.disabled = staticSftpState.editorLoading || staticSftpState.editorSaving || !staticSftpState.editorDirty;
}

async function setSftpPane(mode, allowPrompt = true) {
  const next = mode === 'editor' ? 'editor' : 'files';
  if (next === staticSftpState.pane) return true;
  if (next === 'files' && allowPrompt) {
    const canDiscard = await confirmDiscardSftpEditorChanges();
    if (!canDiscard) return false;
  }
  if (next === 'editor' && !staticSftpState.editorPath) return false;
  staticSftpState.pane = next;
  updateSftpPaneButtons();
  renderSftpEditorPanel();
  return true;
}

async function openSftpEditorFile(entry) {
  if (!entry || entry.is_dir) return;
  const targetPath = String(entry.path || '').trim();
  if (!targetPath) return;
  if (staticSftpState.editorPath && staticSftpState.editorPath !== targetPath) {
    const canDiscard = await confirmDiscardSftpEditorChanges();
    if (!canDiscard) return;
  }

  const srv = selectedSftpServer();
  staticSftpState.editorLoading = true;
  staticSftpState.editorSaving = false;
  staticSftpState.editorPath = targetPath;
  staticSftpState.editorDirty = false;
  staticSftpState.editorContent = '';
  staticSftpState.editorOriginal = '';
  await setSftpPane('editor', false);
  setStaticSftpStatus(`Loading file ${remoteBaseName(targetPath) || targetPath} ...`);
  updateSftpPaneButtons();
  renderSftpEditorPanel();

  try {
    const result = await invokeSftp('sftp_read_file', srv, { path: targetPath });
    staticSftpState.editorPath = result?.path || targetPath;
    staticSftpState.editorContent = String(result?.content || '');
    staticSftpState.editorOriginal = staticSftpState.editorContent;
    staticSftpState.editorSize = Number(result?.size || 0);
    staticSftpState.editorModifiedUnix = Number(result?.modified_unix || 0) || null;
    staticSftpState.editorChmod = String(result?.chmod || '');
    staticSftpState.editorDirty = false;
    setStaticSftpStatus(`Editor opened: ${remoteBaseName(staticSftpState.editorPath) || staticSftpState.editorPath}`);
  } catch (err) {
    setStaticSftpStatus(`Open failed: ${String(err)}`, true);
    resetSftpEditorState();
  } finally {
    staticSftpState.editorLoading = false;
    updateSftpPaneButtons();
    renderSftpEditorPanel();
  }
}

async function saveSftpEditorFile() {
  if (!staticSftpState.editorPath || !staticSftpState.editorDirty) return;
  const srv = selectedSftpServer();
  const editorTextEl = document.getElementById('sftp-editor-text');
  if (!editorTextEl) return;
  const content = editorTextEl.value ?? '';

  staticSftpState.editorSaving = true;
  renderSftpEditorPanel();
  setStaticSftpStatus(`Saving ${remoteBaseName(staticSftpState.editorPath) || staticSftpState.editorPath} ...`);
  try {
    const result = await invokeSftp('sftp_write_file', srv, {
      path: staticSftpState.editorPath,
      content,
    });
    staticSftpState.editorContent = content;
    staticSftpState.editorOriginal = content;
    staticSftpState.editorDirty = false;
    staticSftpState.editorSize = Number(result?.size || content.length);
    staticSftpState.editorModifiedUnix = Number(result?.modified_unix || 0) || staticSftpState.editorModifiedUnix;
    staticSftpState.editorChmod = String(result?.chmod || staticSftpState.editorChmod || '');
    setStaticSftpStatus(`Saved ${remoteBaseName(staticSftpState.editorPath) || staticSftpState.editorPath}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
    await setSftpPane('editor', false);
  } catch (err) {
    setStaticSftpStatus(`Save failed: ${String(err)}`, true);
  } finally {
    staticSftpState.editorSaving = false;
    updateSftpPaneButtons();
    renderSftpEditorPanel();
  }
}

async function closeSftpEditor() {
  const closed = await setSftpPane('files', true);
  if (!closed) return;
  resetSftpEditorState();
  updateSftpPaneButtons();
  renderSftpEditorPanel();
}

function hideSftpContextMenu() {
  const menu = document.getElementById('sftp-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  staticSftpState.contextPath = '';
}

function showSftpContextMenu(x, y, entry) {
  const menu = document.getElementById('sftp-context-menu');
  if (!menu || !entry) return;
  hideServerContextMenu();
  hideFolderContextMenu();
  staticSftpState.contextPath = entry.path || '';

  const items = [];
  if (entry.is_dir) {
    items.push({ action: 'open', label: 'Open Folder' });
    items.push({ action: 'upload_here', label: 'Upload File Here' });
    items.push({ action: 'upload_dir_here', label: 'Upload Folder Here' });
    items.push({ action: 'download_dir', label: 'Download Folder' });
    items.push({ action: 'new_folder', label: 'New Folder Here' });
    items.push({ separator: true });
  } else {
    items.push({ action: 'edit', label: 'Edit File' });
    items.push({ action: 'download', label: 'Download File' });
    items.push({ separator: true });
  }
  items.push({ action: 'rename', label: 'Rename' });
  items.push({ action: 'copy_path', label: 'Copy Path' });
  items.push({ action: 'chmod', label: 'Permissions (Chmod)' });
  items.push({ action: 'symlink', label: 'Create Symlink' });
  items.push({ separator: true });
  items.push({
    action: 'delete',
    label: entry.is_dir ? 'Delete Folder' : 'Delete File',
    danger: true,
  });

  menu.innerHTML = items.map((item) => {
    if (item.separator) return '<div class="sftp-menu-sep"></div>';
    return `<button class="sftp-menu-item ${item.danger ? 'danger' : ''}" data-action="${item.action}">${item.label}</button>`;
  }).join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      await runSftpContextAction(btn.dataset.action, entry);
    });
  });
}

function showSftpWorkspaceContextMenu(x, y, directoryPath) {
  const menu = document.getElementById('sftp-context-menu');
  if (!menu) return;
  hideServerContextMenu();
  const targetDir = String(directoryPath || staticSftpState.path || '.').trim() || '.';
  staticSftpState.contextPath = targetDir;

  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="upload_here_workspace">Upload File Here</button>',
    '<button class="sftp-menu-item" data-action="upload_dir_workspace">Upload Folder Here</button>',
    '<button class="sftp-menu-item" data-action="new_file_workspace">New File Here</button>',
    '<button class="sftp-menu-item" data-action="new_folder_workspace">New Folder Here</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item" data-action="refresh_workspace">Refresh</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const action = btn.dataset.action;
      hideSftpContextMenu();
      if (action === 'upload_here_workspace') {
        await uploadFileToRemoteDir(targetDir);
      } else if (action === 'upload_dir_workspace') {
        await uploadDirToRemoteDir(targetDir);
      } else if (action === 'new_file_workspace') {
        await createSftpFile(targetDir);
      } else if (action === 'new_folder_workspace') {
        await createSftpFolder(targetDir);
      } else if (action === 'refresh_workspace') {
        await loadStaticSftpDir(targetDir);
      }
    });
  });
}

async function uploadFileToRemoteDir(targetDir) {
  const srv = selectedSftpServer();
  const baseDir = String(targetDir || staticSftpState.path || '.').trim() || '.';
  const picked = await open({
    title: 'Select file to upload',
    directory: false,
    multiple: false,
  });
  if (!picked) return;

  const localPath = Array.isArray(picked) ? picked[0] : picked;
  if (!localPath) return;

  const filename = String(localPath).split(/[\\/]/).pop() || 'upload.bin';
  const remotePath = remoteJoinPath(baseDir, filename);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Uploading ${filename} ...`);
  try {
    await invokeSftp('sftp_upload_file', srv, {
      localPath: String(localPath),
      remotePath,
    });
    setStaticSftpStatus(`Uploaded ${filename} to ${baseDir}`);
    await loadStaticSftpDir(baseDir);
  } catch (err) {
    setStaticSftpStatus(`Upload failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function downloadSftpEntry(entry) {
  if (!entry || entry.is_dir) return;
  const srv = selectedSftpServer();
  const remotePath = String(entry.path || '').trim();
  if (!remotePath) return;
  const fileName = remoteBaseName(remotePath) || 'download.bin';
  const chosen = await saveDialog({
    title: 'Save downloaded file',
    defaultPath: fileName,
  });
  if (!chosen) return;

  const localPath = Array.isArray(chosen) ? chosen[0] : chosen;
  if (!localPath) return;

  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Downloading ${fileName} ...`);
  try {
    await invokeSftp('sftp_download_file', srv, {
      remotePath,
      localPath: String(localPath),
    });
    setStaticSftpStatus(`Downloaded ${fileName}`);
  } catch (err) {
    setStaticSftpStatus(`Download failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function uploadDirToRemoteDir(targetDir) {
  const srv = selectedSftpServer();
  const baseDir = String(targetDir || staticSftpState.path || '.').trim() || '.';
  const picked = await open({
    title: 'Select folder to upload',
    directory: true,
    multiple: false,
  });
  if (!picked) return;

  const localPath = Array.isArray(picked) ? picked[0] : picked;
  if (!localPath) return;

  const dirname = String(localPath).split(/[\\/]/).pop() || 'upload_dir';
  const remotePath = remoteJoinPath(baseDir, dirname);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Uploading folder ${dirname} ...`);
  try {
    await invokeSftp('sftp_upload_dir', srv, {
      localDir: String(localPath),
      remoteDir: remotePath,
    });
    setStaticSftpStatus(`Uploaded folder ${dirname} to ${baseDir}`);
    await loadStaticSftpDir(baseDir);
  } catch (err) {
    setStaticSftpStatus(`Upload folder failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function downloadSftpDir(entry) {
  if (!entry || !entry.is_dir) return;
  const srv = selectedSftpServer();
  const remotePath = String(entry.path || '').trim();
  if (!remotePath) return;
  const dirName = remoteBaseName(remotePath) || 'download_dir';

  const chosen = await open({
    title: 'Select local folder to download to',
    directory: true,
    multiple: false,
  });
  if (!chosen) return;

  const localParent = Array.isArray(chosen) ? chosen[0] : chosen;
  if (!localParent) return;

  const separator = localParent.includes('/') ? '/' : '\\';
  const localPath = localParent.endsWith(separator)
    ? `${localParent}${dirName}`
    : `${localParent}${separator}${dirName}`;

  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Downloading folder ${dirName} ...`);
  try {
    await invokeSftp('sftp_download_dir', srv, {
      remoteDir: remotePath,
      localDir: localPath,
    });
    setStaticSftpStatus(`Downloaded folder ${dirName} to ${localPath}`);
  } catch (err) {
    setStaticSftpStatus(`Download folder failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function renameSftpEntry(entry) {
  const oldPath = String(entry.path || '').trim();
  if (!oldPath) return;
  const oldName = remoteBaseName(oldPath);
  const nextNameRaw = await askInputModal({
    title: 'Rename Entry',
    label: 'New Name',
    value: oldName,
    placeholder: oldName || 'new-name',
    submitText: 'Rename',
  });
  if (nextNameRaw === null) return;
  const nextName = nextNameRaw.trim().replace(/[\\/]/g, '');
  if (!nextName || nextName === oldName) return;

  const srv = selectedSftpServer();
  const newPath = remoteJoinPath(remoteParentPath(oldPath), nextName);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Renaming ${oldName} ...`);
  try {
    await invokeSftp('sftp_rename_entry', srv, {
      oldPath,
      newPath,
    });
    setStaticSftpStatus(`Renamed to ${nextName}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
  } catch (err) {
    setStaticSftpStatus(`Rename failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function deleteSftpEntry(entry) {
  const path = String(entry.path || '').trim();
  if (!path) return;
  const label = remoteBaseName(path) || path;
  const confirmed = await showDangerConfirm(`Delete ${entry.is_dir ? 'folder' : 'file'} "${label}"?`);
  if (!confirmed) return;

  const srv = selectedSftpServer();
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Deleting ${label} ...`);
  try {
    await invokeSftp('sftp_delete_entry', srv, {
      path,
      isDir: Boolean(entry.is_dir),
    });
    setStaticSftpStatus(`Deleted ${label}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
  } catch (err) {
    setStaticSftpStatus(`Delete failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function chmodSftpEntry(entry) {
  const path = String(entry.path || '').trim();
  if (!path) return;
  const label = remoteBaseName(path) || path;

  const chmodRaw = await askInputModal({
    title: 'Set Permissions (Chmod)',
    label: 'Octal Mode (e.g. 755)',
    value: '755',
    placeholder: 'e.g. 755',
    submitText: 'Apply',
  });
  if (chmodRaw === null) return;
  const trimmed = chmodRaw.trim();
  const octalValue = parseInt(trimmed, 8);
  if (isNaN(octalValue) || octalValue < 0 || octalValue > 0o777) {
    showAlert({
      title: 'Invalid Input',
      message: 'Please enter a valid 3-digit octal value between 000 and 777.',
      variant: 'error',
    });
    return;
  }

  const srv = selectedSftpServer();
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Chmod ${trimmed} for ${label} ...`);
  try {
    await invokeSftp('sftp_set_permissions', srv, {
      path,
      chmodOctal: octalValue,
    });
    setStaticSftpStatus(`Set permissions of ${label} to ${trimmed}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
  } catch (err) {
    setStaticSftpStatus(`Chmod failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function symlinkSftpEntry(entry) {
  const path = String(entry.path || '').trim();
  if (!path) return;
  const label = remoteBaseName(path) || path;

  const targetRaw = await askInputModal({
    title: 'Create Symlink',
    label: `Target file/folder that "${label}" points to:`,
    value: '',
    placeholder: '/path/to/target',
    submitText: 'Create',
  });
  if (targetRaw === null) return;
  const target = targetRaw.trim();
  if (!target) return;

  const srv = selectedSftpServer();
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Creating symlink from ${label} to ${target} ...`);
  try {
    await invokeSftp('sftp_create_symlink', srv, {
      target,
      path,
    });
    setStaticSftpStatus(`Symlink created successfully`);
    await loadStaticSftpDir(staticSftpState.path || '.');
  } catch (err) {
    setStaticSftpStatus(`Symlink creation failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function createSftpFolder(parentDir) {
  const folderNameRaw = await showInput({ title: 'New Folder', label: 'Folder name', placeholder: 'Enter folder name' });
  if (folderNameRaw === null || folderNameRaw === undefined) return;
  const folderName = folderNameRaw.trim().replace(/[\\/]/g, '');
  if (!folderName) return;

  const srv = selectedSftpServer();
  const parent = String(parentDir || staticSftpState.path || '.').trim() || '.';
  const path = remoteJoinPath(parent, folderName);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Creating folder ${folderName} ...`);
  try {
    await invokeSftp('sftp_create_dir', srv, {
      path,
    });
    setStaticSftpStatus(`Created folder ${folderName}`);
    await loadStaticSftpDir(parent);
  } catch (err) {
    setStaticSftpStatus(`Create folder failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function createSftpFile(parentDir) {
  const fileNameRaw = await showInput({ title: 'New File', label: 'File name', defaultValue: 'new-file.txt', placeholder: 'Enter file name' });
  if (fileNameRaw === null || fileNameRaw === undefined) return;
  const fileName = fileNameRaw.trim().replace(/[\\/]/g, '');
  if (!fileName) return;

  const srv = selectedSftpServer();
  const parent = String(parentDir || staticSftpState.path || '.').trim() || '.';
  const path = remoteJoinPath(parent, fileName);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Creating file ${fileName} ...`);
  try {
    await invokeSftp('sftp_write_file', srv, {
      path,
      content: '',
    });
    setStaticSftpStatus(`Created file ${fileName}`);
    await loadStaticSftpDir(parent);
  } catch (err) {
    setStaticSftpStatus(`Create file failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function runSftpContextAction(action, entry) {
  hideSftpContextMenu();
  if (!entry || !action) return;
  if (action === 'open') {
    if (entry.is_dir) await loadStaticSftpDir(entry.path);
    return;
  }
  if (action === 'upload_here') {
    if (entry.is_dir) await uploadFileToRemoteDir(entry.path);
    return;
  }
  if (action === 'upload_dir_here') {
    if (entry.is_dir) await uploadDirToRemoteDir(entry.path);
    return;
  }
  if (action === 'download_dir') {
    if (entry.is_dir) await downloadSftpDir(entry);
    return;
  }
  if (action === 'new_folder') {
    if (entry.is_dir) await createSftpFolder(entry.path);
    return;
  }
  if (action === 'edit') {
    await openSftpEditorFile(entry);
    return;
  }
  if (action === 'download') {
    await downloadSftpEntry(entry);
    return;
  }
  if (action === 'rename') {
    await renameSftpEntry(entry);
    return;
  }
  if (action === 'copy_path') {
    try {
      await navigator.clipboard.writeText(String(entry.path || ''));
      setStaticSftpStatus(`Copied path: ${entry.path}`);
    } catch {
      setStaticSftpStatus('Copy path failed', true);
    }
    return;
  }
  if (action === 'delete') {
    await deleteSftpEntry(entry);
    return;
  }
  if (action === 'chmod') {
    await chmodSftpEntry(entry);
    return;
  }
  if (action === 'symlink') {
    await symlinkSftpEntry(entry);
    return;
  }
}

const SFTP_MIN_COL_WIDTHS = [180, 60, 70, 120, 88];
function staticSftpColumnTemplate() {
  return staticSftpState.colWidths.map((w) => `${Math.round(w)}px`).join(' ');
}

function applyStaticSftpColumnTemplate() {
  const wrap = document.getElementById('sftp-table-wrap-static');
  if (!wrap) return;
  wrap.style.setProperty('--sftp-cols', staticSftpColumnTemplate());
}

function initStaticSftpColumnResizers() {
  const header = document.getElementById('sftp-header-static');
  if (!header) return;
  applyStaticSftpColumnTemplate();
  header.querySelectorAll('.sftp-col-resizer').forEach((resizer) => {
    resizer.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const colIndex = Number(resizer.dataset.col);
      if (!Number.isInteger(colIndex) || colIndex < 0 || colIndex >= staticSftpState.colWidths.length) return;
      const startX = ev.clientX;
      const startWidth = staticSftpState.colWidths[colIndex];
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEv) => {
        const next = Math.max(SFTP_MIN_COL_WIDTHS[colIndex], startWidth + (moveEv.clientX - startX));
        staticSftpState.colWidths[colIndex] = next;
        applyStaticSftpColumnTemplate();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

function showStaticSftpEmpty(message = 'Select a node to browse files') {
  hideSftpContextMenu();
  resetSftpEditorState();
  updateSftpPaneButtons();
  const emptyEl = document.getElementById('sftp-empty');
  const shellEl = document.getElementById('sftp-shell');
  if (emptyEl) {
    emptyEl.textContent = message;
    emptyEl.style.display = 'block';
  }
  if (shellEl) shellEl.style.display = 'none';
}

function showStaticSftpForServer() {
  const selected = SRV.find((s) => s.id === selId);
  if (!selected || serverProtocol(selected) !== 'ssh') {
    showStaticSftpEmpty('SFTP is only available for SSH servers.');
    return;
  }

  hideSftpContextMenu();
  const emptyEl = document.getElementById('sftp-empty');
  const shellEl = document.getElementById('sftp-shell');
  if (emptyEl) emptyEl.style.display = 'none';
  if (shellEl) shellEl.style.display = 'flex';
  if (staticSftpState.serverId !== selId) {
    staticSftpState.serverId = selId;
    staticSftpState.path = '.';
    resetSftpEditorState();
  }
  const input = document.getElementById('sftp-path-input');
  if (input && !input.value.trim()) input.value = staticSftpState.path || '.';
  updateSftpPaneButtons();
  renderSftpEditorPanel();
  void loadStaticSftpDir(staticSftpState.path || '.');
}

function renderStaticSftpRows(entries) {
  const listEl = document.getElementById('sftp-list-static');
  const wrapEl = document.getElementById('sftp-table-wrap-static');
  const headerEl = document.getElementById('sftp-header-static');
  if (!listEl || !wrapEl || !headerEl) return;

  listEl.oncontextmenu = (ev) => {
    if (ev.target?.closest?.('.sftp-row')) return;
    ev.preventDefault();
    ev.stopPropagation();
    showSftpWorkspaceContextMenu(ev.clientX, ev.clientY, staticSftpState.path || '.');
  };

  staticSftpState.entries = Array.isArray(entries) ? entries : [];
  updateSftpViewButtons();

  if (staticSftpState.view === 'grid') {
    wrapEl.classList.add('grid-mode');
    listEl.classList.add('grid-mode');
  } else {
    wrapEl.classList.remove('grid-mode');
    listEl.classList.remove('grid-mode');
  }

  if (staticSftpState.entries.length === 0) {
    listEl.innerHTML = `<div class="sftp-empty">No files found</div>`;
    return;
  }

  const pathToEntry = new Map();
  if (staticSftpState.view === 'grid') {
    listEl.innerHTML = staticSftpState.entries.map((entry) => {
      pathToEntry.set(String(entry.path || ''), entry);
      const name = escapeHtml(entry.name || '');
      const type = entry.is_dir ? 'DIR' : entry.is_symlink ? 'LINK' : 'FILE';
      const size = entry.is_dir ? '\u2014' : formatBytes(entry.size);
      const created = formatUnixTimestamp(entry.created_unix || entry.modified_unix);
      const chmod = escapeHtml(entry.chmod || '\u2014');
      const path = escapeHtml(entry.path || '');
      const icon = sftpEntryIconMarkup(entry);
      return `<div class="sftp-row sftp-card ${entry.is_dir ? 'is-dir' : ''}" data-path="${path}" data-dir="${entry.is_dir ? '1' : '0'}">
        <div class="sftp-card-head">
          <div class="sftp-card-name">${icon}<span class="sftp-name-text">${name}</span></div>
          <div class="sftp-card-type">${type}</div>
        </div>
        <div class="sftp-card-meta">
          <span>Size ${size}</span>
          <span>${chmod}</span>
        </div>
        <div class="sftp-card-created">${escapeHtml(created)}</div>
      </div>`;
    }).join('');
  } else {
    listEl.innerHTML = staticSftpState.entries.map((entry) => {
      pathToEntry.set(String(entry.path || ''), entry);
      const name = escapeHtml(entry.name || '');
      const type = entry.is_dir ? 'DIR' : entry.is_symlink ? 'LINK' : 'FILE';
      const size = entry.is_dir ? '\u2014' : formatBytes(entry.size);
      const created = formatUnixTimestamp(entry.created_unix || entry.modified_unix);
      const chmod = escapeHtml(entry.chmod || '\u2014');
      const path = escapeHtml(entry.path || '');
      const icon = sftpEntryIconMarkup(entry);
      return `<div class="sftp-row sftp-grid-row ${entry.is_dir ? 'is-dir' : ''}" data-path="${path}" data-dir="${entry.is_dir ? '1' : '0'}">
        <div class="sftp-cell sftp-name"><span class="sftp-entry-main">${icon}<span class="sftp-name-text">${name}</span></span></div>
        <div class="sftp-cell sftp-type">${type}</div>
        <div class="sftp-cell sftp-size">${size}</div>
        <div class="sftp-cell sftp-created">${escapeHtml(created)}</div>
        <div class="sftp-cell sftp-chmod">${chmod}</div>
      </div>`;
    }).join('');
  }

  listEl.querySelectorAll('.sftp-row').forEach((row) => {
    const path = row.dataset.path || '';
    const entry = pathToEntry.get(path);
    if (!entry) return;
    if (entry.is_dir) {
      row.addEventListener('dblclick', () => {
        if (entry.path) loadStaticSftpDir(entry.path);
      });
    }
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showSftpContextMenu(ev.clientX, ev.clientY, entry);
    });
  });
}

async function loadStaticSftpDir(targetPath) {
  hideSftpContextMenu();
  if (selId === null) {
    showStaticSftpEmpty();
    return;
  }

  const srv = SRV.find(s => s.id === selId);
  if (!srv) {
    showStaticSftpEmpty('Selected server no longer exists');
    return;
  }

  const statusEl = document.getElementById('sftp-status-static');
  const pathEl = document.getElementById('sftp-path-input');
  if (!statusEl || !pathEl) return;

  const path = (targetPath ?? pathEl.value ?? staticSftpState.path ?? '.').trim() || '.';
  staticSftpState.path = path;
  const requestId = ++staticSftpState.requestSeq;
  staticSftpState.loading = true;

  setStaticSftpStatus(`Loading ${path} ...`);
  setSftpControlsDisabled(true);

  try {
    const result = await invokeSftp('sftp_list_dir', srv, { path });
    if (requestId !== staticSftpState.requestSeq) return;
    staticSftpState.path = result?.path || path;
    pathEl.value = staticSftpState.path;
    renderStaticSftpRows(result?.entries || []);
    setStaticSftpStatus(`${(result?.entries || []).length} item(s) in ${staticSftpState.path}`);
  } catch (err) {
    if (requestId !== staticSftpState.requestSeq) return;
    setStaticSftpStatus(`SFTP failed: ${String(err)}`, true);
    renderStaticSftpRows([]);
  } finally {
    if (requestId !== staticSftpState.requestSeq) return;
    staticSftpState.loading = false;
    setSftpControlsDisabled(false);
    updateSftpPaneButtons();
    renderSftpEditorPanel();
  }
}

/* ══════════════════════════════════════════════════════════
   SELECT SERVER
══════════════════════════════════════════════════════════ */
function selectSrv(id, options = {}) {
  const keepMain = Boolean(options.keepMain);
  if (id !== null && mainDashboardActive && !keepMain) setMainDashboardActive(false);
  selId = id;
  document.querySelectorAll('.snode').forEach(n => n.classList.remove('active'));
  if (id !== null) document.getElementById(`sn-${id}`)?.classList.add('active');
  SRV.forEach(s => {
    if (leafletMarkers[s.id]) leafletMarkers[s.id].setIcon(createMarkerIcon(s, s.id === id));
    if (dashLeafletMarkers[s.id]) dashLeafletMarkers[s.id].setIcon(createMarkerIcon(s, s.id === id));
  });
  renderMainServerList();
  refreshAddBtn();
  refreshTabVisibility();
  refreshRailActive();
  if (id !== null) {
    const srv = SRV.find(s => s.id === id);
    if (srv) {
      if (activeTabId === 'sftp') {
        sftpBrowserTab.srvId = id;
        refreshSftpBrowserTab();
      }
      const coords = getServerMapCoords(srv);
      if (coords) {
        if (mainDashboardActive && dashMap) safeMapFlyTo(dashMap, coords);
        else safeMapFlyTo(map, coords);
      }
      if (activeTabId === 'metrics') {
        renderMetrics(srv);
        if (metricsLiveEnabled && hasLiveSshSessionForServer(srv.id)) {
          void refreshMetrics(srv.id);
        }
      }
      if (activeTabId === 'sftp') showStaticSftpForServer();
    }
  } else {
    if (activeTabId === 'metrics') showMEmpty();
    if (activeTabId === 'sftp') showStaticSftpEmpty();
  }
}

/* ══════════════════════════════════════════════════════════
   ADD TERMINAL TAB  (xterm.js + real SSH)
══════════════════════════════════════════════════════════ */
function addTermTab(options = {}) {
  const targetServerId = options.serverId ?? selId;
  if (targetServerId === null) return;
  const s = SRV.find(sv => sv.id === targetServerId);
  if (!s) return;
  const remoteProtocol = serverProtocol(s);
  const remoteProtocolLabel = remoteProtocol.toUpperCase();
  const usernameOverride = typeof options.usernameOverride === 'string' && options.usernameOverride.trim()
    ? options.usernameOverride.trim()
    : null;
  const forceUsernamePrompt = Boolean(options.forceUsernamePrompt);
  const providedHistoryId = typeof options?.historyId === 'string' ? options.historyId.trim() : '';
  const historyId = providedHistoryId || `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const tid = `t${++tabCounter}`;
  const srvTabCount = Object.values(termTabs).filter(t => t.srvId === s.id).length + 1;

  // Tab button
  const btn = document.createElement('div');
  btn.className = 'tab-term';
  btn.id = `tabbtn-${tid}`;
  btn.innerHTML = `
    <div class="tab-term-inner" data-tabid="${tid}">
      <div class="tab-dot" style="background:${sDot('unknown')};box-shadow:0 0 5px ${sDot('unknown')}"></div>
      <span class="tab-label">${s.name}</span>
      <span class="tab-num">#${srvTabCount}</span>
      <span class="tab-srv-badge" style="display:none">${s.name}</span>
    </div>
    <button class="tab-pin" data-tabid="${tid}" data-tip="Pin (keep across server switches)">&#x2299;</button>
    <button class="tab-close" data-tabid="${tid}">&#x00d7;</button>`;

  btn.querySelector('.tab-term-inner').addEventListener('click', () => setActiveTab(tid));
  btn.querySelector('.tab-pin').addEventListener('click', (e) => togglePin(e, tid));
  btn.querySelector('.tab-close').addEventListener('click', (e) => closeTab(e, tid));
  document.getElementById('term-tab-area').insertBefore(btn, document.getElementById('tab-add-btn'));

  // Terminal panel with xterm container
  const panel = document.createElement('div');
  panel.className = 'tab-panel term-panel';
  panel.id = `panel-${tid}`;
  panel.innerHTML = `
    <div class="term-topbar">
      <div class="term-info">
        <div class="term-srv-dot" id="term-dot-${tid}" style="background:${sDot('unknown')};box-shadow:0 0 6px ${sDot('unknown')}"></div>
        <span class="term-srv-name">${s.name}</span>
        <span class="term-srv-ip">${s.host}:${s.port} · ${remoteProtocolLabel}</span>
        <span class="term-cross-badge" id="cross-badge-${tid}" style="display:none">PINNED \u00b7 CROSS-SERVER</span>
        <span class="term-conn-status" id="conn-status-${tid}" style="margin-left:8px;font-size:9px;color:var(--warn);letter-spacing:1px">CONNECTING\u2026</span>
      </div>
      <div class="term-actions">
        <button class="term-btn" id="log-btn-${tid}">LOG</button>
        <button class="term-btn" id="clear-btn-${tid}">CLEAR</button>
        <button class="term-btn" id="reconnect-btn-${tid}">RECONNECT</button>
        <button class="term-btn danger" id="close-btn-${tid}">CLOSE</button>
      </div>
    </div>
    <div class="term-body">
      <div class="xterm-container" id="xterm-${tid}"></div>
    </div>`;
  document.getElementById('term-panels-host').appendChild(panel);

  // Wire up action buttons
  panel.querySelector(`#log-btn-${tid}`).addEventListener('click', () => toggleSessionLogging(tid));
  panel.querySelector(`#clear-btn-${tid}`).addEventListener('click', () => termClear(tid));
  panel.querySelector(`#reconnect-btn-${tid}`).addEventListener('click', () => termReconnect(tid));
  panel.querySelector(`#close-btn-${tid}`).addEventListener('click', () => closeTab(null, tid));

  termTabs[tid] = {
    mode: 'ssh',
    remoteProtocol,
    srvId: s.id, srv: s, pinned: false,
    historyId,
    usernameOverride,
    forceUsernamePrompt,
    connStatus: 'connecting',
    tabBtnEl: btn, panelEl: panel,
    terminal: null, fitAddon: null, sessionId: null,
    unlisten: null, unlistenEof: null, unlistenClosed: null,
    resizeObserver: null,
    pendingInput: '',
    inputFlushTimer: null,
    pendingOutput: [],
    outputFlushTimer: null,
    wslFallbackTimer: null,
  };

  if (remoteProtocol === 'ssh') {
    trackRecentSshSession({
      id: historyId,
      openedAtMs: Date.now(),
      serverId: s.id,
      serverName: s.name,
      host: s.host,
      port: s.port,
      username: usernameOverride || s.username || '',
    });
  }

  setActiveTab(tid);
  initTermSession(tid, s, usernameOverride, forceUsernamePrompt);
  refreshSidebarBadges();
  updateMainTerminalLayout();
  return tid;
}

function insertLocalTabButton(btn) {
  const area = document.getElementById('term-tab-area');
  const addBtn = document.getElementById('tab-add-btn');
  let anchor = addBtn;

  for (const child of Array.from(area.children)) {
    if (child.id === 'tab-add-btn') break;
    if (!child.classList.contains('tab-term')) continue;
    const childId = child.querySelector('.tab-term-inner')?.dataset?.tabid;
    const childTab = childId ? termTabs[childId] : null;
    if (!childTab || childTab.mode !== 'local') {
      anchor = child;
      break;
    }
  }

  area.insertBefore(btn, anchor);
}

function addLocalTermTab(shellType = 'powershell', options = {}) {
  const localShellType = normalizeLocalShellType(shellType);
  const shellLabel = localShellLabel(localShellType);
  const providedHistoryId = typeof options?.historyId === 'string' ? options.historyId.trim() : '';

  const tid = `l${++tabCounter}`;
  const historyId = providedHistoryId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const localCount = Object.values(termTabs).filter((t) => t.mode === 'local').length + 1;

  const btn = document.createElement('div');
  btn.className = 'tab-term';
  btn.id = `tabbtn-${tid}`;
  btn.innerHTML = `
    <div class="tab-term-inner" data-tabid="${tid}">
      <div class="tab-dot" style="background:${sDot('unknown')};box-shadow:0 0 5px ${sDot('unknown')}"></div>
      <span class="tab-label">LOCAL</span>
      <span class="tab-num">${shellLabel} #${localCount}</span>
      <span class="tab-srv-badge" style="display:none"></span>
    </div>
    <button class="tab-close" data-tabid="${tid}">&#x00d7;</button>`;

  btn.querySelector('.tab-term-inner').addEventListener('click', () => setActiveTab(tid));
  btn.querySelector('.tab-close').addEventListener('click', (e) => closeTab(e, tid));

  const panel = document.createElement('div');
  panel.className = 'tab-panel term-panel';
  panel.id = `panel-${tid}`;
  panel.innerHTML = `
    <div class="term-topbar">
      <div class="term-info">
        <div class="term-srv-dot" id="term-dot-${tid}" style="background:${sDot('unknown')};box-shadow:0 0 6px ${sDot('unknown')}"></div>
        <span class="term-srv-name">Local Terminal</span>
        <span class="term-srv-ip" id="term-local-meta-${tid}">${shellLabel}</span>
        <span class="term-conn-status" id="conn-status-${tid}" style="margin-left:8px;font-size:9px;color:var(--warn);letter-spacing:1px">CONNECTING\u2026</span>
      </div>
      <div class="term-actions">
        <button class="term-btn" id="log-btn-${tid}">LOG</button>
        <button class="term-btn" id="clear-btn-${tid}">CLEAR</button>
        <button class="term-btn" id="reconnect-btn-${tid}">RECONNECT</button>
        <button class="term-btn danger" id="close-btn-${tid}">CLOSE</button>
      </div>
    </div>
    <div class="term-body">
      <div class="xterm-container" id="xterm-${tid}"></div>
    </div>`;
  document.getElementById('term-panels-host').appendChild(panel);

  panel.querySelector(`#log-btn-${tid}`).addEventListener('click', () => toggleSessionLogging(tid));
  panel.querySelector(`#clear-btn-${tid}`).addEventListener('click', () => termClear(tid));
  panel.querySelector(`#reconnect-btn-${tid}`).addEventListener('click', () => termReconnect(tid));
  panel.querySelector(`#close-btn-${tid}`).addEventListener('click', () => closeTab(null, tid));

  termTabs[tid] = {
    mode: 'local',
    srvId: null, srv: null, pinned: true,
    historyId,
    localShellType,
    usernameOverride: null,
    forceUsernamePrompt: false,
    connStatus: 'connecting',
    tabBtnEl: btn, panelEl: panel,
    terminal: null, fitAddon: null, sessionId: null,
    unlisten: null, unlistenEof: null, unlistenClosed: null,
    resizeObserver: null,
    pendingInput: '',
    inputFlushTimer: null,
    pendingOutput: [],
    outputFlushTimer: null,
  };

  insertLocalTabButton(btn);
  const metaEl = document.getElementById(`term-local-meta-${tid}`);
  if (metaEl && hostDeviceInfo?.terminal_workspace) {
    metaEl.textContent = `${shellLabel} · ${hostDeviceInfo.terminal_workspace}`;
  }

  trackRecentLocalSession({
    id: historyId,
    shell: localShellType,
    openedAtMs: Date.now(),
    workspace: hostDeviceInfo?.terminal_workspace || '',
  });

  setActiveTab(tid);
  void initLocalTermSession(tid, localShellType);
  updateMainTerminalLayout();
  return tid;
}

function addVncTab(options = {}) {
  const host = options.host || '';
  const port = options.port || 5900;
  const password = options.password || '';
  const label = options.label || `${host}:${port}`;

  if (!host) {
    console.error('[vnc] No host specified');
    return null;
  }

  const tid = `v${++tabCounter}`;
  const historyId = `vnc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const vncCount = Object.values(termTabs).filter((t) => t.mode === 'vnc').length + 1;

  const btn = document.createElement('div');
  btn.className = 'tab-term';
  btn.id = `tabbtn-${tid}`;
  btn.innerHTML = `
    <div class="tab-term-inner" data-tabid="${tid}">
      <div class="tab-dot" style="background:${sDot('unknown')};box-shadow:0 0 5px ${sDot('unknown')}"></div>
      <span class="tab-label">VNC</span>
      <span class="tab-num">#${vncCount}</span>
      <span class="tab-srv-badge" style="display:none"></span>
    </div>
    <button class="tab-close" data-tabid="${tid}">&#x00d7;</button>`;

  btn.querySelector('.tab-term-inner').addEventListener('click', () => setActiveTab(tid));
  btn.querySelector('.tab-close').addEventListener('click', (e) => closeTab(e, tid));

  const panel = document.createElement('div');
  panel.className = 'tab-panel vnc-panel';
  panel.id = `panel-${tid}`;
  panel.innerHTML = `
    <div class="term-topbar">
      <div class="term-info">
        <div class="term-srv-dot" id="term-dot-${tid}" style="background:${sDot('unknown')};box-shadow:0 0 6px ${sDot('unknown')}"></div>
        <span class="term-srv-name">${escapeHtml(label)}</span>
        <span class="term-srv-ip">${escapeHtml(host)}:${port}</span>
        <span class="term-conn-status" id="conn-status-${tid}" style="margin-left:8px;font-size:9px;color:var(--warn);letter-spacing:1px">CONNECTING\u2026</span>
      </div>
      <div class="term-actions">
        <button class="term-btn" id="scale-btn-${tid}">SCALE: FIT</button>
        <button class="term-btn" id="reconnect-btn-${tid}">RECONNECT</button>
        <button class="term-btn danger" id="close-btn-${tid}">CLOSE</button>
      </div>
    </div>
    <div class="vnc-body" id="vnc-body-${tid}">
      <div class="vnc-status vnc-connecting" id="vnc-status-${tid}">
        <div class="vnc-status-icon">\u23F3</div>
        <div>Connecting to VNC server...</div>
      </div>
    </div>`;
  document.getElementById('term-panels-host').appendChild(panel);

  panel.querySelector(`#scale-btn-${tid}`).addEventListener('click', () => toggleVncScale(tid));
  panel.querySelector(`#reconnect-btn-${tid}`).addEventListener('click', () => vncReconnect(tid));
  panel.querySelector(`#close-btn-${tid}`).addEventListener('click', () => closeTab(null, tid));

  termTabs[tid] = {
    mode: 'vnc',
    srvId: null, srv: null, pinned: true,
    historyId,
    shortcutId: options.shortcutId || null,
    vncHost: host,
    vncPort: port,
    vncPassword: password,
    connStatus: 'connecting',
    tabBtnEl: btn, panelEl: panel,
    sessionId: null,
    wsUrl: null,
    rfb: null,
    unlisten: null,
    unlistenConnected: null,
    unlistenDisconnected: null,
    unlistenError: null,
  };

  insertLocalTabButton(btn);
  setActiveTab(tid);
  void initVncSession(tid);
  updateMainTerminalLayout();
  return tid;
}

async function initVncSession(tid) {
  const t = termTabs[tid];
  if (!t || t.mode !== 'vnc') return;

  const statusEl = document.getElementById(`vnc-status-${tid}`);
  const bodyEl = document.getElementById(`vnc-body-${tid}`);
  const dotEl = document.getElementById(`term-dot-${tid}`);
  const connEl = document.getElementById(`conn-status-${tid}`);

  try {
    // Start VNC proxy via Tauri
    const result = await invoke('vnc_connect', {
      host: t.vncHost,
      port: t.vncPort,
    });

    t.sessionId = result.session_id;
    t.wsUrl = result.ws_url;

    // Listen for VNC events
    t.unlistenConnected = await listen(`vnc-connected-${t.sessionId}`, () => {
      updateVncTabStatus(tid, 'connected');
    });

    t.unlistenDisconnected = await listen(`vnc-disconnected-${t.sessionId}`, () => {
      updateVncTabStatus(tid, 'disconnected');
    });

    t.unlistenError = await listen(`vnc-error-${t.sessionId}`, (event) => {
      if (statusEl) {
        statusEl.className = 'vnc-status vnc-error';
        statusEl.innerHTML = `<div class="vnc-status-icon">\u26A0</div><div>${escapeHtml(String(event.payload))}</div>`;
        statusEl.style.display = '';
      }
      updateVncTabStatus(tid, 'error');
    });

    // Hide status, create RFB viewer
    if (statusEl) statusEl.style.display = 'none';

    // Create noVNC RFB instance
    const rfb = new RFB(bodyEl, t.wsUrl, {
      credentials: t.vncPassword ? { password: t.vncPassword } : undefined,
    });

    rfb.scaleViewport = true;
    rfb.resizeSession = true;

    rfb.addEventListener('connect', () => {
      updateVncTabStatus(tid, 'connected');
    });

    rfb.addEventListener('disconnect', (e) => {
      if (e.detail.clean) {
        updateVncTabStatus(tid, 'disconnected');
      } else {
        if (statusEl) {
          statusEl.className = 'vnc-status vnc-error';
          statusEl.innerHTML = `<div class="vnc-status-icon">\u26A0</div><div>Connection lost</div>`;
          statusEl.style.display = '';
        }
        updateVncTabStatus(tid, 'error');
      }
    });

    rfb.addEventListener('securityfailure', (e) => {
      if (statusEl) {
        statusEl.className = 'vnc-status vnc-error';
        statusEl.innerHTML = `<div class="vnc-status-icon">\u26A0</div><div>Authentication failed: ${escapeHtml(e.detail.reason || 'Unknown error')}</div>`;
        statusEl.style.display = '';
      }
      updateVncTabStatus(tid, 'error');
    });

    rfb.addEventListener('clipboard', (e) => {
      if (e.detail.text) {
        navigator.clipboard.writeText(e.detail.text).catch(() => {});
      }
    });

    t.rfb = rfb;

  } catch (err) {
    console.error('[vnc] Connection error:', err);
    if (statusEl) {
      statusEl.className = 'vnc-status vnc-error';
      statusEl.innerHTML = `<div class="vnc-status-icon">\u26A0</div><div>${escapeHtml(String(err))}</div>`;
      statusEl.style.display = '';
    }
    updateVncTabStatus(tid, 'error');
  }
}

function updateVncTabStatus(tid, status) {
  const t = termTabs[tid];
  if (!t) return;

  t.connStatus = status;
  const dotEl = document.getElementById(`term-dot-${tid}`);
  const connEl = document.getElementById(`conn-status-${tid}`);
  const tabDot = t.tabBtnEl?.querySelector('.tab-dot');

  const color = sDot(status === 'connected' ? 'online' : status === 'error' ? 'offline' : 'unknown');
  const label = status === 'connected' ? 'CONNECTED' : status === 'error' ? 'ERROR' : status === 'disconnected' ? 'DISCONNECTED' : 'CONNECTING\u2026';

  if (dotEl) {
    dotEl.style.background = color;
    dotEl.style.boxShadow = `0 0 6px ${color}`;
  }
  if (tabDot) {
    tabDot.style.background = color;
    tabDot.style.boxShadow = `0 0 5px ${color}`;
  }
  if (connEl) {
    connEl.textContent = label;
    connEl.style.color = status === 'connected' ? 'var(--accent2)' : status === 'error' ? 'var(--danger)' : 'var(--warn)';
  }
  renderSidebar();
}

function toggleVncScale(tid) {
  const t = termTabs[tid];
  if (!t || t.mode !== 'vnc' || !t.rfb) return;

  const btn = t.panelEl.querySelector(`#scale-btn-${tid}`);
  if (!btn) return;

  // Toggle scaling
  t.rfb.scaleViewport = !t.rfb.scaleViewport;
  t.rfb.resizeSession = !t.rfb.scaleViewport;

  if (t.rfb.scaleViewport) {
    btn.textContent = 'SCALE: FIT';
  } else {
    btn.textContent = 'SCALE: 1:1';
  }
}

async function toggleSessionLogging(tid) {
  const t = termTabs[tid];
  if (!t) return;

  const btn = t.panelEl.querySelector(`#log-btn-${tid}`);
  if (!btn) return;

  if (t.isLogging) {
    t.isLogging = false;
    t.logFilePath = null;
    btn.textContent = 'LOG';
    btn.classList.remove('active');
    showAlert({
      title: 'Logging Stopped',
      message: 'Terminal session logging has been stopped.',
      variant: 'info',
    });
  } else {
    try {
      const selected = await saveDialog({
        title: 'Save Terminal Log File',
        filters: [{ name: 'Text Logs', extensions: ['txt', 'log'] }],
      });
      if (selected) {
        t.logFilePath = selected;
        t.isLogging = true;
        btn.textContent = 'LOGGING';
        btn.classList.add('active');
        showAlert({
          title: 'Logging Started',
          message: `Recording session output to: ${selected}`,
          variant: 'info',
        });
      }
    } catch (err) {
      showError('Failed to start logging', err);
    }
  }
}

async function vncReconnect(tid) {
  const t = termTabs[tid];
  if (!t || t.mode !== 'vnc') return;

  // Cleanup existing connection
  if (t.rfb) {
    try { t.rfb.disconnect(); } catch { }
    t.rfb = null;
  }
  if (t.sessionId) {
    try { await invoke('vnc_disconnect', { sessionId: t.sessionId }); } catch { }
  }
  if (t.unlistenConnected) { t.unlistenConnected(); t.unlistenConnected = null; }
  if (t.unlistenDisconnected) { t.unlistenDisconnected(); t.unlistenDisconnected = null; }
  if (t.unlistenError) { t.unlistenError(); t.unlistenError = null; }

  // Reset UI
  const statusEl = document.getElementById(`vnc-status-${tid}`);
  const bodyEl = document.getElementById(`vnc-body-${tid}`);
  if (statusEl) {
    statusEl.className = 'vnc-status vnc-connecting';
    statusEl.innerHTML = `<div class="vnc-status-icon">\u23F3</div><div>Connecting to VNC server...</div>`;
    statusEl.style.display = '';
  }
  // Remove old canvas if any
  if (bodyEl) {
    const canvas = bodyEl.querySelector('canvas');
    if (canvas) canvas.remove();
  }

  updateVncTabStatus(tid, 'connecting');
  await initVncSession(tid);
}

function readTerminalLine(term, promptText, secret = false) {
  return new Promise((resolve) => {
    let value = '';
    term.write(promptText);

    const dispose = term.onData((data) => {
      for (const ch of data) {
        if (ch === '\r') {
          term.write('\r\n');
          dispose.dispose();
          resolve({ cancelled: false, value });
          return;
        }
        if (ch === '\n') continue;
        if (ch === '\u0003') {
          term.write('^C\r\n');
          dispose.dispose();
          resolve({ cancelled: true, value: '' });
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (!value) continue;
          value = value.slice(0, -1);
          term.write('\b \b');
          continue;
        }
        if (ch >= ' ' && ch !== '\u007f') {
          value += ch;
          term.write(secret ? '*' : ch);
        }
      }
    });
  });
}

async function resolveTerminalCredentials(term, serverConfig, usernameOverride = null, forceUsernamePrompt = false) {
  let username = (!forceUsernamePrompt && typeof usernameOverride === 'string' && usernameOverride.trim())
    ? usernameOverride.trim()
    : (!forceUsernamePrompt ? String(serverConfig?.username || '').trim() : '');

  if (!username) {
    const usernameInput = await readTerminalLine(
      term,
      `\x1b[38;2;58;85;112mUsername for ${serverConfig.host}:\x1b[0m `
    );
    if (usernameInput.cancelled) return { cancelled: true, username: '', passwordOverride: null };
    username = String(usernameInput.value || '').trim();
    if (!username) {
      term.writeln('\x1b[38;2;255;59;92mUsername is required.\x1b[0m');
      return { cancelled: true, username: '', passwordOverride: null };
    }
  }

  let passwordOverride = null;
  const authType = serverConfig?._raw?.auth_method?.type;
  const configuredPassword = String(serverConfig?._raw?.auth_method?.password ?? '');
  if (authType === 'Password' && !configuredPassword) {
    const passwordInput = await readTerminalLine(
      term,
      `\x1b[38;2;58;85;112mPassword for ${username}@${serverConfig.host}:\x1b[0m `,
      true
    );
    if (passwordInput.cancelled) return { cancelled: true, username: '', passwordOverride: null };
    passwordOverride = String(passwordInput.value || '');
  }

  return { cancelled: false, username, passwordOverride };
}

function flushTerminalOutput(tab) {
  if (!tab) return;
  if (tab.outputFlushTimer !== null) {
    clearTimeout(tab.outputFlushTimer);
    tab.outputFlushTimer = null;
  }
  if (!tab.terminal) {
    tab.pendingOutput = [];
    return;
  }
  const chunks = tab.pendingOutput.splice(0, tab.pendingOutput.length);
  if (!chunks.length) return;
  tab.terminal.write(chunks.join(''));
}

function queueTerminalOutput(tab, payload) {
  if (!tab || !payload) return;
  tab.pendingOutput.push(String(payload));
  if (tab.outputFlushTimer !== null) return;
  tab.outputFlushTimer = setTimeout(() => {
    flushTerminalOutput(tab);
  }, TERMINAL_OUTPUT_FLUSH_MS);
}

function flushTerminalInput(tab, command) {
  if (!tab) return;
  if (tab.inputFlushTimer !== null) {
    clearTimeout(tab.inputFlushTimer);
    tab.inputFlushTimer = null;
  }
  const text = tab.pendingInput;
  tab.pendingInput = '';
  if (!text || !tab.sessionId) return;
  invoke(command, { sessionId: tab.sessionId, data: text }).catch(() => { });
}

function queueTerminalInput(tab, command, text) {
  if (!tab || !tab.sessionId || !text) return;
  tab.pendingInput += String(text);
  if (tab.pendingInput.length >= 2048) {
    flushTerminalInput(tab, command);
    return;
  }
  if (tab.inputFlushTimer !== null) return;
  tab.inputFlushTimer = setTimeout(() => {
    flushTerminalInput(tab, command);
  }, TERMINAL_INPUT_FLUSH_MS);
}

function clearTerminalIoQueues(tab) {
  if (!tab) return;
  if (tab.inputFlushTimer !== null) {
    clearTimeout(tab.inputFlushTimer);
    tab.inputFlushTimer = null;
  }
  if (tab.outputFlushTimer !== null) {
    clearTimeout(tab.outputFlushTimer);
    tab.outputFlushTimer = null;
  }
  tab.pendingInput = '';
  tab.pendingOutput = [];
}

function clearLocalWslFallbackTimer(tab) {
  if (!tab) return;
  if (tab.wslFallbackTimer !== null) {
    clearTimeout(tab.wslFallbackTimer);
    tab.wslFallbackTimer = null;
  }
}

function remoteTabProtocol(tab) {
  return normalizeConnectionProtocol(tab?.remoteProtocol || 'ssh');
}

function remoteCommand(tab, action) {
  return `${remoteTabProtocol(tab)}_${action}`;
}

function remoteEventPrefix(tab) {
  return remoteTabProtocol(tab);
}

function initTerminalSearch(tid, term, panel) {
  if (!panel || !term) return;
  const termBody = panel.querySelector('.term-body');
  if (!termBody) return;

  const searchBar = document.createElement('div');
  searchBar.className = 'term-search-bar';
  searchBar.id = `search-bar-${tid}`;
  searchBar.style.cssText = `
    display: none;
    position: absolute;
    top: 8px;
    right: 24px;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 6px 12px;
    gap: 8px;
    align-items: center;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  `;

  searchBar.innerHTML = `
    <input type="text" placeholder="Find..." style="background:#0c0f12;border:1px solid #444;color:#fff;padding:4px 8px;font-size:12px;border-radius:3px;outline:none;width:150px;" class="search-input">
    <span style="font-size:11px;color:#888;min-width:60px;text-align:center;user-select:none;" class="search-status"></span>
    <button style="background:none;border:none;color:#aaa;cursor:pointer;padding:4px 6px;font-size:12px;line-height:1;" class="search-prev" title="Previous match">&uarr;</button>
    <button style="background:none;border:none;color:#aaa;cursor:pointer;padding:4px 6px;font-size:12px;line-height:1;" class="search-next" title="Next match">&darr;</button>
    <button style="background:none;border:none;color:#aaa;cursor:pointer;padding:4px 6px;font-size:12px;line-height:1;margin-left:4px;" class="search-close" title="Close search">&times;</button>
  `;

  termBody.style.position = 'relative';
  termBody.appendChild(searchBar);

  const input = searchBar.querySelector('.search-input');
  const status = searchBar.querySelector('.search-status');
  const prevBtn = searchBar.querySelector('.search-prev');
  const nextBtn = searchBar.querySelector('.search-next');
  const closeBtn = searchBar.querySelector('.search-close');

  let searchState = {
    matches: [],
    currentIndex: -1,
    query: ''
  };

  const updateSearch = () => {
    const query = input.value.trim();
    if (!query) {
      searchState = { matches: [], currentIndex: -1, query: '' };
      status.textContent = '';
      return;
    }

    const buffer = term.buffer.active;
    const totalLines = buffer.length;
    const matches = [];
    const lowerQuery = query.toLowerCase();

    for (let i = 0; i < totalLines; i++) {
      const line = buffer.getLine(i);
      if (line) {
        const text = line.translateToString(true);
        if (text.toLowerCase().includes(lowerQuery)) {
          matches.push(i);
        }
      }
    }

    searchState.query = query;
    searchState.matches = matches;

    if (matches.length === 0) {
      searchState.currentIndex = -1;
      status.textContent = 'No matches';
      status.style.color = '#ff3b5c';
    } else {
      const currentScroll = term.buffer.active.viewportY;
      let nearestIndex = 0;
      let minDiff = Infinity;
      for (let idx = 0; idx < matches.length; idx++) {
        const diff = Math.abs(matches[idx] - currentScroll);
        if (diff < minDiff) {
          minDiff = diff;
          nearestIndex = idx;
        }
      }
      searchState.currentIndex = nearestIndex;
      scrollToMatch();
    }
  };

  const scrollToMatch = () => {
    if (searchState.currentIndex < 0 || searchState.currentIndex >= searchState.matches.length) return;
    const lineIndex = searchState.matches[searchState.currentIndex];
    term.scrollToLine(lineIndex);
    status.textContent = `${searchState.currentIndex + 1} of ${searchState.matches.length}`;
    status.style.color = '#888';
  };

  input.addEventListener('input', updateSearch);

  prevBtn.addEventListener('click', () => {
    if (searchState.matches.length === 0) return;
    searchState.currentIndex = (searchState.currentIndex - 1 + searchState.matches.length) % searchState.matches.length;
    scrollToMatch();
  });

  nextBtn.addEventListener('click', () => {
    if (searchState.matches.length === 0) return;
    searchState.currentIndex = (searchState.currentIndex + 1) % searchState.matches.length;
    scrollToMatch();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        prevBtn.click();
      } else {
        nextBtn.click();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });

  const closeSearch = () => {
    searchBar.style.display = 'none';
    term.focus();
  };

  closeBtn.addEventListener('click', closeSearch);

  panel.toggleSearch = () => {
    if (searchBar.style.display === 'none') {
      searchBar.style.display = 'flex';
      input.focus();
      input.select();
      updateSearch();
    } else {
      closeSearch();
    }
  };
}

/* ══════════════════════════════════════════════════════════
   INIT TERMINAL SESSION (real SSH via Tauri)
   // ══════════════════════════════════════════════════════════ */
async function initTermSession(tid, serverConfig, usernameOverride = null, forceUsernamePrompt = false) {
  const t = termTabs[tid];
  if (!t) return;
  const remoteProtocol = remoteTabProtocol(t);
  const eventPrefix = remoteEventPrefix(t);
  const writeCommand = remoteCommand(t, 'write_text');
  const resizeCommand = remoteCommand(t, 'resize');
  const connectCommand = remoteCommand(t, 'connect');

  const container = document.getElementById(`xterm-${tid}`);

  // Create xterm.js terminal
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    theme: {
      background: '#060a0e',
      foreground: '#b8cce0',
      cursor: '#00bfff',
      cursorAccent: '#060a0e',
      selectionBackground: '#1a284066',
      selectionForeground: '#ffffff',
      black: '#0b0f16',
      red: '#ff3b5c',
      green: '#00ffaa',
      yellow: '#f5a623',
      blue: '#00bfff',
      magenta: '#cc66ff',
      cyan: '#00bfff',
      white: '#b8cce0',
      brightBlack: '#3a5570',
      brightRed: '#ff6b88',
      brightGreen: '#33ffbb',
      brightYellow: '#ffcc44',
      brightBlue: '#44ccff',
      brightMagenta: '#dd88ff',
      brightCyan: '#44ddff',
      brightWhite: '#deeeff',
    },
    cursorBlink: true,
    scrollback: t.srv?.scrollback_limit || 10000,
    allowProposedApi: true,
    rightClickSelectsWord: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);
  initTerminalSearch(tid, term, t.panelEl);

  // Clipboard: Ctrl+Shift+C to copy, Ctrl+Shift+V to paste
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      e.stopPropagation();
      const panel = document.getElementById(`panel-${tid}`);
      if (panel && typeof panel.toggleSearch === 'function') {
        panel.toggleSearch();
      }
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      e.stopPropagation();
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    // Ctrl+Shift+V → paste from clipboard
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard.readText().then((text) => {
        if (text) queueTerminalInput(t, writeCommand, text);
      });
      return false;
    }
    // Ctrl+V (without shift) → also paste for convenience
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard.readText().then((text) => {
        if (text) queueTerminalInput(t, writeCommand, text);
      });
      return false;
    }
    return true;
  });

  // Delay fit to ensure container is sized
  await new Promise(r => setTimeout(r, 100));
  fitAddon.fit();

  t.terminal = term;
  t.fitAddon = fitAddon;

  let connectUsername = '';
  let passwordOverride = null;

  if (remoteProtocol === 'ssh') {
    const creds = await resolveTerminalCredentials(term, serverConfig, usernameOverride, forceUsernamePrompt);
    if (creds.cancelled) {
      term.writeln('\x1b[38;2;58;85;112mConnection cancelled.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
      return;
    }

    connectUsername = creds.username;
    passwordOverride = creds.passwordOverride;
    t.usernameOverride = connectUsername;
    t.forceUsernamePrompt = false;
    cacheSftpCredentials(serverConfig.id, connectUsername, passwordOverride);
    if (t.mode === 'ssh' && t.historyId) {
      trackRecentSshSession({
        id: t.historyId,
        openedAtMs: Date.now(),
        serverId: serverConfig.id,
        serverName: serverConfig.name,
        host: serverConfig.host,
        port: serverConfig.port,
        username: connectUsername,
      });
    }
    term.writeln('\x1b[38;2;0;191;255m\u2592 Connecting via SSH to ' + serverConfig.name + ' (' + serverConfig.host + ':' + serverConfig.port + ') as ' + connectUsername + '\u2026\x1b[0m');
  } else {
    t.usernameOverride = null;
    t.forceUsernamePrompt = false;
    term.writeln('\x1b[38;2;0;191;255m\u2592 Connecting via TELNET to ' + serverConfig.name + ' (' + serverConfig.host + ':' + serverConfig.port + ')\u2026\x1b[0m');
  }

  try {
    const connectPayload = {
      serverId: serverConfig.id,
      cols: term.cols,
      rows: term.rows,
    };
    if (remoteProtocol === 'ssh') {
      if (connectUsername) connectPayload.usernameOverride = connectUsername;
      if (passwordOverride !== null) connectPayload.passwordOverride = passwordOverride;
    }
    const sessionId = await invoke(connectCommand, connectPayload);

    t.sessionId = sessionId;

    updateTabStatus(tid, 'connected');

    t.unlisten = await listen(`${eventPrefix}-data-${sessionId}`, (event) => {
      queueTerminalOutput(t, event.payload);
      if (t.isLogging && t.logFilePath) {
        void invoke('append_to_file', { path: t.logFilePath, text: event.payload });
      }
    });

    t.unlistenEof = await listen(`${eventPrefix}-eof-${sessionId}`, () => {
      term.writeln('\r\n\x1b[38;2;245;166;35m\u2592 Connection closed by remote host.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    t.unlistenClosed = await listen(`${eventPrefix}-closed-${sessionId}`, () => {
      term.writeln('\r\n\x1b[38;2;255;59;92m\u2592 Connection lost.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    term.onData((data) => {
      queueTerminalInput(t, writeCommand, data);
    });

    term.onResize(({ cols, rows }) => {
      if (!t.sessionId) return;
      invoke(resizeCommand, { sessionId: t.sessionId, cols, rows })
        .catch(() => { });
    });

    // Re-fit on container resize
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { }
    });
    resizeObserver.observe(container);
    t.resizeObserver = resizeObserver;

  } catch (err) {
    term.writeln(`\x1b[38;2;255;59;92m\u2716 Connection failed: ${err}\x1b[0m`);
    term.writeln('\x1b[38;2;58;85;112mPress RECONNECT to try again.\x1b[0m');
    updateTabStatus(tid, 'error');
  }
}

async function initLocalTermSession(tid, shellType = 'powershell') {
  const t = termTabs[tid];
  if (!t) return;
  const localShellType = normalizeLocalShellType(shellType);
  t.localShellType = localShellType;
  clearLocalWslFallbackTimer(t);

  const container = document.getElementById(`xterm-${tid}`);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    theme: {
      background: '#060a0e',
      foreground: '#b8cce0',
      cursor: '#00bfff',
      cursorAccent: '#060a0e',
      selectionBackground: '#1a284066',
      selectionForeground: '#ffffff',
      black: '#0b0f16',
      red: '#ff3b5c',
      green: '#00ffaa',
      yellow: '#f5a623',
      blue: '#00bfff',
      magenta: '#cc66ff',
      cyan: '#00bfff',
      white: '#b8cce0',
      brightBlack: '#3a5570',
      brightRed: '#ff6b88',
      brightGreen: '#33ffbb',
      brightYellow: '#ffcc44',
      brightBlue: '#44ccff',
      brightMagenta: '#dd88ff',
      brightCyan: '#44ddff',
      brightWhite: '#deeeff',
    },
    cursorBlink: true,
    scrollback: parseInt(localStorage.getItem('nodegrid_scrollback_limit')) || 10000,
    allowProposedApi: true,
    rightClickSelectsWord: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);
  initTerminalSearch(tid, term, t.panelEl);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      e.stopPropagation();
      const panel = document.getElementById(`panel-${tid}`);
      if (panel && typeof panel.toggleSearch === 'function') {
        panel.toggleSearch();
      }
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      e.stopPropagation();
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    if ((e.ctrlKey && e.shiftKey && e.code === 'KeyV') || (e.ctrlKey && !e.shiftKey && e.code === 'KeyV')) {
      navigator.clipboard.readText().then((text) => {
        if (text) queueTerminalInput(t, 'local_shell_write_text', text);
      });
      return false;
    }
    return true;
  });

  await new Promise(r => setTimeout(r, 100));
  fitAddon.fit();

  t.terminal = term;
  t.fitAddon = fitAddon;

  const shellLabel = localShellLabel(localShellType);
  term.writeln(`\x1b[38;2;0;191;255m\u2592 Starting local ${shellLabel} shell\u2026\x1b[0m`);

  try {
    const sessionId = await invoke('local_shell_connect', {
      shellType: localShellType,
      cols: term.cols,
      rows: term.rows,
    });

    t.sessionId = sessionId;
    updateTabStatus(tid, 'connected');

    t.unlisten = await listen(`local-data-${sessionId}`, (event) => {
      const payload = String(event.payload || '');
      queueTerminalOutput(t, payload);
      if (t.isLogging && t.logFilePath) {
        void invoke('append_to_file', { path: t.logFilePath, text: payload });
      }

      if (localShellType !== 'wsl') return;
      if (t.wslFallbackTimer !== null) return;
      if (!payload.toLowerCase().includes(WSL_MISSING_PROMPT_MARKER)) return;

      t.wslFallbackTimer = setTimeout(async () => {
        const active = termTabs[tid];
        if (!active) return;
        active.wslFallbackTimer = null;
        if (active.mode !== 'local') return;
        if (active.localShellType !== 'wsl') return;
        if (!active.sessionId || active.sessionId !== sessionId) return;
        if (active.connStatus !== 'connected') return;

        queueTerminalOutput(
          active,
          '\r\n\x1b[38;2;245;166;35m\u2592 WSL install prompt timed out. Falling back to Bash\u2026\x1b[0m\r\n'
        );
        active.localShellType = 'bash';
        try {
          await termReconnect(tid);
        } catch (err) {
          queueTerminalOutput(
            active,
            `\r\n\x1b[38;2;255;59;92m\u2716 Bash fallback failed: ${String(err)}\x1b[0m\r\n`
          );
        }
      }, WSL_FALLBACK_DELAY_MS);
    });

    t.unlistenEof = await listen(`local-eof-${sessionId}`, () => {
      clearLocalWslFallbackTimer(t);
      term.writeln('\r\n\x1b[38;2;245;166;35m\u2592 Local shell closed.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    t.unlistenClosed = await listen(`local-closed-${sessionId}`, () => {
      clearLocalWslFallbackTimer(t);
      term.writeln('\r\n\x1b[38;2;255;59;92m\u2592 Local shell terminated.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    term.onData((data) => {
      queueTerminalInput(t, 'local_shell_write_text', data);
    });

    term.onResize(({ cols, rows }) => {
      if (!t.sessionId) return;
      invoke('local_shell_resize', { sessionId: t.sessionId, cols, rows })
        .catch(() => { });
    });

    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { }
    });
    resizeObserver.observe(container);
    t.resizeObserver = resizeObserver;
  } catch (err) {
    term.writeln(`\x1b[38;2;255;59;92m\u2716 Local terminal failed: ${err}\x1b[0m`);
    term.writeln('\x1b[38;2;58;85;112mPress RECONNECT to try again.\x1b[0m');
    updateTabStatus(tid, 'error');
  }
}

function updateTabStatus(tid, status) {
  const t = termTabs[tid];
  if (!t) return;
  t.connStatus = status;

  const statusEl = document.getElementById(`conn-status-${tid}`);
  const dot = t.tabBtnEl.querySelector('.tab-dot');
  const topDot = document.getElementById(`term-dot-${tid}`);

  const colors = {
    connecting: { text: 'CONNECTING\u2026', color: 'var(--warn)', dotColor: '#f5a623' },
    connected: { text: 'CONNECTED', color: 'var(--accent2)', dotColor: '#00ffaa' },
    disconnected: { text: 'DISCONNECTED', color: 'var(--muted)', dotColor: '#3a5570' },
    error: { text: 'ERROR', color: 'var(--danger)', dotColor: '#ff3b5c' },
  };
  const c = colors[status] || colors.connecting;

  if (statusEl) { statusEl.textContent = c.text; statusEl.style.color = c.color; }
  if (dot) { dot.style.background = c.dotColor; dot.style.boxShadow = `0 0 5px ${c.dotColor}`; }
  if (topDot) { topDot.style.background = c.dotColor; topDot.style.boxShadow = `0 0 6px ${c.dotColor}`; }
  if (t.mode === 'ssh' && remoteTabProtocol(t) === 'ssh') {
    maybeRenderSelectedMetrics();
  }
}

/* ══════════════════════════════════════════════════════════
   PIN / CLOSE / CLEAR / RECONNECT
══════════════════════════════════════════════════════════ */
function togglePin(e, tid) {
  e.stopPropagation();
  const t = termTabs[tid]; if (!t) return;
  t.pinned = !t.pinned;
  const btn = t.tabBtnEl.querySelector('.tab-pin');
  if (t.pinned) {
    t.tabBtnEl.classList.add('pinned');
    btn.dataset.tip = 'Unpin';
    btn.textContent = '\u229b';
  } else {
    t.tabBtnEl.classList.remove('pinned');
    btn.dataset.tip = 'Pin (keep across server switches)';
    btn.textContent = '\u2299';
  }
  refreshTabVisibility();
}

async function closeTab(e, tid) {
  if (e) e.stopPropagation();
  const t = termTabs[tid]; if (!t) return;
  const wasActive = activeTabId === tid;

  // VNC mode cleanup
  if (t.mode === 'vnc') {
    if (t.rfb) {
      try { t.rfb.disconnect(); } catch { }
      t.rfb = null;
    }
    if (t.sessionId) {
      try { await invoke('vnc_disconnect', { sessionId: t.sessionId }); } catch { }
    }
    if (t.unlistenConnected) t.unlistenConnected();
    if (t.unlistenDisconnected) t.unlistenDisconnected();
    if (t.unlistenError) t.unlistenError();
  } else {
    // Terminal mode cleanup
    clearLocalWslFallbackTimer(t);
    if (t.mode === 'local') flushTerminalInput(t, 'local_shell_write_text');
    else flushTerminalInput(t, remoteCommand(t, 'write_text'));

    if (t.sessionId) {
      const disconnectCmd = t.mode === 'local' ? 'local_shell_disconnect' : remoteCommand(t, 'disconnect');
      try { await invoke(disconnectCmd, { sessionId: t.sessionId }); } catch { }
    }
    // Clean up listeners
    if (t.unlisten) t.unlisten();
    if (t.unlistenEof) t.unlistenEof();
    if (t.unlistenClosed) t.unlistenClosed();
    clearTerminalIoQueues(t);
    // Clean up xterm
    if (t.resizeObserver) t.resizeObserver.disconnect();
    if (t.terminal) t.terminal.dispose();
  }

  t.tabBtnEl.remove();
  t.panelEl.remove();
  delete termTabs[tid];

  if (wasActive) {
    const vis = Object.entries(termTabs).find(([, t]) => t.mode === 'local' || t.mode === 'vnc' || t.pinned || t.srvId === selId);
    setActiveTab(vis ? vis[0] : 'metrics');
  }
  renderSidebar();
  refreshSidebarBadges();
  maybeRenderSelectedMetrics();
  updateMainTerminalLayout();
}

function termClear(tid) {
  const t = termTabs[tid];
  if (t?.terminal) t.terminal.clear();
}

async function termReconnect(tid) {
  const t = termTabs[tid]; if (!t) return;
  clearLocalWslFallbackTimer(t);
  if (t.mode === 'local') flushTerminalInput(t, 'local_shell_write_text');
  else flushTerminalInput(t, remoteCommand(t, 'write_text'));

  if (t.sessionId) {
    const disconnectCmd = t.mode === 'local' ? 'local_shell_disconnect' : remoteCommand(t, 'disconnect');
    try { await invoke(disconnectCmd, { sessionId: t.sessionId }); } catch { }
    t.sessionId = null;
  }
  if (t.unlisten) { t.unlisten(); t.unlisten = null; }
  if (t.unlistenEof) { t.unlistenEof(); t.unlistenEof = null; }
  if (t.unlistenClosed) { t.unlistenClosed(); t.unlistenClosed = null; }
  clearTerminalIoQueues(t);
  if (t.resizeObserver) { t.resizeObserver.disconnect(); t.resizeObserver = null; }
  if (t.terminal) { t.terminal.dispose(); t.terminal = null; }

  updateTabStatus(tid, 'connecting');
  if (t.mode === 'local') {
    await initLocalTermSession(tid, t.localShellType || 'powershell');
  } else {
    await initTermSession(tid, t.srv, t.usernameOverride || null, Boolean(t.forceUsernamePrompt));
  }
}

/* ══════════════════════════════════════════════════════════
   METRICS
══════════════════════════════════════════════════════════ */
function hasLiveSshSessionForServer(serverId) {
  if (!serverId) return false;
  return Object.values(termTabs).some((tab) => {
    return tab.mode === 'ssh'
      && remoteTabProtocol(tab) === 'ssh'
      && tab.srvId === serverId
      && tab.connStatus === 'connected'
      && Boolean(tab.sessionId);
  });
}

function maybeRenderSelectedMetrics() {
  if (activeTabId !== 'metrics' || selId === null) return;
  const selected = SRV.find((server) => server.id === selId);
  if (!selected) return;
  renderMetrics(selected);
}

async function tickLiveMetricsRefresh() {
  if (activeTabId !== 'metrics' || selId === null) return;
  if (!metricsLiveEnabled) return;
  if (!hasLiveSshSessionForServer(selId)) return;
  await refreshMetrics(selId);
}

function showMEmpty() {
  document.getElementById('m-empty').style.display = 'flex';
  document.getElementById('m-content').style.display = 'none';
}

function getLiveMetricsState(serverId) {
  if (!LIVE_METRICS.has(serverId)) {
    LIVE_METRICS.set(serverId, {
      loading: false,
      error: '',
      lastUpdatedMs: 0,
      data: null,
    });
  }
  return LIVE_METRICS.get(serverId);
}

function getServerIntelState(serverId) {
  if (!SERVER_INTEL.has(serverId)) {
    SERVER_INTEL.set(serverId, {
      loading: false,
      error: '',
      lastUpdatedMs: 0,
      data: null,
    });
  }
  return SERVER_INTEL.get(serverId);
}

function cleanLiveMetricsCache() {
  const valid = new Set(SRV.map(s => s.id));
  for (const key of LIVE_METRICS.keys()) {
    if (!valid.has(key)) LIVE_METRICS.delete(key);
  }
}

function cleanServerIntelCache() {
  const valid = new Set(SRV.map(s => s.id));
  for (const key of SERVER_INTEL.keys()) {
    if (!valid.has(key)) SERVER_INTEL.delete(key);
  }
}

async function openServiceInBrowser(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return;
  try {
    await invoke('open_external_url', { url: target });
  } catch {
    try {
      window.open(target, '_blank', 'noopener,noreferrer');
    } catch {
      // Ignore open failures.
    }
  }
}

function renderSensitiveValue(value, kind = 'text') {
  return renderSensitiveValueHelper(value, kind, metricsSensitiveMasked);
}

function sftpEntryKind(entry) {
  if (entry?.is_dir) return 'dir';
  if (entry?.is_symlink) return 'link';
  return 'file';
}

function sftpEntryIconMarkup(entry) {
  const kind = sftpEntryKind(entry);
  if (kind === 'dir') {
    return `<span class="sftp-entry-icon dir" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M3.5 6.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>
      </svg>
    </span>`;
  }
  if (kind === 'link') {
    return `<span class="sftp-entry-icon link" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M8.5 12.5l3-3a3 3 0 1 1 4.2 4.2l-2 2"></path>
        <path d="M15.5 11.5l-3 3a3 3 0 1 1-4.2-4.2l2-2"></path>
      </svg>
    </span>`;
  }
  return `<span class="sftp-entry-icon file" aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20z"></path>
      <path d="M14 3.5V8h4"></path>
    </svg>
  </span>`;
}

const lastMetricAlerts = new Map();

function checkMetricAlerts(serverId, metrics) {
  if (!metrics) return;
  const server = SRV.find(s => s.id === serverId);
  const serverName = server ? (server.name || server.host) : serverId;

  const thresholds = [
    { key: 'cpu_used_percent', name: 'CPU', value: metrics.cpu_used_percent },
    { key: 'memory_used_percent', name: 'Memory', value: metrics.memory_used_percent },
    { key: 'disk_used_percent', name: 'Disk', value: metrics.disk_used_percent }
  ];

  const now = Date.now();
  const alertCooldownMs = 60000;

  thresholds.forEach(t => {
    const val = Number(t.value);
    if (Number.isFinite(val) && val >= 90.0) {
      const alertKey = `${serverId}-${t.key}`;
      const lastAlertTime = lastMetricAlerts.get(alertKey) || 0;
      if (now - lastAlertTime > alertCooldownMs) {
        lastMetricAlerts.set(alertKey, now);
        showToastWarning(`${serverName}: ${t.name} usage is high (${Math.round(val)}%)`);
      }
    }
  });
}

async function refreshMetrics(serverId) {
  const state = getLiveMetricsState(serverId);
  if (state.loading) return;

  state.loading = true;
  state.error = '';

  if (activeTabId === 'metrics' && selId === serverId) {
    renderMetrics(SRV.find(s => s.id === serverId));
  }

  try {
    const result = await invoke('ssh_probe_metrics', { serverId });
    state.data = result || null;
    state.lastUpdatedMs = Number(result?.fetched_unix_ms) || Date.now();
    state.error = '';
    checkMetricAlerts(serverId, result);
  } catch (e) {
    state.error = shortErrorText(e);
    state.lastUpdatedMs = Date.now();
  } finally {
    state.loading = false;
    if (activeTabId === 'metrics' && selId === serverId) {
      renderMetrics(SRV.find(s => s.id === serverId));
    }
  }
}

async function refreshServerIntel(server, force = false) {
  if (!server?.id || !server?.host) return;

  const state = getServerIntelState(server.id);
  const isStale = !state.lastUpdatedMs || (Date.now() - state.lastUpdatedMs) > SERVER_INTEL_REFRESH_INTERVAL_MS;
  if (!force && (state.loading || (state.data && !isStale))) return;

  state.loading = true;
  state.error = '';

  if (activeTabId === 'metrics' && selId === server.id) {
    renderMetrics(server);
  }

  try {
    const result = await invoke('lookup_ip_location', { host: server.host });
    state.data = result || null;
    state.lastUpdatedMs = Date.now();
    state.error = '';
  } catch (e) {
    state.error = shortErrorText(e);
  } finally {
    state.loading = false;
    if (activeTabId === 'metrics' && selId === server.id) {
      renderMetrics(server);
    }
  }
}

function renderMetrics(s) {
  if (!s) { showMEmpty(); return; }
  document.getElementById('m-empty').style.display = 'none';
  const mc = document.getElementById('m-content');
  mc.style.display = 'block';

  const liveState = getLiveMetricsState(s.id);
  const live = liveState.data || null;
  const intelState = getServerIntelState(s.id);
  const intel = intelState.data || null;
  const intelStale = !intelState.lastUpdatedMs || (Date.now() - intelState.lastUpdatedMs) > SERVER_INTEL_REFRESH_INTERVAL_MS;
  if (!intelState.loading && (!intel || intelStale)) {
    void refreshServerIntel(s);
  }

  // Real data from live SSH probe
  const osPretty = live?.os_pretty || [live?.os_name, live?.os_version].filter(Boolean).join(' ') || null;
  const kernel = live?.kernel || '';
  const hostLabel = live?.hostname || s.host;
  const cpu = Number.isFinite(Number(live?.cpu_used_percent)) ? clamp(Math.round(Number(live.cpu_used_percent)), 1, 99) : null;
  const ram = Number.isFinite(Number(live?.memory_used_percent)) ? clamp(Math.round(Number(live.memory_used_percent)), 1, 99) : null;
  const disk = Number.isFinite(Number(live?.disk_used_percent)) ? clamp(Math.round(Number(live.disk_used_percent)), 1, 99) : null;
  const uptimeSecondsLive = Number(live?.uptime_seconds);
  const uptimeDays = Number.isFinite(uptimeSecondsLive) ? Math.max(0, Math.floor(uptimeSecondsLive / 86400)) : null;
  const liveServices = Array.isArray(live?.services) ? live.services : [];
  const browserServices = liveServices.filter((service) => Boolean(service?.is_browser_supported)).length;
  const serviceScanError = typeof live?.services_error === 'string' ? live.services_error.trim() : '';
  const serviceRowsHtml = renderMetricsServiceRows(s, liveServices);
  const servicesStatusNoteRaw = live
    ? serviceScanError
      ? `Service scan warning: ${serviceScanError}`
      : liveServices.length
        ? `${liveServices.length} listening service${liveServices.length > 1 ? 's' : ''} · ${browserServices} web endpoint${browserServices === 1 ? '' : 's'}`
        : 'No listening services detected in latest scan.'
    : 'Press Refresh to load listening services.';

  // Status based on connection state
  const statusClass = s.status === 'online' ? 'st-online' : s.status === 'offline' ? 'st-offline' : 'st-warn';
  const statusLabel = s.status === 'online' ? 'ONLINE' : s.status === 'offline' ? 'OFFLINE' : 'UNKNOWN';
  const cpuColor = cpu !== null ? (cpu > 75 ? '#ff3b5c' : cpu > 55 ? '#f5a623' : '#00bfff') : '#666';
  const ramColor = ram !== null ? (ram > 80 ? '#ff3b5c' : ram > 60 ? '#f5a623' : '#00ffaa') : '#666';
  const liveLinked = hasLiveSshSessionForServer(s.id);
  const liveActive = liveLinked && metricsLiveEnabled;
  const refreshInfo = liveState.error
    ? `Refresh failed: ${escapeHtml(liveState.error)}`
    : liveActive
      ? `Live update every ${Math.round(METRICS_LIVE_REFRESH_INTERVAL_MS / 1000)}s · updated ${formatUpdatedAgo(liveState.lastUpdatedMs)}`
      : liveLinked
        ? `Live updates paused · updated ${formatUpdatedAgo(liveState.lastUpdatedMs)}`
        : liveState.lastUpdatedMs
          ? `Last update ${formatUpdatedAgo(liveState.lastUpdatedMs)} · manual refresh only`
          : 'No data yet · press Refresh';
  const metricsSource = liveActive ? 'Live telemetry' : (live ? 'Last captured' : 'No data');
  const osBadge = live?.os_name || 'Unknown';
  const kernelBadge = kernel || 'Unknown';
  const cpuCores = Number.isFinite(Number(live?.cpu_cores)) ? Math.max(1, Math.round(Number(live.cpu_cores))) : null;
  const totalMemory = formatMemoryMb(live?.memory_total_mb);
  const locationValue = s.loc || 'Unknown';
  const hasCoords = Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)) && !(Number(s.lat) === 0 && Number(s.lng) === 0);
  const coordValue = hasCoords ? `${Number(s.lat).toFixed(4)}, ${Number(s.lng).toFixed(4)}` : 'Unavailable';
  const specSource = live ? 'Specs from latest SSH refresh' : 'Press Refresh to load hardware specs';
  const whoisIp = intel?.ip || s.resolvedIp || 'Unavailable';
  const whoisLocation = intel?.location || locationValue || 'Unknown';
  const whoisProvider = intel?.provider || intel?.org || 'Unknown';
  const whoisOrg = intel?.org || 'Unavailable';
  const whoisAsn = intel?.asn || 'Unavailable';
  const whoisDomain = intel?.domain || 'Unavailable';
  const whoisSource = intel?.source || 'Lookup pending';
  const whoisStatus = intelState.loading
    ? 'Resolving IP ownership and provider...'
    : intelState.error
      ? `Whois lookup warning: ${escapeHtml(intelState.error)}`
      : `Whois updated ${formatUpdatedAgo(intelState.lastUpdatedMs)} via ${escapeHtml(whoisSource)}`;
  const attentionIssues = buildAttentionIssues({
    cpu,
    ram,
    disk,
    statusReason: s.statusReason,
  });

  const diskColor = disk !== null ? (disk > 80 ? '#ff3b5c' : disk > 65 ? '#f5a623' : '#00bfff') : '#444';

  mc.innerHTML = `
    <div class="mx-shell">
      <!-- Header -->
      <div class="mx-header">
        <div class="mx-header-left">
          <div class="mx-server-name">${escapeHtml(s.name)}</div>
          <div class="mx-server-location">${escapeHtml(locationValue)}</div>
          <div class="mx-server-meta">
            <span><span class="m-status ${statusClass}">${statusLabel}</span></span>
            ${osPretty ? `<span>${escapeHtml(osPretty)}</span>` : ''}
            ${uptimeDays !== null ? `<span>Uptime: ${uptimeDays}d</span>` : ''}
          </div>
        </div>
        <div class="mx-header-right">
          <div class="mx-header-actions">
            <button class="mx-btn ${metricsSensitiveMasked ? 'is-active' : ''}" id="mx-mask-toggle-btn">
              ${metricsSensitiveMasked ? 'Show Values' : 'Hide Values'}
            </button>
            <button class="mx-btn ${liveActive ? 'is-active' : ''}" id="mx-live-toggle-btn" ${liveLinked ? '' : 'disabled'}>
              Live: ${liveActive ? 'On' : 'Off'}
            </button>
            <button class="mx-btn is-primary ${liveState.loading ? 'is-loading' : ''}" id="mx-refresh-btn" ${liveState.loading ? 'disabled' : ''}>
              ${liveState.loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
          <div class="mx-refresh-info ${liveState.error ? 'is-error' : ''}">${refreshInfo}</div>
        </div>
      </div>

      <!-- Resource Gauges -->
      <div class="mx-gauges">
        <div class="mx-gauge">
          <div class="mx-gauge-ring" style="--pct:${cpu ?? 0};--col:${cpuColor}">
            <span class="mx-gauge-value">${cpu !== null ? `${cpu}%` : '\u2014'}</span>
          </div>
          <div class="mx-gauge-label">CPU Usage</div>
          <div class="mx-gauge-sub">${cpu !== null ? `${100 - cpu}% available` : ''}</div>
          ${cpu === null ? '<div class="mx-gauge-empty">No data</div>' : ''}
        </div>
        <div class="mx-gauge">
          <div class="mx-gauge-ring" style="--pct:${ram ?? 0};--col:${ramColor}">
            <span class="mx-gauge-value">${ram !== null ? `${ram}%` : '\u2014'}</span>
          </div>
          <div class="mx-gauge-label">Memory Usage</div>
          <div class="mx-gauge-sub">${ram !== null ? `${100 - ram}% free` : ''}</div>
          ${ram === null ? '<div class="mx-gauge-empty">No data</div>' : ''}
        </div>
        <div class="mx-gauge">
          <div class="mx-gauge-ring" style="--pct:${disk ?? 0};--col:${diskColor}">
            <span class="mx-gauge-value">${disk !== null ? `${disk}%` : '\u2014'}</span>
          </div>
          <div class="mx-gauge-label">Disk Usage</div>
          <div class="mx-gauge-sub">${disk !== null ? `${100 - disk}% free` : ''}</div>
          ${disk === null ? '<div class="mx-gauge-empty">No data</div>' : ''}
        </div>
      </div>

      <!-- Info Cards -->
      <div class="mx-cards">
        <!-- System Specs -->
        <div class="mx-card">
          <div class="mx-card-title">System Specs</div>
          <div class="mx-card-rows">
            <div class="mx-row">
              <span class="mx-row-label">Host</span>
              <span class="mx-row-value">${renderSensitiveValue(hostLabel)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">OS</span>
              <span class="mx-row-value">${escapeHtml(osBadge)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">Kernel</span>
              <span class="mx-row-value">${escapeHtml(kernelBadge)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">CPU Cores</span>
              <span class="mx-row-value">${cpuCores ?? '\u2014'}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">Memory</span>
              <span class="mx-row-value">${totalMemory}</span>
            </div>
          </div>
          <div class="mx-card-note">${specSource}</div>
        </div>

        <!-- Network Info -->
        <div class="mx-card">
          <div class="mx-card-title">Network Info</div>
          <div class="mx-card-rows">
            <div class="mx-row">
              <span class="mx-row-label">IP Address</span>
              <span class="mx-row-value">${renderSensitiveValue(whoisIp)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">Provider</span>
              <span class="mx-row-value">${escapeHtml(whoisProvider)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">Organization</span>
              <span class="mx-row-value">${escapeHtml(whoisOrg)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">ASN</span>
              <span class="mx-row-value">${escapeHtml(whoisAsn)}</span>
            </div>
            <div class="mx-row">
              <span class="mx-row-label">Location</span>
              <span class="mx-row-value">${escapeHtml(whoisLocation)}</span>
            </div>
          </div>
          <div class="mx-card-note">${whoisStatus}</div>
        </div>

        <!-- Open Services -->
        <div class="mx-card">
          <div class="mx-card-title">Open Services</div>
          <div class="mx-services">
            ${liveServices.length > 0 ? liveServices.map((svc) => `
              <div class="mx-service">
                <div class="mx-service-info">
                  <div class="mx-service-name">${escapeHtml(svc.name || 'Unknown')}</div>
                  <div class="mx-service-port">${escapeHtml(svc.addr || '')}:${svc.port || ''}</div>
                </div>
                ${svc.is_browser_supported ? `<button class="mx-service-btn mx-service-open-btn" data-open-url="${encodeURIComponent(`http://${s.host}:${svc.port}`)}">Open</button>` : ''}
              </div>
            `).join('') : `<div class="mx-service-empty">${escapeHtml(servicesStatusNoteRaw)}</div>`}
          </div>
        </div>

        <!-- Alerts -->
        <div class="mx-card">
          <div class="mx-card-title">Alerts</div>
          <div class="mx-alerts">
            ${attentionIssues.map((item) => `
              <div class="mx-alert ${item.severity}">
                <span class="mx-alert-dot"></span>
                <span class="mx-alert-text">${escapeHtml(item.message)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Capacity -->
        <div class="mx-card" style="grid-column: span 2">
          <div class="mx-card-title">Resource Capacity</div>
          ${cpu !== null || ram !== null || disk !== null ? `
            <div class="mx-capacity">
              ${cpu !== null ? `
                <div class="mx-cap-item">
                  <span class="mx-cap-label">CPU</span>
                  <div class="mx-cap-bar"><div style="width:${cpu}%;background:${cpuColor}"></div></div>
                  <span class="mx-cap-value">${cpu}%</span>
                </div>
              ` : ''}
              ${ram !== null ? `
                <div class="mx-cap-item">
                  <span class="mx-cap-label">Memory</span>
                  <div class="mx-cap-bar"><div style="width:${ram}%;background:${ramColor}"></div></div>
                  <span class="mx-cap-value">${ram}%</span>
                </div>
              ` : ''}
              ${disk !== null ? `
                <div class="mx-cap-item">
                  <span class="mx-cap-label">Disk</span>
                  <div class="mx-cap-bar"><div style="width:${disk}%;background:${diskColor}"></div></div>
                  <span class="mx-cap-value">${disk}%</span>
                </div>
              ` : ''}
            </div>
          ` : '<div class="mx-card-note">Connect via SSH to view resource data</div>'}
        </div>
      </div>

      <!-- Footer -->
      <div class="mx-footer">
        <div class="mx-footer-text">
          Live metrics are available when connected via SSH. Without an active connection, data will show the last captured values.
        </div>
      </div>
    </div>`;

  const refreshBtn = document.getElementById('mx-refresh-btn');
  const maskBtn = document.getElementById('mx-mask-toggle-btn');
  const liveBtn = document.getElementById('mx-live-toggle-btn');
  if (maskBtn) maskBtn.addEventListener('click', () => {
    metricsSensitiveMasked = !metricsSensitiveMasked;
    renderMetrics(s);
  });
  if (liveBtn) liveBtn.addEventListener('click', () => {
    if (!hasLiveSshSessionForServer(s.id)) return;
    metricsLiveEnabled = !metricsLiveEnabled;
    if (metricsLiveEnabled) {
      void refreshMetrics(s.id);
    }
    renderMetrics(s);
  });
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    void refreshMetrics(s.id);
    void refreshServerIntel(s, true);
  });
  mc.querySelectorAll('.mx-service-open-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const encoded = button.getAttribute('data-open-url') || '';
      if (!encoded) return;
      let url = '';
      try {
        url = decodeURIComponent(encoded);
      } catch {
        url = encoded;
      }
      void openServiceInBrowser(url);
    });
  });
}

/* ══════════════════════════════════════════════════════════
   SIDEBAR COLLAPSE (desktop)
══════════════════════════════════════════════════════════ */
function toggleSidebar_collapse() {
  layoutController?.toggleSidebarCollapse();
}

function toggleSidebar(force) {
  layoutController?.toggleSidebar(force);
}

function refreshRailActive() {
  layoutController?.refreshRailActive();
}

function toggleMap() {
  layoutController?.toggleMap();
}

function toggleMaximize() {
  layoutController?.toggleMaximize();
}

const SESSION_MODAL_STATE = {
  mode: 'create',
  shortcutId: null,
};

function createSessionModal() {
  if (document.getElementById('session-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'session-modal';
  modal.innerHTML = `
    <div class="session-overlay" id="session-overlay"></div>
    <div class="session-panel" id="session-panel">
      <div class="session-header">
        <span class="session-title">+ Session Launcher</span>
        <button class="session-close-btn" id="session-close-btn">×</button>
      </div>
      <div class="session-body">
        <div class="session-hint" id="session-hint">Choose a session type, then provide connection details.</div>
        <div class="session-row">
          <label class="session-label">Session Type</label>
          <select class="session-input" id="session-type">
            <option value="local_shell">Local Shell</option>
            <option value="ssh">SSH</option>
            <option value="telnet">Telnet</option>
            <option value="sftp">SFTP Browser</option>
            <option value="rsh">RSH</option>
            <option value="mosh">Mosh</option>
            <option value="rdp">RDP</option>
            <option value="vnc">VNC</option>
            <option value="ftp">FTP</option>
            <option value="serial">Serial</option>
            <option value="wsl_shell">WSL</option>
          </select>
        </div>
        <div class="session-row" id="session-local-shell-row" style="display:none">
          <label class="session-label">Local Shell</label>
          <select class="session-input" id="session-local-shell">
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
            <option value="wsl">WSL</option>
            <option value="bash">Bash</option>
            <option value="zsh">Zsh</option>
          </select>
        </div>
        <div class="session-row" id="session-server-row" style="display:none">
          <label class="session-label" id="session-server-label">Server</label>
          <select class="session-input" id="session-server"></select>
        </div>
        <div class="session-row" id="session-ssh-config-row" style="display:none">
          <label class="session-label">SSH Source</label>
          <select class="session-input" id="session-ssh-config-source">
            <option value="saved">Saved SSH Profile</option>
            <option value="new">New Server</option>
          </select>
        </div>
        <div id="session-ssh-new-config" style="display:none">
          <div class="session-row">
            <label class="session-label">Remote Host</label>
            <input class="session-input" id="session-ssh-host" placeholder="e.g. 203.0.113.10">
          </div>
          <div class="session-row session-row-inline">
            <div class="session-col">
              <label class="session-label">Username (optional)</label>
              <input class="session-input" id="session-ssh-username" placeholder="Leave blank to ask in terminal">
            </div>
            <div class="session-col session-col-sm">
              <label class="session-label">Port</label>
              <input class="session-input" id="session-ssh-port" type="number" min="1" max="65535" value="22">
            </div>
          </div>
        </div>
        <div class="session-row" id="session-telnet-config-row" style="display:none">
          <label class="session-label">Configuration</label>
          <select class="session-input" id="session-telnet-config-source">
            <option value="saved">Saved Telnet Profile</option>
            <option value="new">New Configuration</option>
          </select>
        </div>
        <div id="session-telnet-new-config" style="display:none">
          <div class="session-row">
            <label class="session-label">Remote Host</label>
            <input class="session-input" id="session-telnet-host" placeholder="e.g. 192.0.2.15">
          </div>
          <div class="session-row session-row-inline">
            <div class="session-col">
              <label class="session-label">Username (optional)</label>
              <input class="session-input" id="session-telnet-username" placeholder="Leave empty if not needed">
            </div>
            <div class="session-col session-col-sm">
              <label class="session-label">Port</label>
              <input class="session-input" id="session-telnet-port" type="number" min="1" max="65535" value="23">
            </div>
          </div>
        </div>
        <div class="session-row" id="session-sftp-credential-row" style="display:none">
          <label class="session-label">Credentials</label>
          <select class="session-input" id="session-sftp-credential-source">
            <option value="saved">Saved SSH Profile</option>
            <option value="new">New Credentials</option>
          </select>
        </div>
        <div id="session-sftp-new-credentials" style="display:none">
          <div class="session-row">
            <label class="session-label">Remote Host</label>
            <input class="session-input" id="session-sftp-host" placeholder="e.g. 203.0.113.10">
          </div>
          <div class="session-row session-row-inline">
            <div class="session-col">
              <label class="session-label">Username</label>
              <input class="session-input" id="session-sftp-username" placeholder="e.g. root">
            </div>
            <div class="session-col session-col-sm">
              <label class="session-label">Port</label>
              <input class="session-input" id="session-sftp-port" type="number" min="1" max="65535" value="22">
            </div>
          </div>
          <div class="session-row">
            <label class="session-label">Authentication</label>
            <select class="session-input" id="session-sftp-auth-method">
              <option value="Password">Password</option>
              <option value="Key">SSH Key</option>
            </select>
          </div>
          <div class="session-row" id="session-sftp-password-row">
            <label class="session-label">Password</label>
            <input class="session-input" id="session-sftp-password" type="password" placeholder="Remote account password">
          </div>
          <div class="session-row" id="session-sftp-key-row" style="display:none">
            <label class="session-label">SSH Key Path</label>
            <div class="session-inline">
              <input class="session-input" id="session-sftp-key-path" placeholder="~/.ssh/id_ed25519">
              <button class="sf-browse-btn" id="session-sftp-key-browse-btn">Browse</button>
            </div>
          </div>
          <div class="session-row" id="session-sftp-passphrase-row" style="display:none">
            <label class="session-label">Key Passphrase (optional)</label>
            <input class="session-input" id="session-sftp-passphrase" type="password" placeholder="Leave empty if none">
          </div>
        </div>
        <div class="session-row" id="session-username-row" style="display:none">
          <label class="session-label">Username Override (optional)</label>
          <input class="session-input" id="session-username" placeholder="Leave empty to use saved username">
        </div>
        <div class="session-row" id="session-force-username-row" style="display:none">
          <label class="session-check">
            <input type="checkbox" id="session-force-username">
            <span>Prompt for username on connect</span>
          </label>
        </div>
        <div id="session-vnc-config" style="display:none">
          <div class="session-row">
            <label class="session-label">VNC Host</label>
            <input class="session-input" id="session-vnc-host" placeholder="e.g. 192.0.2.50">
          </div>
          <div class="session-row session-row-inline">
            <div class="session-col session-col-sm">
              <label class="session-label">VNC Port</label>
              <input class="session-input" id="session-vnc-port" type="number" min="1" max="65535" value="5900">
            </div>
            <div class="session-col">
              <label class="session-label">Password (optional)</label>
              <input class="session-input" id="session-vnc-password" type="password" placeholder="Leave empty if none">
            </div>
          </div>
        </div>
        <div id="session-external-config" style="display:none">
          <div class="session-row" id="session-external-host-row">
            <label class="session-label" id="session-external-host-label">Remote Host</label>
            <input class="session-input" id="session-external-host" placeholder="e.g. 192.0.2.25">
          </div>
          <div class="session-row session-row-inline" id="session-external-port-row">
            <div class="session-col session-col-sm">
              <label class="session-label" id="session-external-port-label">Port</label>
              <input class="session-input" id="session-external-port" type="number" min="1" max="65535" value="22">
            </div>
            <div class="session-col" id="session-external-username-row" style="display:none">
              <label class="session-label" id="session-external-username-label">Username (optional)</label>
              <input class="session-input" id="session-external-username" placeholder="Leave empty if not needed">
            </div>
          </div>
          <div class="session-row" id="session-external-password-row" style="display:none">
            <label class="session-label" id="session-external-password-label">Password (optional)</label>
            <input class="session-input" id="session-external-password" type="password" placeholder="Optional">
          </div>
          <div class="session-row" id="session-external-serial-port-row" style="display:none">
            <label class="session-label">Serial Port</label>
            <input class="session-input" id="session-external-serial-port" placeholder="e.g. COM3 or /dev/ttyUSB0">
          </div>
          <div class="session-row" id="session-external-baud-row" style="display:none">
            <label class="session-label">Baud Rate</label>
            <input class="session-input" id="session-external-baud" type="number" min="50" max="921600" value="115200">
          </div>
          <div class="session-row">
            <div class="session-hint">These launch via local tools (PowerShell + installed client binaries).</div>
          </div>
        </div>
      </div>
      <div class="session-error" id="session-error" style="display:none"></div>
      <div class="session-actions">
        <button class="session-cancel-btn" id="session-cancel-btn">Cancel</button>
        <button class="session-start-btn" id="session-start-btn">Start Session</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('session-overlay').addEventListener('click', closeSessionModal);
  document.getElementById('session-close-btn').addEventListener('click', closeSessionModal);
  document.getElementById('session-cancel-btn').addEventListener('click', closeSessionModal);
  document.getElementById('session-type').addEventListener('change', renderSessionModalFields);
  document.getElementById('session-ssh-config-source').addEventListener('change', renderSessionModalFields);
  document.getElementById('session-telnet-config-source').addEventListener('change', renderSessionModalFields);
  document.getElementById('session-sftp-credential-source').addEventListener('change', renderSessionModalFields);
  document.getElementById('session-sftp-auth-method').addEventListener('change', renderSessionModalFields);
  document.getElementById('session-sftp-key-browse-btn').addEventListener('click', browseSessionSftpKeyFile);
  document.getElementById('session-start-btn').addEventListener('click', () => {
    void startSessionFromModal();
  });
}

async function browseSessionSftpKeyFile() {
  try {
    const selected = await open({
      multiple: false,
      title: 'Select SSH Key',
    });
    if (selected) {
      const keyPathEl = document.getElementById('session-sftp-key-path');
      if (keyPathEl) keyPathEl.value = String(selected);
    }
  } catch (e) {
    console.error('Session key picker error:', e);
  }
}

function isExternalLauncherSession(type) {
  // VNC is now embedded, not external
  return type === 'rsh'
    || type === 'mosh'
    || type === 'rdp'
    || type === 'ftp'
    || type === 'serial';
}

function psQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

async function waitForLocalSessionId(tabId, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = termTabs[tabId];
    if (!tab) break;
    if (tab.sessionId) return tab.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function launchExternalCommandSession(commandText) {
  const tabId = addLocalTermTab('powershell');
  if (!tabId) throw new Error('Failed to open launcher terminal.');
  const sessionId = await waitForLocalSessionId(tabId);
  if (!sessionId) throw new Error('Launcher terminal did not become ready in time.');
  await invoke('local_shell_write_text', { sessionId, data: `${commandText}\r` });
}

function buildExternalSessionCommand(type, options) {
  const host = String(options?.host || '').trim();
  const username = String(options?.username || '').trim();
  const password = String(options?.password || '');
  const port = Number(options?.port || 0);
  const serialPort = String(options?.serialPort || '').trim();
  const baud = Number(options?.baud || 0);

  if (type === 'rdp') {
    const endpoint = port && port !== 3389 ? `${host}:${port}` : host;
    return `Start-Process -FilePath 'mstsc.exe' -ArgumentList '/v:${endpoint}'`;
  }

  // VNC is now embedded, no external command needed

  if (type === 'ftp') {
    const effectivePort = port || 21;
    const authPrefix = username
      ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
      : '';
    const url = `ftp://${authPrefix}${host}:${effectivePort}/`;
    return `Start-Process -FilePath 'explorer.exe' -ArgumentList ${psQuote(url)}`;
  }

  if (type === 'serial') {
    const endpoint = serialPort;
    const serialConfig = `${baud || 115200},8,n,1,N`;
    return [
      '$putty = Get-Command putty -ErrorAction SilentlyContinue',
      'if ($putty) {',
      `  & $putty.Source -serial ${psQuote(endpoint)} -sercfg ${psQuote(serialConfig)}`,
      '} else {',
      `  Write-Host ${psQuote('[nodegrid] PuTTY not found in PATH. Install PuTTY and retry serial launch.')}`,
      '}',
    ].join('\n');
  }

  if (type === 'rsh') {
    const args = [];
    if (username) args.push(`-l ${psQuote(username)}`);
    args.push(psQuote(host));
    return [
      '$rsh = Get-Command rsh -ErrorAction SilentlyContinue',
      'if ($rsh) {',
      `  & $rsh.Source ${args.join(' ')}`,
      '} else {',
      `  Write-Host ${psQuote('[nodegrid] rsh not found in PATH. Install an rsh client and retry.')}`,
      '}',
    ].join('\n');
  }

  if (type === 'mosh') {
    const effectivePort = port || 22;
    const target = username ? `${username}@${host}` : host;
    return [
      '$mosh = Get-Command mosh -ErrorAction SilentlyContinue',
      'if ($mosh) {',
      `  & $mosh.Source ${psQuote(target)} --ssh=${psQuote(`ssh -p ${effectivePort}`)}`,
      '} else {',
      `  Write-Host ${psQuote('[nodegrid] mosh not found in PATH. Install mosh and retry.')}`,
      '}',
    ].join('\n');
  }

  return '';
}

function sessionServersForType(type) {
  if (type === 'ssh' || type === 'sftp') {
    return SRV.filter((s) => serverProtocol(s) === 'ssh');
  }
  if (type === 'telnet') {
    return SRV.filter((s) => serverProtocol(s) === 'telnet');
  }
  return [];
}

function sessionHintForType(type) {
  if (type === 'ssh') return 'Launch SSH from a saved profile or create a new server with host/port.';
  if (type === 'telnet') return 'Launch Telnet using a saved profile or enter new connection details.';
  if (type === 'sftp') return 'Open SFTP using a saved SSH profile or enter new credentials.';
  if (type === 'wsl_shell') return 'Start a local WSL shell tab (falls back automatically when WSL is unavailable).';
  if (type === 'rdp') return 'Launch Windows Remote Desktop (mstsc) to the target host.';
  if (type === 'vnc') return 'Open embedded VNC viewer for the target endpoint.';
  if (type === 'ftp') return 'Open FTP target in system explorer/browser.';
  if (type === 'serial') return 'Launch serial connection via PuTTY (putty).';
  if (type === 'rsh') return 'Launch RSH from local shell (requires rsh client in PATH).';
  if (type === 'mosh') return 'Launch MOSH from local shell (requires mosh client in PATH).';
  return 'Start a local terminal session on this machine.';
}

function renderSessionModalFields() {
  const type = String(document.getElementById('session-type')?.value || 'local_shell');
  const localRow = document.getElementById('session-local-shell-row');
  const serverRow = document.getElementById('session-server-row');
  const serverLabel = document.getElementById('session-server-label');
  const serverSelect = document.getElementById('session-server');
  const sshConfigRow = document.getElementById('session-ssh-config-row');
  const sshConfigSource = document.getElementById('session-ssh-config-source');
  const sshNewConfig = document.getElementById('session-ssh-new-config');
  const telnetConfigRow = document.getElementById('session-telnet-config-row');
  const telnetConfigSource = document.getElementById('session-telnet-config-source');
  const telnetNewConfig = document.getElementById('session-telnet-new-config');
  const sftpCredentialRow = document.getElementById('session-sftp-credential-row');
  const sftpCredentialSource = document.getElementById('session-sftp-credential-source');
  const sftpNewCredentials = document.getElementById('session-sftp-new-credentials');
  const sftpAuthMethodEl = document.getElementById('session-sftp-auth-method');
  const sftpPasswordRow = document.getElementById('session-sftp-password-row');
  const sftpKeyRow = document.getElementById('session-sftp-key-row');
  const sftpPassphraseRow = document.getElementById('session-sftp-passphrase-row');
  const usernameRow = document.getElementById('session-username-row');
  const forceRow = document.getElementById('session-force-username-row');
  const externalWrap = document.getElementById('session-external-config');
  const externalHostRow = document.getElementById('session-external-host-row');
  const externalHostLabel = document.getElementById('session-external-host-label');
  const externalHostInput = document.getElementById('session-external-host');
  const externalPortRow = document.getElementById('session-external-port-row');
  const externalPortLabel = document.getElementById('session-external-port-label');
  const externalPortInput = document.getElementById('session-external-port');
  const externalUsernameRow = document.getElementById('session-external-username-row');
  const externalPasswordRow = document.getElementById('session-external-password-row');
  const externalPasswordLabel = document.getElementById('session-external-password-label');
  const externalSerialPortRow = document.getElementById('session-external-serial-port-row');
  const externalBaudRow = document.getElementById('session-external-baud-row');
  const vncConfig = document.getElementById('session-vnc-config');
  const hint = document.getElementById('session-hint');
  const errorEl = document.getElementById('session-error');

  if (hint) hint.textContent = sessionHintForType(type);
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  const isLocal = type === 'local_shell';
  const isSsh = type === 'ssh';
  const sshSource = String(sshConfigSource?.value || 'saved');
  const isSshNew = isSsh && sshSource === 'new';
  const isTelnet = type === 'telnet';
  const isSftp = type === 'sftp';
  const isWsl = type === 'wsl_shell';
  const isVnc = type === 'vnc';
  const isExternal = isExternalLauncherSession(type);
  const telnetSource = String(telnetConfigSource?.value || 'saved');
  const isTelnetNew = isTelnet && telnetSource === 'new';
  const sftpSource = String(sftpCredentialSource?.value || 'saved');
  const isSftpNew = isSftp && sftpSource === 'new';
  const needsServer = !isLocal && !isWsl && !isExternal && !isSshNew && !isTelnetNew && !isSftpNew && !isVnc;
  const sftpAuthMethod = String(sftpAuthMethodEl?.value || 'Password');
  const useSftpKey = isSftpNew && sftpAuthMethod === 'Key';

  if (localRow) localRow.style.display = isLocal ? '' : 'none';
  if (sshConfigRow) sshConfigRow.style.display = isSsh ? '' : 'none';
  if (sshNewConfig) sshNewConfig.style.display = isSshNew ? '' : 'none';
  if (telnetConfigRow) telnetConfigRow.style.display = isTelnet ? '' : 'none';
  if (telnetNewConfig) telnetNewConfig.style.display = isTelnetNew ? '' : 'none';
  if (sftpCredentialRow) sftpCredentialRow.style.display = isSftp ? '' : 'none';
  if (sftpNewCredentials) sftpNewCredentials.style.display = isSftpNew ? '' : 'none';
  if (sftpPasswordRow) sftpPasswordRow.style.display = isSftpNew && !useSftpKey ? '' : 'none';
  if (sftpKeyRow) sftpKeyRow.style.display = useSftpKey ? '' : 'none';
  if (sftpPassphraseRow) sftpPassphraseRow.style.display = useSftpKey ? '' : 'none';
  if (serverRow) serverRow.style.display = needsServer ? '' : 'none';
  if (usernameRow) usernameRow.style.display = isSsh && !isSshNew ? '' : 'none';
  if (forceRow) forceRow.style.display = isSsh && !isSshNew ? '' : 'none';
  if (vncConfig) vncConfig.style.display = isVnc ? '' : 'none';
  if (externalWrap) externalWrap.style.display = isExternal ? '' : 'none';
  if (externalHostRow) externalHostRow.style.display = type === 'serial' ? 'none' : '';
  if (externalPortRow) externalPortRow.style.display = (type === 'serial' || type === 'rsh') ? 'none' : '';
  if (externalUsernameRow) {
    const needsUser = type === 'rsh' || type === 'mosh' || type === 'ftp';
    externalUsernameRow.style.display = needsUser ? '' : 'none';
  }
  if (externalPasswordRow) externalPasswordRow.style.display = type === 'ftp' ? '' : 'none';
  if (externalSerialPortRow) externalSerialPortRow.style.display = type === 'serial' ? '' : 'none';
  if (externalBaudRow) externalBaudRow.style.display = type === 'serial' ? '' : 'none';

  if (isExternal) {
    if (externalHostLabel) externalHostLabel.textContent = type === 'ftp' ? 'FTP Host' : 'Remote Host';
    if (externalPortLabel) {
      externalPortLabel.textContent = type === 'mosh'
        ? 'SSH Port'
        : type === 'rdp'
          ? 'RDP Port'
          : type === 'vnc'
            ? 'VNC Port'
            : type === 'ftp'
              ? 'FTP Port'
              : 'Port';
    }
    if (externalPortInput) {
      const defaults = { mosh: '22', rdp: '3389', vnc: '5900', ftp: '21' };
      if (!String(externalPortInput.value || '').trim()) externalPortInput.value = defaults[type] || '';
    }
    if (externalHostInput) {
      const placeholders = {
        rsh: 'e.g. 192.0.2.25',
        mosh: 'e.g. 203.0.113.8',
        rdp: 'e.g. windows-server.local',
        vnc: 'e.g. 192.0.2.50',
        ftp: 'e.g. files.example.com',
      };
      externalHostInput.placeholder = placeholders[type] || 'e.g. 192.0.2.25';
    }
    if (externalPasswordLabel) externalPasswordLabel.textContent = 'Password (optional, for FTP URL auth)';
  }

  if (!needsServer || !serverSelect) return;

  if (serverLabel) {
    serverLabel.textContent = type === 'telnet' ? 'Telnet Server' : type === 'sftp' ? 'SFTP Server (SSH)' : 'SSH Server';
  }

  const servers = sessionServersForType(type);
  const preferred = (selId && servers.some((s) => s.id === selId))
    ? selId
    : (servers[0]?.id || '');

  if (!servers.length) {
    const msg = type === 'telnet' ? 'No Telnet servers configured' : 'No SSH servers configured';
    serverSelect.innerHTML = `<option value="">${msg}</option>`;
    serverSelect.value = '';
    return;
  }

  serverSelect.innerHTML = servers
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.host)}:${s.port})</option>`)
    .join('');
  serverSelect.value = preferred;
}

function openSessionModal(initialType = 'local_shell', options = {}) {
  createSessionModal();
  const modal = document.getElementById('session-modal');
  if (!modal) return;
  const shortcut = options?.shortcut || null;
  SESSION_MODAL_STATE.mode = shortcut ? 'edit-shortcut' : 'create';
  SESSION_MODAL_STATE.shortcutId = shortcut?.id || null;

  const typeEl = document.getElementById('session-type');
  const localShellEl = document.getElementById('session-local-shell');
  const usernameEl = document.getElementById('session-username');
  const forceEl = document.getElementById('session-force-username');
  const sshConfigSourceEl = document.getElementById('session-ssh-config-source');
  const sshHostEl = document.getElementById('session-ssh-host');
  const sshUsernameEl = document.getElementById('session-ssh-username');
  const sshPortEl = document.getElementById('session-ssh-port');
  const telnetConfigSourceEl = document.getElementById('session-telnet-config-source');
  const telnetHostEl = document.getElementById('session-telnet-host');
  const telnetUsernameEl = document.getElementById('session-telnet-username');
  const telnetPortEl = document.getElementById('session-telnet-port');
  const externalHostEl = document.getElementById('session-external-host');
  const externalPortEl = document.getElementById('session-external-port');
  const externalUsernameEl = document.getElementById('session-external-username');
  const externalPasswordEl = document.getElementById('session-external-password');
  const externalSerialPortEl = document.getElementById('session-external-serial-port');
  const externalBaudEl = document.getElementById('session-external-baud');
  const sftpCredentialSourceEl = document.getElementById('session-sftp-credential-source');
  const sftpHostEl = document.getElementById('session-sftp-host');
  const sftpUsernameEl = document.getElementById('session-sftp-username');
  const sftpPortEl = document.getElementById('session-sftp-port');
  const sftpAuthEl = document.getElementById('session-sftp-auth-method');
  const sftpPasswordEl = document.getElementById('session-sftp-password');
  const sftpKeyPathEl = document.getElementById('session-sftp-key-path');
  const sftpPassphraseEl = document.getElementById('session-sftp-passphrase');
  const vncHostEl = document.getElementById('session-vnc-host');
  const vncPortEl = document.getElementById('session-vnc-port');
  const vncPasswordEl = document.getElementById('session-vnc-password');
  const errorEl = document.getElementById('session-error');
  const startBtn = document.getElementById('session-start-btn');

  if (typeEl) typeEl.value = shortcut?.type || initialType;
  if (localShellEl) localShellEl.value = 'powershell';
  if (usernameEl) usernameEl.value = '';
  if (forceEl) forceEl.checked = false;
  if (sshConfigSourceEl) sshConfigSourceEl.value = 'saved';
  if (sshHostEl) sshHostEl.value = '';
  if (sshUsernameEl) sshUsernameEl.value = '';
  if (sshPortEl) sshPortEl.value = '22';
  if (telnetConfigSourceEl) telnetConfigSourceEl.value = 'saved';
  if (telnetHostEl) telnetHostEl.value = '';
  if (telnetUsernameEl) telnetUsernameEl.value = '';
  if (telnetPortEl) telnetPortEl.value = '23';
  if (externalHostEl) externalHostEl.value = '';
  if (externalPortEl) externalPortEl.value = '';
  if (externalUsernameEl) externalUsernameEl.value = '';
  if (externalPasswordEl) externalPasswordEl.value = '';
  if (externalSerialPortEl) externalSerialPortEl.value = '';
  if (externalBaudEl) externalBaudEl.value = '115200';
  if (sftpCredentialSourceEl) sftpCredentialSourceEl.value = 'saved';
  if (sftpHostEl) sftpHostEl.value = '';
  if (sftpUsernameEl) sftpUsernameEl.value = '';
  if (sftpPortEl) sftpPortEl.value = '22';
  if (sftpAuthEl) sftpAuthEl.value = 'Password';
  if (sftpPasswordEl) sftpPasswordEl.value = '';
  if (sftpKeyPathEl) sftpKeyPathEl.value = '';
  if (sftpPassphraseEl) sftpPassphraseEl.value = '';
  if (vncHostEl) vncHostEl.value = '';
  if (vncPortEl) vncPortEl.value = '5900';
  if (vncPasswordEl) vncPasswordEl.value = '';
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }
  if (startBtn) startBtn.textContent = shortcut ? 'Save Shortcut' : 'Start Session';

  if (shortcut) {
    const payload = shortcut.payload || {};
    if (localShellEl) localShellEl.value = normalizeLocalShellType(payload.shellType || 'powershell');
    if (externalHostEl) externalHostEl.value = String(payload.host || '');
    if (externalPortEl) externalPortEl.value = payload.port ? String(payload.port) : '';
    if (externalUsernameEl) externalUsernameEl.value = String(payload.username || '');
    if (externalPasswordEl) externalPasswordEl.value = String(payload.password || '');
    if (externalSerialPortEl) externalSerialPortEl.value = String(payload.serialPort || '');
    if (externalBaudEl) externalBaudEl.value = payload.baud ? String(payload.baud) : '115200';
    if (vncHostEl) vncHostEl.value = String(payload.host || '');
    if (vncPortEl) vncPortEl.value = payload.port ? String(payload.port) : '5900';
    if (vncPasswordEl) vncPasswordEl.value = String(payload.password || '');
  }

  renderSessionModalFields();
  modal.style.display = 'block';
}

function closeSessionModal() {
  const modal = document.getElementById('session-modal');
  if (!modal) return;
  SESSION_MODAL_STATE.mode = 'create';
  SESSION_MODAL_STATE.shortcutId = null;
  const startBtn = document.getElementById('session-start-btn');
  if (startBtn) startBtn.textContent = 'Start Session';
  modal.style.display = 'none';
}

async function startSessionFromModal() {
  const type = String(document.getElementById('session-type')?.value || 'local_shell');
  const serverId = String(document.getElementById('session-server')?.value || '').trim();
  const username = String(document.getElementById('session-username')?.value || '').trim();
  const forcePrompt = Boolean(document.getElementById('session-force-username')?.checked);
  const sshConfigSource = String(document.getElementById('session-ssh-config-source')?.value || 'saved');
  const sshHost = String(document.getElementById('session-ssh-host')?.value || '').trim();
  const sshUsername = String(document.getElementById('session-ssh-username')?.value || '').trim();
  const sshPortRaw = String(document.getElementById('session-ssh-port')?.value || '22').trim();
  const telnetConfigSource = String(document.getElementById('session-telnet-config-source')?.value || 'saved');
  const telnetHost = String(document.getElementById('session-telnet-host')?.value || '').trim();
  const telnetUsername = String(document.getElementById('session-telnet-username')?.value || '').trim();
  const telnetPortRaw = String(document.getElementById('session-telnet-port')?.value || '23').trim();
  const externalHost = String(document.getElementById('session-external-host')?.value || '').trim();
  const externalPortRaw = String(document.getElementById('session-external-port')?.value || '').trim();
  const externalUsername = String(document.getElementById('session-external-username')?.value || '').trim();
  const externalPassword = String(document.getElementById('session-external-password')?.value || '');
  const externalSerialPort = String(document.getElementById('session-external-serial-port')?.value || '').trim();
  const externalBaudRaw = String(document.getElementById('session-external-baud')?.value || '115200').trim();
  const sftpCredentialSource = String(document.getElementById('session-sftp-credential-source')?.value || 'saved');
  const sftpHost = String(document.getElementById('session-sftp-host')?.value || '').trim();
  const sftpUsername = String(document.getElementById('session-sftp-username')?.value || '').trim();
  const sftpPortRaw = String(document.getElementById('session-sftp-port')?.value || '22').trim();
  const sftpAuthMethod = String(document.getElementById('session-sftp-auth-method')?.value || 'Password');
  const sftpPassword = String(document.getElementById('session-sftp-password')?.value || '');
  const sftpKeyPath = String(document.getElementById('session-sftp-key-path')?.value || '').trim();
  const sftpPassphrase = String(document.getElementById('session-sftp-passphrase')?.value || '');
  const vncHost = String(document.getElementById('session-vnc-host')?.value || '').trim();
  const vncPortRaw = String(document.getElementById('session-vnc-port')?.value || '5900').trim();
  const vncPassword = String(document.getElementById('session-vnc-password')?.value || '');
  const localShellType = normalizeLocalShellType(document.getElementById('session-local-shell')?.value || 'powershell');
  const errorEl = document.getElementById('session-error');
  const fail = (message) => {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  };

  if (SESSION_MODAL_STATE.mode === 'edit-shortcut') {
    const existingShortcut = findSessionShortcutById(SESSION_MODAL_STATE.shortcutId);
    if (!existingShortcut) {
      fail('This saved session no longer exists.');
      return;
    }
    const result = await buildShortcutUpdateFromModal(existingShortcut);
    if (result?.error) {
      fail(result.error);
      return;
    }
    updateSessionShortcut(existingShortcut.id, () => result.shortcut);
    closeSessionModal();
    return;
  }

  if (type === 'local_shell') {
    addLocalTermTab(localShellType);
    addSessionShortcut({
      type: 'local_shell',
      name: `Local ${localShellLabel(localShellType)}`,
      payload: { shellType: localShellType },
    });
    closeSessionModal();
    return;
  }

  if (type === 'wsl_shell') {
    addLocalTermTab('wsl');
    addSessionShortcut({
      type: 'wsl_shell',
      name: 'Local WSL',
      payload: {},
    });
    closeSessionModal();
    return;
  }

  if (type === 'vnc') {
    const parsedPort = Number.parseInt(vncPortRaw || '5900', 10);
    if (!vncHost) {
      fail('VNC host is required.');
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      fail('Port must be a valid number between 1 and 65535.');
      return;
    }
    addSessionShortcut({
      type: 'vnc',
      name: `VNC ${vncHost}:${parsedPort}`,
      payload: { host: vncHost, port: parsedPort, password: vncPassword },
    });
    closeSessionModal();
    return;
  }

  if (type === 'ssh' && sshConfigSource === 'new') {
    const parsedPort = Number.parseInt(sshPortRaw || '22', 10);
    if (!sshHost) {
      fail('Remote host is required.');
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      fail('Port must be a valid number between 1 and 65535.');
      return;
    }

    const serverIdNew = crypto.randomUUID();
    const displayUser = sshUsername ? `${sshUsername}@` : '';
    const server = {
      id: serverIdNew,
      name: `SSH ${displayUser}${sshHost}:${parsedPort}`,
      icon: 'server',
      host: sshHost,
      port: parsedPort,
      username: sshUsername,
      protocol: 'ssh',
      auth_method: { type: 'Password', password: '' },
      location: '',
      lat: 0,
      lng: 0,
      folder_id: SESSION_FOLDER_ID,
    };

    try {
      await invoke('save_server', { server });
      await loadServers();
      selectSrv(serverIdNew);
      addTermTab({
        serverId: serverIdNew,
        usernameOverride: sshUsername || null,
        forceUsernamePrompt: false,
      });
      closeSessionModal();
      return;
    } catch (e) {
      fail(`Failed to create SSH server: ${e}`);
      return;
    }
  }

  if (isExternalLauncherSession(type)) {
    if (type === 'serial') {
      const baud = Number.parseInt(externalBaudRaw || '115200', 10);
      if (!externalSerialPort) {
        fail('Serial port is required (e.g. COM3).');
        return;
      }
      if (!Number.isInteger(baud) || baud < 50 || baud > 921600) {
        fail('Baud rate must be a valid number between 50 and 921600.');
        return;
      }
      try {
        const command = buildExternalSessionCommand(type, {
          serialPort: externalSerialPort,
          baud,
        });
        await launchExternalCommandSession(command);
        addSessionShortcut({
          type,
          name: `Serial ${externalSerialPort}`,
          payload: { serialPort: externalSerialPort, baud },
        });
        closeSessionModal();
      } catch (e) {
        fail(`Failed to launch serial session: ${e}`);
      }
      return;
    }

    const port = Number.parseInt(externalPortRaw || '0', 10);
    if (!externalHost) {
      fail('Remote host is required.');
      return;
    }
    if (type !== 'rsh' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      fail('Port must be a valid number between 1 and 65535.');
      return;
    }
    try {
      const command = buildExternalSessionCommand(type, {
        host: externalHost,
        port: type === 'rsh' ? null : port,
        username: externalUsername,
        password: externalPassword,
      });
      await launchExternalCommandSession(command);
      const shortcutPort = type === 'rsh' ? null : port;
      const endpoint = shortcutPort ? `${externalHost}:${shortcutPort}` : externalHost;
      addSessionShortcut({
        type,
        name: `${type.toUpperCase()} ${endpoint}`,
        payload: {
          host: externalHost,
          port: shortcutPort,
          username: externalUsername,
          password: externalPassword,
        },
      });
      closeSessionModal();
    } catch (e) {
      fail(`Failed to launch ${type.toUpperCase()} session: ${e}`);
    }
    return;
  }

  if (type === 'telnet' && telnetConfigSource === 'new') {
    const parsedPort = Number.parseInt(telnetPortRaw || '23', 10);
    if (!telnetHost) {
      fail('Remote host is required.');
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      fail('Port must be a valid number between 1 and 65535.');
      return;
    }

    const serverIdNew = crypto.randomUUID();
    const displayUser = telnetUsername ? `${telnetUsername}@` : '';
    const server = {
      id: serverIdNew,
      name: `TELNET ${displayUser}${telnetHost}:${parsedPort}`,
      icon: 'terminal',
      host: telnetHost,
      port: parsedPort,
      username: telnetUsername,
      protocol: 'telnet',
      auth_method: { type: 'Agent' },
      location: '',
      lat: 0,
      lng: 0,
      folder_id: SESSION_FOLDER_ID,
    };

    try {
      await invoke('save_server', { server });
      await loadServers();
      selectSrv(serverIdNew);
      addTermTab({ serverId: serverIdNew });
      closeSessionModal();
      return;
    } catch (e) {
      fail(`Failed to create Telnet profile: ${e}`);
      return;
    }
  }

  if (type === 'sftp' && sftpCredentialSource === 'new') {
    const parsedPort = Number.parseInt(sftpPortRaw || '22', 10);
    if (!sftpHost) {
      fail('Remote host is required.');
      return;
    }
    if (!sftpUsername) {
      fail('Username is required.');
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      fail('Port must be a valid number between 1 and 65535.');
      return;
    }

    let auth_method;
    if (sftpAuthMethod === 'Key') {
      if (!sftpKeyPath) {
        fail('SSH key path is required when using key authentication.');
        return;
      }
      auth_method = { type: 'Key', key_path: sftpKeyPath, passphrase: sftpPassphrase || null };
    } else {
      if (!sftpPassword) {
        fail('Password is required when using password authentication.');
        return;
      }
      auth_method = { type: 'Password', password: sftpPassword };
    }

    const serverIdNew = crypto.randomUUID();
    const displayUser = sftpUsername ? `${sftpUsername}@` : '';
    const server = {
      id: serverIdNew,
      name: `SFTP ${displayUser}${sftpHost}:${parsedPort}`,
      icon: 'server',
      host: sftpHost,
      port: parsedPort,
      username: sftpUsername,
      protocol: 'ssh',
      auth_method,
      location: '',
      lat: 0,
      lng: 0,
      folder_id: SESSION_FOLDER_ID,
    };

    try {
      await invoke('save_server', { server });
      await loadServers();
      selectSrv(serverIdNew);
      openSftpBrowserTab(serverIdNew);
      setActiveTab('sftp');
      closeSessionModal();
      return;
    } catch (e) {
      fail(`Failed to create SFTP credential profile: ${e}`);
      return;
    }
  }

  if (!serverId) {
    fail('Select a server profile for this session type.');
    return;
  }
  const server = SRV.find((s) => s.id === serverId);
  if (!server) {
    fail('Selected server no longer exists. Reload servers and try again.');
    return;
  }

  if (type === 'ssh') {
    if (serverProtocol(server) !== 'ssh') {
      fail('Selected profile is not configured for SSH.');
      return;
    }
    selectSrv(serverId);
    addTermTab({
      serverId,
      usernameOverride: username || null,
      forceUsernamePrompt: forcePrompt,
    });
    closeSessionModal();
    return;
  }

  if (type === 'telnet') {
    if (serverProtocol(server) !== 'telnet') {
      fail('Selected profile is not configured for Telnet.');
      return;
    }
    selectSrv(serverId);
    addTermTab({ serverId });
    closeSessionModal();
    return;
  }

  if (type === 'sftp') {
    if (serverProtocol(server) !== 'ssh') {
      fail('SFTP requires an SSH server profile.');
      return;
    }
    selectSrv(serverId);
    openSftpBrowserTab(serverId);
    setActiveTab('sftp');
    closeSessionModal();
    return;
  }

  fail('Unsupported session type.');
}

function createSettingsModal() {
  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-overlay" id="settings-overlay"></div>
    <div class="settings-panel" id="settings-panel">
      <div class="settings-header">
        <span class="settings-title">\u2699 SERVER CONFIGURATION</span>
        <button class="settings-close-btn" id="settings-close-btn">\u00d7</button>
      </div>
      <div class="settings-body" id="settings-body">
        <div class="settings-list" id="settings-list"></div>
        <div style="display:flex;gap:12px;margin-top:12px">
          <button class="settings-add-btn" id="settings-add-btn" style="flex:1">+ Add Server</button>
          <button class="settings-add-btn ghost" id="settings-devtools-btn" style="flex:1">&#x1f50d; Open DevTools</button>
        </div>
        <div style="display:flex;gap:12px;margin-top:8px">
          <button class="settings-add-btn ghost" id="settings-export-btn" style="flex:1">&#x1f4e5; Export Config</button>
          <button class="settings-add-btn ghost" id="settings-import-btn" style="flex:1">&#x1f4e4; Import Config</button>
        </div>
      </div>
      <div class="settings-form" id="settings-form" style="display:none">
        <div class="sf-title" id="sf-title">Add Server</div>
        <div class="sf-row">
          <label class="sf-label">Name</label>
          <input class="sf-input" id="sf-name" placeholder="e.g. NYC-01">
        </div>
        <div class="sf-row">
          <label class="sf-label">Server Icon</label>
          <select class="sf-input" id="sf-icon">
            ${SERVER_ICON_OPTIONS_HTML}
          </select>
        </div>
        <div class="sf-row">
          <label class="sf-label">Folder</label>
          <select class="sf-input" id="sf-folder">
            <option value="">No Folder</option>
          </select>
        </div>
        <div class="sf-row">
          <label class="sf-label">Host</label>
          <div style="display:flex;gap:6px">
            <input class="sf-input" id="sf-host" placeholder="e.g. 45.77.12.33" style="flex:1">
            <button class="sf-browse-btn" id="sf-locate-btn">Locate</button>
          </div>
        </div>
        <div class="sf-row">
          <label class="sf-label">Port</label>
          <input class="sf-input" id="sf-port" type="number" value="22">
        </div>
        <div class="sf-row">
          <label class="sf-label">Protocol</label>
          <select class="sf-input" id="sf-protocol">
            <option value="ssh">SSH</option>
            <option value="telnet">Telnet</option>
          </select>
        </div>
        <div class="sf-row">
          <label class="sf-label">Username</label>
          <input class="sf-input" id="sf-username" placeholder="Leave empty to ask on connect">
        </div>
        <div class="sf-row" id="sf-auth-row">
          <label class="sf-label">Auth Method (SSH only)</label>
          <select class="sf-input" id="sf-auth-method">
            <option value="Key">SSH Key</option>
            <option value="Password">Password</option>
            <option value="Agent">SSH Agent</option>
          </select>
        </div>
        <div class="sf-row" id="sf-key-row">
          <label class="sf-label">Key Path</label>
          <div style="display:flex;gap:6px">
            <input class="sf-input" id="sf-key-path" placeholder="~/.ssh/id_ed25519" style="flex:1">
            <button class="sf-browse-btn" id="sf-browse-btn">Browse</button>
          </div>
        </div>
        <div class="sf-row" id="sf-passphrase-row">
          <label class="sf-label">Key Passphrase (optional)</label>
          <input class="sf-input" id="sf-passphrase" type="password" placeholder="Leave empty if none">
        </div>
        <div class="sf-row" id="sf-password-row" style="display:none">
          <label class="sf-label">Password</label>
          <input class="sf-input" id="sf-password" type="password">
        </div>
        <div class="sf-row">
          <label class="sf-label">Location</label>
          <div style="display:flex;gap:6px">
            <input class="sf-input" id="sf-location" placeholder="e.g. New York, US" style="flex:1">
            <button class="sf-browse-btn" id="sf-get-location-btn">Get Location</button>
          </div>
        </div>
        <div class="sf-row-pair">
          <div class="sf-row">
            <label class="sf-label">Latitude</label>
            <input class="sf-input" id="sf-lat" type="number" step="0.0001" placeholder="40.7128">
          </div>
          <div class="sf-row">
            <label class="sf-label">Longitude</label>
            <input class="sf-input" id="sf-lng" type="number" step="0.0001" placeholder="-74.0060">
          </div>
        </div>
        <div class="sf-row-pair">
          <div class="sf-row">
            <label class="sf-label">Keep-Alive (seconds)</label>
            <input class="sf-input" id="sf-keepalive" type="number" min="0" value="0" placeholder="0 to disable">
          </div>
          <div class="sf-row">
            <label class="sf-label">Scrollback Limit</label>
            <input class="sf-input" id="sf-scrollback" type="number" min="0" value="10000" placeholder="10000">
          </div>
        </div>
        <div class="sf-actions">
          <button class="sf-cancel-btn" id="sf-cancel-btn">Cancel</button>
          <button class="sf-save-btn" id="sf-save-btn">Save Server</button>
        </div>
        <div class="sf-error" id="sf-error" style="display:none"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Wire up events
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);
  document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
  document.getElementById('settings-add-btn').addEventListener('click', () => showServerForm(null));
  document.getElementById('settings-devtools-btn').addEventListener('click', async () => {
    try {
      await invoke('open_devtools');
    } catch (err) {
      console.warn('DevTools cannot be opened in this environment:', err);
    }
  });
  document.getElementById('settings-export-btn').addEventListener('click', exportConfiguration);
  document.getElementById('settings-import-btn').addEventListener('click', importConfiguration);
  document.getElementById('sf-cancel-btn').addEventListener('click', hideServerForm);
  document.getElementById('sf-save-btn').addEventListener('click', saveServerForm);
  document.getElementById('sf-browse-btn').addEventListener('click', browseKeyFile);
  document.getElementById('sf-locate-btn').addEventListener('click', lookupHostLocation);
  document.getElementById('sf-get-location-btn').addEventListener('click', geocodeTypedLocation);
  document.getElementById('sf-auth-method').addEventListener('change', toggleAuthFields);
  document.getElementById('sf-protocol').addEventListener('change', toggleAuthFields);
}

async function exportConfiguration() {
  const chosen = await saveDialog({
    title: 'Export Configuration',
    defaultPath: 'terminey-config.json',
  });
  if (!chosen) return;
  const localPath = Array.isArray(chosen) ? chosen[0] : chosen;
  if (!localPath) return;

  try {
    const servers = await invoke('get_servers');
    const folders = await invoke('get_folders');
    const data = {
      version: 1,
      servers: servers || [],
      folders: folders || []
    };
    const content = JSON.stringify(data, null, 2);
    await invoke('write_text_file', { path: localPath, content });
    showAlert({
      title: 'Configuration Exported',
      message: `Successfully exported ${servers.length} servers and ${folders.length} folders.`,
      variant: 'success'
    });
  } catch (err) {
    showError('Failed to export configuration', err);
  }
}

async function importConfiguration() {
  const picked = await open({
    title: 'Select configuration file to import',
    directory: false,
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!picked) return;
  const localPath = Array.isArray(picked) ? picked[0] : picked;
  if (!localPath) return;

  const confirmed = await showConfirm({
    title: 'Import Configuration',
    message: 'Importing will add new connections and folders. Existing IDs might be updated. Do you want to proceed?',
    confirmText: 'Import',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;

  try {
    const content = await invoke('read_text_file', { path: localPath });
    const data = JSON.parse(content);
    if (!data || !Array.isArray(data.servers) || !Array.isArray(data.folders)) {
      throw new Error('Invalid configuration format. Must contain servers and folders arrays.');
    }

    for (const f of data.folders) {
      await invoke('save_folder', { folder: f });
    }
    for (const s of data.servers) {
      await invoke('save_server', { server: s });
    }

    showAlert({
      title: 'Configuration Imported',
      message: `Successfully imported ${data.servers.length} servers and ${data.folders.length} folders.`,
      variant: 'success'
    });

    await loadServers();
    renderFolderOptions();
    renderServerList();
  } catch (err) {
    showError('Failed to import configuration', err);
  }
}

function openSettings() {
  document.getElementById('settings-modal').style.display = 'block';
  renderFolderOptions();
  renderServerList();
}

function renderFolderOptions(selectedFolderId = '') {
  const select = document.getElementById('sf-folder');
  if (!select) return;
  const selected = normalizeFolderId(selectedFolderId) || '';
  const options = ['<option value="">No Folder</option>'];
  FOLDERS.forEach((folder) => {
    const active = folder.id === selected ? ' selected' : '';
    options.push(`<option value="${folder.id}"${active}>${escapeHtml(folder.name)}</option>`);
  });
  select.innerHTML = options.join('');
  select.value = selected;
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
  hideServerForm();
}

function renderServerList() {
  const list = document.getElementById('settings-list');
  if (SRV.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px">No servers configured yet.</div>`;
    return;
  }
  list.innerHTML = SRV.map(s => `
    <div class="sl-item" data-id="${s.id}">
      <div class="sl-info">
        <div class="sl-name">${s.name}</div>
        <div class="sl-detail">${s.username ? `${s.username}@` : ''}${s.host}:${s.port} \u00b7 ${String(s.protocol || 'ssh').toUpperCase()} \u00b7 ${folderNameById(s.folderId) || 'Ungrouped'} \u00b7 ${s.loc || 'Unspecified'}</div>
      </div>
      <div class="sl-actions">
        <button class="sl-edit-btn" data-id="${s.id}">Edit</button>
        ${serverProtocol(s) === 'ssh' ? `<button class="sl-clear-host-btn" data-id="${s.id}">Clear Host Key</button>` : ''}
        <button class="sl-delete-btn" data-id="${s.id}">Delete</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('.sl-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const srv = SRV.find(s => s.id === btn.dataset.id);
      if (srv) showServerForm(srv);
    });
  });
  list.querySelectorAll('.sl-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await invoke('delete_server', { serverId: btn.dataset.id });
      await loadServers();
      renderServerList();
    });
  });
  list.querySelectorAll('.sl-clear-host-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const server = SRV.find((s) => s.id === btn.dataset.id);
      if (!server) return;
      const confirmed = await showConfirm({
        title: 'Clear Trusted Host Key',
        message: `Clear trusted host key for "${server.name}" (${server.host}:${server.port})?\n\nThe next connection will trust and store the current host key again.`,
        variant: 'warning',
        confirmText: 'Clear',
      });
      if (!confirmed) return;
      try {
        const removed = await invoke('ssh_clear_known_host', { serverId: server.id });
        showAlert({ title: 'Host Key Cleared', message: `Known host entries cleared: ${Number(removed) || 0}`, variant: 'info' });
      } catch (error) {
        showError('Clear host key failed', error);
      }
    });
  });
}

let editingServerId = null;

function showServerForm(server) {
  editingServerId = server ? server.id : null;
  document.getElementById('sf-title').textContent = server ? 'Edit Server' : 'Add Server';
  renderFolderOptions(server ? server.folderId : '');
  document.getElementById('sf-name').value = server ? server.name : '';
  document.getElementById('sf-icon').value = normalizeServerIcon(server ? (server.icon || server?._raw?.icon) : 'server');
  document.getElementById('sf-host').value = server ? server.host : '';
  document.getElementById('sf-port').value = server ? server.port : 22;
  document.getElementById('sf-protocol').value = normalizeConnectionProtocol(server ? serverProtocol(server) : 'ssh');
  document.getElementById('sf-username').value = server ? server.username : '';
  document.getElementById('sf-location').value = server ? server.loc : '';
  document.getElementById('sf-lat').value = server ? server.lat : '';
  document.getElementById('sf-lng').value = server ? server.lng : '';
  document.getElementById('sf-keepalive').value = server ? (server.keepalive_interval_secs || 0) : 0;
  document.getElementById('sf-scrollback').value = server ? (server.scrollback_limit || 10000) : 10000;
  document.getElementById('sf-error').style.display = 'none';

  if (server && server._raw) {
    const am = server._raw.auth_method;
    document.getElementById('sf-auth-method').value = am.type;
    if (am.type === 'Key') {
      document.getElementById('sf-key-path').value = am.key_path || '';
      document.getElementById('sf-passphrase').value = am.passphrase || '';
    } else if (am.type === 'Password') {
      document.getElementById('sf-password').value = am.password || '';
    }
  } else {
    document.getElementById('sf-auth-method').value = 'Key';
    document.getElementById('sf-key-path').value = '';
    document.getElementById('sf-passphrase').value = '';
    document.getElementById('sf-password').value = '';
  }

  toggleAuthFields();
  document.getElementById('settings-body').style.display = 'none';
  document.getElementById('settings-form').style.display = 'block';
}

function hideServerForm() {
  document.getElementById('settings-form').style.display = 'none';
  document.getElementById('settings-body').style.display = 'block';
  editingServerId = null;
}

function toggleAuthFields() {
  const protocol = normalizeConnectionProtocol(document.getElementById('sf-protocol')?.value || 'ssh');
  const method = document.getElementById('sf-auth-method').value;
  const isSsh = protocol === 'ssh';
  document.getElementById('sf-auth-row').style.display = isSsh ? '' : 'none';
  document.getElementById('sf-key-row').style.display = isSsh && method === 'Key' ? '' : 'none';
  document.getElementById('sf-passphrase-row').style.display = isSsh && method === 'Key' ? '' : 'none';
  document.getElementById('sf-password-row').style.display = isSsh && method === 'Password' ? '' : 'none';
}

async function browseKeyFile() {
  try {
    const selected = await open({
      multiple: false,
      title: 'Select SSH Key',
    });
    if (selected) {
      document.getElementById('sf-key-path').value = selected;
    }
  } catch (e) {
    console.error('File picker error:', e);
  }
}

async function lookupHostLocation() {
  const hostInput = document.getElementById('sf-host');
  const locateBtn = document.getElementById('sf-locate-btn');
  const host = hostInput.value.trim();
  if (!host) {
    showFormError('Enter a host/IP first, then click Locate.');
    return;
  }

  const originalText = locateBtn.textContent;
  locateBtn.disabled = true;
  locateBtn.textContent = 'Locating...';

  try {
    const result = await invoke('lookup_ip_location', { host });
    if (result?.location) document.getElementById('sf-location').value = result.location;
    if (typeof result?.lat === 'number') document.getElementById('sf-lat').value = result.lat.toFixed(4);
    if (typeof result?.lng === 'number') document.getElementById('sf-lng').value = result.lng.toFixed(4);
    document.getElementById('sf-error').style.display = 'none';
  } catch (e) {
    showFormError(`Location lookup failed: ${e}`);
  } finally {
    locateBtn.disabled = false;
    locateBtn.textContent = originalText;
  }
}

async function geocodeTypedLocation() {
  const locationInput = document.getElementById('sf-location');
  const locationBtn = document.getElementById('sf-get-location-btn');
  const query = locationInput.value.trim();
  if (!query) {
    showFormError('Enter a city/location first, then click Get Location.');
    return;
  }

  const originalText = locationBtn.textContent;
  locationBtn.disabled = true;
  locationBtn.textContent = 'Getting...';

  try {
    const result = await invoke('geocode_location', { query });
    if (result?.location) locationInput.value = result.location;
    if (typeof result?.lat === 'number') document.getElementById('sf-lat').value = result.lat.toFixed(4);
    if (typeof result?.lng === 'number') document.getElementById('sf-lng').value = result.lng.toFixed(4);
    document.getElementById('sf-error').style.display = 'none';
  } catch (e) {
    showFormError(`Location lookup failed: ${e}`);
  } finally {
    locationBtn.disabled = false;
    locationBtn.textContent = originalText;
  }
}

async function saveServerForm() {
  const closeModalOnSuccess = editingServerId !== null;
  const name = document.getElementById('sf-name').value.trim();
  const icon = normalizeServerIcon(document.getElementById('sf-icon').value);
  const host = document.getElementById('sf-host').value.trim();
  const port = parseInt(document.getElementById('sf-port').value) || 22;
  const protocol = normalizeConnectionProtocol(document.getElementById('sf-protocol').value);
  const username = document.getElementById('sf-username').value.trim();
  const location = document.getElementById('sf-location').value.trim();
  const lat = parseFloat(document.getElementById('sf-lat').value) || 0;
  const lng = parseFloat(document.getElementById('sf-lng').value) || 0;
  const folderId = normalizeFolderId(document.getElementById('sf-folder').value);
  const authMethod = document.getElementById('sf-auth-method').value;
  const keepalive_interval_secs = parseInt(document.getElementById('sf-keepalive').value) || 0;
  const scrollback_limit = parseInt(document.getElementById('sf-scrollback').value) || 10000;

  if (!name || !host) {
    showFormError('Name and Host are required.');
    return;
  }

  let auth_method;
  const existing = editingServerId ? SRV.find((item) => item.id === editingServerId) : null;
  if (protocol === 'telnet') {
    auth_method = existing?._raw?.auth_method || { type: 'Agent' };
  } else {
    if (authMethod === 'Key') {
      const keyPath = document.getElementById('sf-key-path').value.trim();
      const passphrase = document.getElementById('sf-passphrase').value || null;
      if (!keyPath) { showFormError('SSH key path is required.'); return; }
      auth_method = { type: 'Key', key_path: keyPath, passphrase };
    } else if (authMethod === 'Password') {
      const password = document.getElementById('sf-password').value;
      auth_method = { type: 'Password', password };
    } else {
      auth_method = { type: 'Agent' };
    }
  }

  const server = {
    id: editingServerId || crypto.randomUUID(),
    name, icon, host, port, username, protocol, auth_method, location, lat, lng, folder_id: folderId,
    keepalive_interval_secs, scrollback_limit,
  };

  try {
    await invoke('save_server', { server });
    await loadServers();
    if (closeModalOnSuccess) closeSettings();
    else {
      hideServerForm();
      renderServerList();
    }
  } catch (e) {
    showFormError(`Save failed: ${e}`);
  }
}

function showFormError(msg) {
  const el = document.getElementById('sf-error');
  el.textContent = msg;
  el.style.display = 'block';
}

/* ══════════════════════════════════════════════════════════
   LOAD SERVERS FROM BACKEND
══════════════════════════════════════════════════════════ */
async function loadServers() {
  try {
    const [configs, folders] = await Promise.all([
      invoke('get_servers'),
      invoke('get_folders').catch(() => []),
    ]);
    FOLDERS = withSystemFolders(folders);
    collapsedFolderIds = new Set(
      Array.from(collapsedFolderIds).filter((id) =>
        id === UNGROUPED_COLLAPSE_ID
        || FOLDERS.some((folder) => folder.id === id)
        || SESSION_SHORTCUT_FOLDER_ID_SET.has(id)
      )
    );
    saveCollapsedFolders();
    SRV = configs.map(c => {
      const protocol = normalizeConnectionProtocol(c.protocol);
      const authLabel = protocol === 'telnet'
        ? 'Telnet'
        : (c.auth_method.type === 'Key' ? 'SSH Key' : c.auth_method.type === 'Password' ? 'Password' : 'Agent');
      return ({
        id: c.id,
        name: c.name,
        icon: normalizeServerIcon(c.icon),
        host: c.host,
        port: c.port,
        username: c.username,
        protocol,
        loc: c.location,
        lat: normalizeCoordinate(c.lat),
        lng: normalizeCoordinate(c.lng),
        keepalive_interval_secs: c.keepalive_interval_secs || 0,
        scrollback_limit: c.scrollback_limit || 10000,
        folderId: null,
        status: 'unknown',
        latencyMs: null,
        resolvedIp: null,
        statusReason: null,
        authLabel,
        _raw: c,
      });
    })
      .map((server) => ({
        ...server,
        folderId: normalizeFolderId(server._raw?.folder_id),
      }));
    if (selId !== null && !SRV.some(s => s.id === selId)) selId = null;
    if (sftpBrowserTab.open && !SRV.some((s) => s.id === sftpBrowserTab.srvId)) {
      closeSftpBrowserTab();
    }
    const validServerIds = new Set(SRV.map((s) => s.id));
    for (const key of sftpCredentialCache.keys()) {
      if (!validServerIds.has(key)) sftpCredentialCache.delete(key);
    }
    const tabsToClose = [];
    for (const [tid, tab] of Object.entries(termTabs)) {
      if (tab.srvId) {
        const matchingServer = SRV.find((s) => s.id === tab.srvId);
        if (!matchingServer) {
          tabsToClose.push(tid);
        } else if (
          tab.mode === 'ssh' &&
          tab.srv &&
          (tab.srv.host !== matchingServer.host ||
            tab.srv.port !== matchingServer.port ||
            tab.srv.username !== matchingServer.username ||
            tab.srv.protocol !== matchingServer.protocol)
        ) {
          tabsToClose.push(tid);
        }
      }
    }
    for (const tid of tabsToClose) {
      await closeTab(null, tid);
    }
  } catch (e) {
    console.error('Failed to load servers:', e);
    FOLDERS = withSystemFolders([]);
    SRV = [];
    selId = null;
  }
  cleanLiveMetricsCache();
  cleanServerIntelCache();
  updateHeaderStats();
  renderSidebar();
  renderMapMarkers();
  if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
  refreshRailActive();
  refreshSidebarBadges();
  refreshSftpBrowserTab();
  if (activeTabId === 'sftp') {
    if (selId !== null) showStaticSftpForServer(); else showStaticSftpEmpty();
  }
  void refreshServerStatuses();
}

/* ══════════════════════════════════════════════════════════
   METRICS SWITCH
══════════════════════════════════════════════════════════ */
function switchToMetrics() { setActiveTab('metrics'); }
function switchToSftp() { setActiveTab('sftp'); }

/* ══════════════════════════════════════════════════════════
   RESIZE HANDLERS
══════════════════════════════════════════════════════════ */
// Vertical: map / bottom panel resize
(function () {
  const handle = document.getElementById('map-resize');
  const mapSec = document.getElementById('map-section');
  const main = document.getElementById('main');
  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mousedown', e => {
    if (layoutController?.isMapCollapsed()) return;
    dragging = true; startY = e.clientY; startH = mapSec.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const totalH = main.offsetHeight;
    const newH = Math.max(80, Math.min(totalH - 120, startH + dy));
    mapSec.style.height = newH + 'px';
    layoutController?.setMapHeightBeforeCollapse(newH + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    map.invalidateSize();
  });
})();

// Horizontal: sidebar width resize
(function () {
  const handle = document.getElementById('sb-resize');
  const sb = document.getElementById('sidebar');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    if (layoutController?.isSidebarCollapsed()) return;
    dragging = true; startX = e.clientX; startW = sb.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    sb.style.width = Math.max(160, Math.min(420, startW + dx)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

/* ══════════════════════════════════════════════════════════
   WIRE UP EVENT LISTENERS + INIT
══════════════════════════════════════════════════════════ */

// Create settings modal DOM
createSettingsModal();
createSessionModal();

// Wire up all UI buttons via addEventListener (CSP-safe, no inline handlers)
document.getElementById('menu-btn').addEventListener('click', () => toggleSidebar());
document.getElementById('sb-main-tab').addEventListener('click', () => setMainDashboardActive(true));
document.getElementById('sb-add-folder-btn').addEventListener('click', () => {
  void createFolderFromSidebar();
});
document.getElementById('sb-add-btn').addEventListener('click', () => { openSettings(); showServerForm(null); });
document.getElementById('sb-add-session-btn').addEventListener('click', () => {
  openSessionModal();
});
document.getElementById('sb-gear-btn').addEventListener('click', () => openSettings());
document.getElementById('sb-toggle-btn').addEventListener('click', () => toggleSidebar_collapse());
document.getElementById('sidebar-overlay').addEventListener('click', () => toggleSidebar(false));
document.getElementById('map-toggle-btn').addEventListener('click', () => toggleMap());
document.getElementById('tab-metrics-btn').addEventListener('click', () => switchToMetrics());
document.getElementById('tab-sftp-btn').addEventListener('click', () => switchToSftp());
document.getElementById('h-avgping-refresh-btn').addEventListener('click', () => {
  void refreshServerStatuses();
});
const tabAddBtn = document.getElementById('tab-add-btn');
tabAddBtn.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  if (openSelectedServerTerminal()) {
    hideTabAddMenu();
    return;
  }
  toggleTabAddMenu();
});
tabAddBtn.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  showTabAddMenu({ x: ev.clientX, y: ev.clientY });
});
document.querySelectorAll('#tab-add-menu .tab-add-menu-item').forEach((item) => {
  item.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (item.classList.contains('disabled')) return;
    runTabAddMenuAction(item.dataset.action || '');
  });
});
document.getElementById('tab-maximize-btn').addEventListener('click', () => toggleMaximize());
document.getElementById('sftp-pane-files-btn').addEventListener('click', async () => {
  if (staticSftpState.pane === 'editor') await closeSftpEditor();
  else await setSftpPane('files', false);
});
document.getElementById('sftp-pane-editor-btn').addEventListener('click', async () => {
  if (staticSftpState.editorPath) await setSftpPane('editor', false);
});
document.getElementById('sftp-view-list-btn').addEventListener('click', () => setSftpViewMode('list'));
document.getElementById('sftp-view-grid-btn').addEventListener('click', () => setSftpViewMode('grid'));
document.getElementById('sftp-upload-btn').addEventListener('click', () => uploadFileToRemoteDir(staticSftpState.path || '.'));
document.getElementById('sftp-new-file-btn').addEventListener('click', () => createSftpFile(staticSftpState.path || '.'));
document.getElementById('sftp-refresh-btn').addEventListener('click', () => loadStaticSftpDir());
document.getElementById('sftp-go-btn').addEventListener('click', () => loadStaticSftpDir());
document.getElementById('sftp-up-btn').addEventListener('click', () => {
  const input = document.getElementById('sftp-path-input');
  const next = remoteParentPath(input?.value || '.');
  if (input) input.value = next;
  loadStaticSftpDir(next);
});
document.getElementById('sftp-path-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') loadStaticSftpDir();
});
document.getElementById('sftp-editor-text').addEventListener('input', (ev) => {
  staticSftpState.editorContent = String(ev.target?.value || '');
  staticSftpState.editorDirty = staticSftpState.editorContent !== staticSftpState.editorOriginal;
  renderSftpEditorPanel();
});
document.getElementById('sftp-editor-save-btn').addEventListener('click', () => {
  void saveSftpEditorFile();
});
document.getElementById('sftp-editor-close-btn').addEventListener('click', () => {
  closeSftpEditor();
});
document.getElementById('dash-start-local-terminal-btn').addEventListener('click', () => {
  setTerminalPickerVisible(true);
});
document.getElementById('dash-remove-previous-session-btn').addEventListener('click', () => {
  void removePreviousSessionFromDashboard();
});
document.getElementById('dash-launch-powershell-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('powershell');
});
document.getElementById('dash-launch-cmd-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('cmd');
});
document.getElementById('dash-launch-bash-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('bash');
});
document.getElementById('dash-launch-zsh-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('zsh');
});
document.getElementById('dash-launch-wsl-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('wsl');
});
document.getElementById('dash-cancel-terminal-picker-btn').addEventListener('click', () => {
  setTerminalPickerVisible(false);
});
document.addEventListener('click', (ev) => {
  const addMenu = document.getElementById('tab-add-menu');
  const addBtn = document.getElementById('tab-add-btn');
  if (addMenu && addMenu.style.display !== 'none' && !addMenu.contains(ev.target) && ev.target !== addBtn) {
    hideTabAddMenu();
  }
  const sftpMenu = document.getElementById('sftp-context-menu');
  if (sftpMenu && sftpMenu.style.display !== 'none' && !sftpMenu.contains(ev.target)) {
    hideSftpContextMenu();
  }
  const serverMenu = document.getElementById('server-context-menu');
  if (serverMenu && serverMenu.style.display !== 'none' && !serverMenu.contains(ev.target)) {
    hideServerContextMenu();
  }
  const folderMenu = document.getElementById('folder-context-menu');
  if (folderMenu && folderMenu.style.display !== 'none' && !folderMenu.contains(ev.target)) {
    hideFolderContextMenu();
  }
  const sessionMenu = document.getElementById('session-context-menu');
  if (sessionMenu && sessionMenu.style.display !== 'none' && !sessionMenu.contains(ev.target)) {
    hideSessionContextMenu();
  }
});
window.addEventListener('resize', () => {
  hideTabAddMenu();
  hideSftpContextMenu();
  hideServerContextMenu();
  hideFolderContextMenu();
  hideSessionContextMenu();
  syncRecentSessionViewport();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    hideTabAddMenu();
    hideSftpContextMenu();
    hideServerContextMenu();
    hideFolderContextMenu();
    hideSessionContextMenu();
    closeSessionModal();
  }
});

initStaticSftpColumnResizers();
updateSftpViewButtons();
updateSftpPaneButtons();
renderSftpEditorPanel();
setMainDashboardActive(true);
renderMainDashboard();
refreshAddBtn();

// ══════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS PANEL
// ══════════════════════════════════════════════════════════

const SHORTCUTS_DATA = [
  { key: 'Ctrl + T', desc: 'New Terminal Tab' },
  { key: 'Ctrl + W', desc: 'Close Current Tab' },
  { key: 'Ctrl + Tab', desc: 'Next Tab' },
  { key: 'Ctrl + Shift + Tab', desc: 'Previous Tab' },
  { key: 'Ctrl + Shift + C', desc: 'Copy (Terminal)' },
  { key: 'Ctrl + Shift + V', desc: 'Paste (Terminal)' },
  { key: 'Ctrl + /', desc: 'Toggle Shortcuts Panel' },
  { key: 'Escape', desc: 'Close Menus / Exit Input' },
];

let shortcutsPanelVisible = false;

function createShortcutsPanel() {
  if (document.getElementById('shortcuts-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'shortcuts-panel';
  panel.className = 'shortcuts-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <button class="shortcuts-panel-close" id="shortcuts-panel-close" aria-label="Close shortcuts panel">&times;</button>
    <div class="shortcuts-panel-title">Keyboard Shortcuts</div>
    <div class="shortcuts-list">
      ${SHORTCUTS_DATA.map(s => `
        <div class="shortcuts-item">
          <span class="shortcuts-key">${escapeHtml(s.key)}</span>
          <span class="shortcuts-desc">${escapeHtml(s.desc)}</span>
        </div>
      `).join('')}
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('shortcuts-panel-close').addEventListener('click', toggleShortcutsPanel);
}

function createShortcutsToggle() {
  if (document.getElementById('shortcuts-toggle')) return;

  const btn = document.createElement('button');
  btn.id = 'shortcuts-toggle';
  btn.className = 'shortcuts-toggle';
  btn.setAttribute('aria-label', 'Toggle keyboard shortcuts panel');
  btn.setAttribute('title', 'Keyboard shortcuts (Ctrl+/)');
  btn.innerHTML = '?';
  btn.addEventListener('click', toggleShortcutsPanel);
  document.body.appendChild(btn);
}

function toggleShortcutsPanel() {
  shortcutsPanelVisible = !shortcutsPanelVisible;
  const panel = document.getElementById('shortcuts-panel');
  if (panel) {
    panel.style.display = shortcutsPanelVisible ? 'block' : 'none';
  }
}

// Add keyboard shortcut to toggle panel
document.addEventListener('keydown', (ev) => {
  // Ctrl+/ or Cmd+/ to toggle shortcuts panel
  if ((ev.ctrlKey || ev.metaKey) && ev.key === '/') {
    ev.preventDefault();
    toggleShortcutsPanel();
  }
});

// Add keyboard shortcut to toggle search
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
    if (activeTabId && termTabs[activeTabId] && (termTabs[activeTabId].mode === 'ssh' || termTabs[activeTabId].mode === 'local')) {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        if (!document.activeElement.classList.contains('search-input')) {
          return;
        }
      }
      ev.preventDefault();
      const panel = document.getElementById(`panel-${activeTabId}`);
      if (panel && typeof panel.toggleSearch === 'function') {
        panel.toggleSearch();
      }
    }
  }
});

// Initialize shortcuts panel
createShortcutsPanel();
createShortcutsToggle();

// Initial load
loadServers();
setInterval(() => { void refreshServerStatuses(); }, STATUS_REFRESH_INTERVAL_MS);
setInterval(() => { void tickLiveMetricsRefresh(); }, METRICS_LIVE_REFRESH_INTERVAL_MS);

// Intercept Ctrl+Shift+C globally in the capture phase to block inspect element tool from opening
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = window.getSelection().toString();
    if (sel) {
      navigator.clipboard.writeText(sel);
    }
  }
}, true);

window.addEventListener('focus', async () => {
  if (activeTabId && termTabs[activeTabId] && termTabs[activeTabId].mode === 'vnc' && termTabs[activeTabId].rfb) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        termTabs[activeTabId].rfb.clipboardPaste(text);
      }
    } catch (err) {
      // ignore
    }
  }
});
