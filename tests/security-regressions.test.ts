import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
vi.mock('../apps/worker/src/config.js', () => ({ config: { token: 'memory-only-worker-secret'.repeat(2) } }));
import { encodePreviewCookie, decodePreviewCookies } from '../apps/worker/src/preview-cookies.js';
import { validateUpdate, MAX_DOCUMENT_BYTES } from '../apps/api/src/collaboration-limits.js';
import { projectEnvironment, projectIdentity } from '../packages/bridge/src/process-security.js';
import { publicAddress } from '../apps/worker/src/provider-fetch.js';
afterEach(() => vi.restoreAllMocks());
it('preserves server-managed login cookies while isolating project namespaces and preventing forgery', () => {
  const a = encodePreviewCookie('A', 'session=private-a; Path=/; Secure; SameSite=Lax')!;
  const b = encodePreviewCookie('B', 'session=private-b; Path=/; HttpOnly')!;
  expect(a).toContain('HttpOnly'); expect(a).not.toContain('private-a');
  const header = [a.split(';')[0], b.split(';')[0], 'legacy=secret', 'repellet_session=ide'].join('; ');
  expect(decodePreviewCookies('A', header)).toBe('session=private-a');
  expect(decodePreviewCookies('B', header)).toBe('session=private-b');
  expect(decodePreviewCookies('C', header)).toBe('');
  const raw = a.split(';')[0]!;
  const forged = raw.slice(0, raw.length - 3) + (raw.at(-3) === 'x' ? 'y' : 'x') + raw.slice(-2);
  expect(decodePreviewCookies('A', forged)).toBe('');
  expect(encodePreviewCookie('A', 'session=bad; Domain=example.com')).toBeNull();
  expect(encodePreviewCookie('A', 'REPELLET_SESSION=bad')).toBeNull();
  expect(encodePreviewCookie('A', 'session=; Path=/; Max-Age=0')).toContain('Max-Age=0');
});
it('rejects hidden Yjs roots, dangling structures, oversized history, and embedded objects without changing retained text', () => {
  const retained = new Y.Doc(); retained.getText('content').insert(0, 'safe');
  const before = Y.encodeStateAsUpdate(retained);
  for (const attack of ['root', 'size', 'embed']) {
    const client = new Y.Doc(); client.getText('content'); Y.applyUpdate(client, before);
    const vector = Y.encodeStateVector(client);
    if (attack === 'root') client.getMap('hidden').set('payload', 'x');
    if (attack === 'size') client.getText('content').insert(0, 'x'.repeat(MAX_DOCUMENT_BYTES));
    if (attack === 'embed') client.getText('content').insertEmbed(0, { secret: 'x' });
    expect(() => validateUpdate(retained, Y.encodeStateAsUpdate(client, vector))).toThrow();
    expect(Y.encodeStateAsUpdate(retained)).toEqual(before);
    client.destroy();
  }
  const client = new Y.Doc(); const updates: Uint8Array[] = [];
  client.on('update', (u) => updates.push(u)); client.getText('content').insert(0, 'first'); client.getText('content').insert(5, 'second');
  expect(() => validateUpdate(retained, updates[1]!)).toThrow();
  client.destroy(); retained.destroy();
});
it('accepts ordinary collaborative changes on an isolated candidate', () => {
  const retained = new Y.Doc(); retained.getText('content').insert(0, 'hello');
  const client = new Y.Doc(); Y.applyUpdate(client, Y.encodeStateAsUpdate(retained));
  client.getText('content').insert(5, ' world');
  const candidate = validateUpdate(retained, Y.encodeStateAsUpdate(client));
  expect(candidate.getText('content').toString()).toBe('hello world');
  expect(retained.getText('content').toString()).toBe('hello');
  candidate.destroy(); client.destroy(); retained.destroy();
});
it('scrubs control credentials and drops project execution to the workspace UID', () => {
  expect(projectEnvironment({ BRIDGE_TOKEN: 'secret', WORKER_TOKEN: 'secret', STORAGE_LIMIT_MB: '1', REPELLET_AGENT_API_KEY: 'secret', PATH: '/bin', DATABASE_URL: 'project-secret' })).toEqual({ PATH: '/bin', DATABASE_URL: 'project-secret' });
  vi.spyOn(process, 'getuid').mockReturnValue(1002);
  expect(projectIdentity()).toEqual({ uid: 1000, gid: 1000 });
});
it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1'])('rejects provider destination %s', (ip) => expect(publicAddress(ip)).toBe(false));
it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('permits public provider destination %s', (ip) => expect(publicAddress(ip)).toBe(true));
