import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkspaceActor } from '@repellet/shared';
export const workspaceContext = new AsyncLocalStorage<{
  requestId: string;
  projectId?: string;
  actor?: WorkspaceActor;
  /** Captured by queues, then repeated immediately before executing actor work. */
  authorizations?: Map<string, () => Promise<unknown>>;
}>();
export function authorizedOperation<T>(operation: () => Promise<T>) {
  const checks = [...(workspaceContext.getStore()?.authorizations?.values() || [])];
  return async () => {
    for (const check of checks) await check();
    return operation();
  };
}
