import { expect, it, vi } from 'vitest';
import { WorkspaceQueue } from '../apps/api/src/workspaceQueue.js';
import { workspaceContext, authorizedOperation } from '../apps/api/src/workspaceContext.js';
import { reserveLanguage } from '../apps/api/src/channel-budget.js';
import { storageGuard } from '../apps/worker/src/storage-guard.js';
it('rechecks captured authority when queued work actually begins and recovers after denial', async () => {
  const queue = new WorkspaceQueue(); let release!: () => void; let authorized = true;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const first = queue.run('project', () => new Promise<void>((resolve) => { release = resolve; started(); }));
  await ready;
  const mutation = vi.fn(async () => 'changed');
  const queued = workspaceContext.run({ requestId: 'request', authorizations: new Map([['edit', async () => { if (!authorized) throw new Error('Access revoked'); }]]) }, () => queue.run('project', authorizedOperation(mutation)));
  const denied = expect(queued).rejects.toThrow('Access revoked');
  authorized = false; release(); await first; await denied;
  expect(mutation).not.toHaveBeenCalled(); expect(queue.has('project')).toBe(false);
  expect(await queue.run('project', async () => 'recovered')).toBe('recovered');
});
it('bounds language reservations per actor and project and releases capacity exactly once', () => {
  const release = Array.from({ length: 4 }, () => reserveLanguage('one', 'project'));
  expect(() => reserveLanguage('one', 'project')).toThrow();
  const second = Array.from({ length: 4 }, () => reserveLanguage('two', 'project'));
  expect(() => reserveLanguage('three', 'project')).toThrow();
  release[0]!(); release[0]!(); const replacement = reserveLanguage('three', 'project');
  for (const close of [...release, ...second, replacement]) close();
  reserveLanguage('one', 'project')();
});
it('runs quota enforcement independently, bounds concurrency, and cleans its timer', async () => {
  vi.useFakeTimers();
  const held: (() => void)[] = []; let active = 0, maximum = 0;
  const enforce = vi.fn(() => new Promise<void>((resolve) => {
    active++; maximum = Math.max(maximum, active);
    held.push(() => { active--; resolve(); });
  }));
  const stop = storageGuard(async () => Array.from({ length: 8 }, (_, i) => String(i)), enforce);
  try {
    await vi.advanceTimersByTimeAsync(5000); expect(enforce).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000); expect(enforce).toHaveBeenCalledTimes(4);
    for (const resolve of held.splice(0)) resolve();
    await vi.advanceTimersByTimeAsync(0); expect(enforce).toHaveBeenCalledTimes(8);
    for (const resolve of held.splice(0)) resolve();
    await vi.advanceTimersByTimeAsync(0); expect(maximum).toBe(4);
  } finally { stop(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
});
