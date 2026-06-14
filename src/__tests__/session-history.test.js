import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/runtime.js', () => ({
  RECENT_SESSION_LIMIT: 20,
  RECENT_SESSION_STORAGE_KEY: 'terminox_recent_local_sessions',
  SESSION_SHORTCUT_LIMIT: 300,
  SESSION_SHORTCUT_STORAGE_KEY: 'terminox_session_shortcuts',
  FOLDER_COLLAPSE_STORAGE_KEY: 'terminox_folder_collapse',
  UNGROUPED_COLLAPSE_ID: '__ungrouped__',
  SESSION_FOLDER_ID: '__sessions__',
  SESSION_FOLDER_NAME: 'Sessions',
  isTauri: false,
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
  open: vi.fn(async () => null),
  saveDialog: vi.fn(async () => null),
}));

const { normalizeRecentSessionEntry, trackRecentSession } =
  await import('../lib/session-history.js');

const noop = (x) => x;

describe('normalizeRecentSessionEntry', () => {
  it('accepts valid ssh entry', () => {
    const entry = {
      mode: 'ssh',
      id: 'ssh-1',
      serverId: 's1',
      serverName: 'My Server',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      openedAtMs: Date.now(),
    };
    const result = normalizeRecentSessionEntry(entry, noop);
    expect(result).toBeTruthy();
    expect(result.mode).toBe('ssh');
    expect(result.id).toBe('ssh-1');
  });

  it('rejects entry missing required fields', () => {
    expect(normalizeRecentSessionEntry(null, noop)).toBeNull();
    expect(normalizeRecentSessionEntry({}, noop)).toBeNull();
  });

  it('accepts valid local entry', () => {
    const entry = {
      mode: 'local',
      id: 'local-1',
      shell: 'powershell',
      openedAtMs: Date.now(),
    };
    const result = normalizeRecentSessionEntry(entry, noop);
    expect(result).toBeTruthy();
    expect(result.mode).toBe('local');
  });

  it('defaults unknown mode to local', () => {
    const entry = { id: 'x', openedAtMs: Date.now() };
    const result = normalizeRecentSessionEntry(entry, noop);
    expect(result?.mode).toBe('local');
  });
});

describe('trackRecentSession', () => {
  const makeEntry = (id, openedAtMs = Date.now()) => ({
    mode: 'ssh',
    id,
    serverId: 's1',
    serverName: 'Server',
    host: '1.1.1.1',
    port: 22,
    username: 'root',
    openedAtMs,
  });

  it('prepends new entry to empty list', () => {
    const result = trackRecentSession([], makeEntry('a'), (e) => normalizeRecentSessionEntry(e, noop));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('moves duplicate id to front', () => {
    let list = [];
    list = trackRecentSession(list, makeEntry('a'), (e) => normalizeRecentSessionEntry(e, noop));
    list = trackRecentSession(list, makeEntry('b'), (e) => normalizeRecentSessionEntry(e, noop));
    list = trackRecentSession(list, makeEntry('a', Date.now() + 1), (e) => normalizeRecentSessionEntry(e, noop));
    expect(list[0].id).toBe('a');
    expect(list).toHaveLength(2);
  });

  it('caps at 20 entries', () => {
    let list = [];
    for (let i = 0; i < 25; i++) {
      list = trackRecentSession(list, makeEntry(`id-${i}`), (e) => normalizeRecentSessionEntry(e, noop));
    }
    expect(list.length).toBeLessThanOrEqual(20);
  });
});
