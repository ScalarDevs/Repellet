import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import { or, and, eq, sql } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { db } from './db.js';
import { documents } from './schema.js';
import { bridge } from './worker.js';
import { emit, deferFileEvents } from './live.js';
import type { FileContent } from '@repellet/shared';
import { validateDocument, validateUpdate } from './collaboration-limits.js';
import { WorkspaceQueue } from './workspaceQueue.js';
type Document = {
  id: string;
  projectId: string;
  path: string;
  doc: Y.Doc;
  awareness: Awareness;
  diskHash: string | null;
  dirty: boolean;
  conflict: boolean;
  revision: number;
  clients: Set<WebSocket>;
  queue: Promise<unknown>;
  timer?: NodeJS.Timeout;
  closing: boolean;
  idleTimer?: NodeJS.Timeout;
  queuedBytes: number;
};
const persistence = new WorkspaceQueue();
const structuralChanges = new Set<string>();
const opened = new Map<string, Promise<Document>>();
const key = (id: string, path: string) => `${id}:${path}`;
function broadcast(d: Document, message: unknown, except?: WebSocket) {
  const data = JSON.stringify(message);
  for (const ws of d.clients) if (ws !== except && ws.readyState === 1) ws.send(data);
}
export function enqueue<T>(d: Document, fn: () => Promise<T>): Promise<T> {
  const next = d.queue.catch(() => {}).then(fn);
  d.queue = next;
  return next;
}
async function store(d: Document, candidate = d.doc) {
  validateDocument(candidate);
  return persistence.run('documents', async () => {
  const state = Buffer.from(Y.encodeStateAsUpdate(candidate)).toString('base64');
  const [usage] = await db.select({
    projectBytes: sql<number>`coalesce(sum(case when ${documents.projectId} = ${d.projectId} and ${documents.id} <> ${d.id} then octet_length(${documents.state}) else 0 end), 0)`,
    totalBytes: sql<number>`coalesce(sum(case when ${documents.id} <> ${d.id} then octet_length(${documents.state}) else 0 end), 0)`,
  }).from(documents);
  if (Number(usage?.projectBytes || 0) + state.length > 64 * 1024 * 1024 || Number(usage?.totalBytes || 0) + state.length > 512 * 1024 * 1024)
    throw new Error('Collaboration storage limit reached');
  const [saved] = await db
    .update(documents)
    .set({
      state,
      diskHash: d.diskHash,
      dirty: d.dirty,
      conflict: d.conflict,
      revision: sql`${documents.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, d.id))
    .returning({ revision: documents.revision });
  d.revision = saved!.revision;
  await emit(d.projectId, {
    type: 'document',
    document: {
      id: d.id,
      path: d.path,
      revision: d.revision,
      dirty: d.dirty,
      conflict: d.conflict,
    },
  });
  });
}
async function load(projectId: string, path: string): Promise<Document> {
  const existing = opened.get(key(projectId, path));
  if (existing) return existing;
  if (opened.size >= 128 || [...opened.keys()].filter((k) => k.startsWith(projectId + ':')).length >= 32)
    throw Object.assign(new Error('Too many open documents'), { statusCode: 429 });
  let resources: { doc: Y.Doc; awareness?: Awareness } | undefined;
  const loading = (async () => {
    const file = await bridge<FileContent>(projectId, `/file?path=${encodeURIComponent(path)}&collaborative=true`);
    if (file.binary)
      throw Object.assign(new Error('Binary or large files cannot be collaboratively edited'), {
        statusCode: 415,
      });
    let [row] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.path, path)));
    const doc = new Y.Doc();
    resources = { doc };
    if (row) {
      if (row.state.length > 4 * 1024 * 1024) { doc.destroy(); throw new Error('Stored document exceeds collaboration limits'); }
      doc.getText('content');
      Y.applyUpdate(doc, Buffer.from(row.state, 'base64'));
      validateDocument(doc);
      if (!row.dirty && row.diskHash !== file.hash) {
        const text = doc.getText('content');
        doc.transact(() => {
          text.delete(0, text.length);
          text.insert(0, file.content);
        });
        row = { ...row, diskHash: file.hash, conflict: false };
      } else if (row.dirty && row.diskHash !== file.hash) row = { ...row, conflict: true };
    } else {
      doc.getText('content').insert(0, file.content);
      [row] = await persistence.run('documents', async () => {
        const [counts] = await db.select({
          projectCount: sql<number>`count(*) filter (where ${documents.projectId} = ${projectId})`,
          totalCount: sql<number>`count(*)`,
          projectBytes: sql<number>`coalesce(sum(case when ${documents.projectId} = ${projectId} then octet_length(${documents.state}) else 0 end), 0)`,
          totalBytes: sql<number>`coalesce(sum(octet_length(${documents.state})), 0)`,
        }).from(documents);
        if (Number(counts?.projectCount || 0) >= 512 || Number(counts?.totalCount || 0) >= 8192)
          throw new Error('Collaboration document limit reached');
        const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
        if (Number(counts?.projectBytes || 0) + state.length > 64 * 1024 * 1024 || Number(counts?.totalBytes || 0) + state.length > 512 * 1024 * 1024)
          throw new Error('Collaboration storage limit reached');
        return db
        .insert(documents)
        .values({
          projectId,
          path,
          state,
          diskHash: file.hash,
        })
        .returning();
      });
    }
    if (!row) throw new Error('Could not create collaborative document');
    const awareness = new Awareness(doc);
    resources.awareness = awareness;
    awareness.setLocalState(null);
    const d: Document = {
      id: row.id,
      projectId,
      path,
      doc,
      awareness,
      diskHash: row.diskHash,
      dirty: row.dirty,
      conflict: row.conflict,
      revision: row.revision,
      clients: new Set(),
      queue: Promise.resolve(),
      closing: false,
      queuedBytes: 0,
    };
    await store(d);
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) =>
        broadcast(
          d,
          {
            type: 'awareness',
            update: Buffer.from(
              encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
            ).toString('base64'),
          },
          origin as WebSocket,
        ),
    );
    if (d.dirty && !d.conflict) schedule(d);
    evictWhenIdle(d);
    return d;
  })();
  opened.set(key(projectId, path), loading);
  try {
    return await loading;
  } catch (e) {
    resources?.awareness?.destroy(); resources?.doc.destroy();
    opened.delete(key(projectId, path));
    throw e;
  }
}
function evictWhenIdle(d: Document) {
  clearTimeout(d.idleTimer);
  if (d.clients.size || d.closing) return;
  d.idleTimer = setTimeout(() => {
    void enqueue(d, async () => {
      if (d.clients.size || d.closing) return;
      if (d.dirty && !d.conflict) await flush(d).catch(() => {});
      if (d.clients.size || d.closing) return;
      d.closing = true;
      try {
        if (!d.dirty && !d.conflict) await db.delete(documents).where(eq(documents.id, d.id));
      } catch (e) {
        d.closing = false;
        throw e;
      }
      clearTimeout(d.timer);
      d.awareness.destroy(); d.doc.destroy();
      opened.delete(key(d.projectId, d.path));
    }).catch(() => evictWhenIdle(d));
  }, 5000);
  d.idleTimer.unref();
}
function schedule(d: Document) {
  clearTimeout(d.timer);
  d.timer = setTimeout(() => {
    void enqueue(d, () => flush(d)).catch((e) =>
      broadcast(d, { type: 'error', message: (e as Error).message }),
    );
  }, 700);
}
async function flush(d: Document) {
  clearTimeout(d.timer);
  if (d.conflict)
    throw Object.assign(new Error(`Resolve the disk conflict in ${d.path} before continuing`), {
      statusCode: 409,
    });
  if (!d.dirty) return;
  try {
    const result = await bridge<{ hash: string }>(d.projectId, '/file', 'PUT', {
      path: d.path,
      content: d.doc.getText('content').toString(),
      expectedHash: d.diskHash,
    });
    d.diskHash = result.hash;
    d.dirty = false;
    await store(d);
    broadcast(d, { type: 'saved', hash: d.diskHash });
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 409) {
      d.conflict = true;
      await store(d);
      broadcast(d, { type: 'conflict' });
      emit(d.projectId, { type: 'conflict', path: d.path });
    }
    throw e;
  }
}
export async function attachDocument(
  ws: WebSocket,
  projectId: string,
  path: string,
  editable: boolean,
) {
  if (structuralChanges.has(projectId)) {
    ws.close(1012, 'File structure changing');
    return;
  }
  const d = await load(projectId, path);
  if (d.closing || structuralChanges.has(projectId)) {
    ws.close(1012, 'File structure changed');
    return;
  }
  d.clients.add(ws);
  clearTimeout(d.idleTimer);
  if (d.clients.size > 32 || ws.readyState !== 1) {
    d.clients.delete(ws); evictWhenIdle(d); ws.close(1013, 'Document connection limit reached'); return;
  }
  const ids = new Set<number>();
  let messages = 0, bytes = 0, windowStart = Date.now();
  ws.send(
    JSON.stringify({
      type: 'sync',
      update: Buffer.from(Y.encodeStateAsUpdate(d.doc)).toString('base64'),
      conflict: d.conflict,
      dirty: d.dirty,
      documentId: d.id,
      revision: d.revision,
    }),
  );
  if (d.awareness.getStates().size)
    ws.send(
      JSON.stringify({
        type: 'awareness',
        update: Buffer.from(
          encodeAwarenessUpdate(d.awareness, [...d.awareness.getStates().keys()]),
        ).toString('base64'),
      }),
    );
  ws.on('message', (raw) => {
    if (ws.readyState !== 1) return;
    if (Date.now() - windowStart >= 1000) { messages = 0; bytes = 0; windowStart = Date.now(); }
    if (++messages > 120 || (bytes += Buffer.byteLength(String(raw))) > 4 * 1024 * 1024) {
      ws.close(1008, 'Document message limit reached'); return;
    }
    let message: { type: string; update?: string; requestId?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === 'update') {
      if (d.closing) {
        ws.close(1012, 'File structure changing');
        return;
      }
      if (!editable) {
        ws.close(1008, 'Viewers cannot edit');
        return;
      }
      if (typeof message.update !== 'string') return;
      const update = Buffer.from(message.update, 'base64');
      if (d.queuedBytes + update.length > 8 * 1024 * 1024) { ws.close(1008, 'Document update queue full'); return; }
      d.queuedBytes += update.length;
      void enqueue(d, async () => {
        let candidate: Y.Doc | undefined;
        const previousDirty = d.dirty;
        try {
          candidate = validateUpdate(d.doc, update);
          d.dirty = true;
          await store(d, candidate);
          Y.applyUpdate(d.doc, update);
          broadcast(
            d,
            { type: 'update', update: message.update, requestId: message.requestId },
            ws,
          );
          if (ws.readyState === 1)
            ws.send(
              JSON.stringify({
                type: 'ack',
                requestId: message.requestId,
                documentId: d.id,
                revision: d.revision,
              }),
            );
          schedule(d);
        } catch (e) {
          d.dirty = previousDirty;
          ws.close(1008, 'Document update rejected');
          throw e;
        } finally {
          candidate?.destroy();
          d.queuedBytes -= update.length;
        }
      }).catch((e) => emit(projectId, { type: 'error', message: (e as Error).message }));
    } else if (message.type === 'awareness' && typeof message.update === 'string') {
      try {
        const update = Buffer.from(message.update, 'base64');
        const decoder = decoding.createDecoder(update);
        const count = decoding.readVarUint(decoder);
        if (count !== 1 || update.length > 4096) throw new Error('Invalid awareness size');
        for (let i = 0; i < count; i++) {
          const id = decoding.readVarUint(decoder);
          const clock = decoding.readVarUint(decoder);
          const state = decoding.readVarString(decoder);
          if (!Number.isSafeInteger(id) || !Number.isSafeInteger(clock) ||
              (ids.size && !ids.has(id)) || (!ids.has(id) && d.awareness.meta.has(id)))
            throw new Error('Awareness identity cannot change');
          const value = JSON.parse(state);
          if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid awareness state');
          ids.add(id);
        }
        if (decoder.pos !== update.length) throw new Error('Trailing awareness data');
        applyAwarenessUpdate(d.awareness, update, ws);
      } catch { ws.close(1008, 'Awareness update rejected'); }
    }
  });
  ws.on('close', () => {
    d.clients.delete(ws);
    removeAwarenessStates(d.awareness, [...ids], ws);
    for (const id of ids) d.awareness.meta.delete(id);
    evictWhenIdle(d);
  });
}
export async function flushProject(projectId: string) {
  const stored = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        or(eq(documents.dirty, true), eq(documents.conflict, true)),
      ),
    );
  for (const row of stored) await load(projectId, row.path);
  for (const [k, promise] of opened)
    if (k.startsWith(projectId + ':')) {
      const d = await promise;
      await enqueue(d, () => flush(d));
    }
}
export async function externalChange(projectId: string, path: string) {
  const p = opened.get(key(projectId, path));
  if (!p) return;
  const d = await p;
  await enqueue(d, async () => {
    if (d.closing) return;
    const file = await bridge<FileContent>(
      projectId,
      `/file?path=${encodeURIComponent(path)}`,
    ).catch((e) => {
      if (e.statusCode === 404) return { path, content: '', hash: null, size: 0, binary: false };
      throw e;
    });
    if (file.hash === d.diskHash) return;
    if (d.dirty || file.binary) {
      d.conflict = true;
      await store(d);
      broadcast(d, { type: 'conflict' });
      return;
    }
    const text = d.doc.getText('content');
    let update: Uint8Array | null = null;
    const capture = (value: Uint8Array) => (update = value);
    d.doc.on('update', capture);
    d.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, file.content);
    });
    d.doc.off('update', capture);
    d.diskHash = file.hash;
    d.conflict = false;
    await store(d);
    if (update) broadcast(d, { type: 'update', update: Buffer.from(update).toString('base64') });
    broadcast(d, { type: 'saved', hash: d.diskHash });
  });
}
export async function resolveConflict(projectId: string, path: string, choice: 'disk' | 'editor') {
  const d = await load(projectId, path);
  return enqueue(d, async () => {
    const file = await bridge<FileContent>(
      projectId,
      `/file?path=${encodeURIComponent(path)}`,
    ).catch((e) => {
      if (e.statusCode === 404) return { path, content: '', hash: null, size: 0, binary: false };
      throw e;
    });
    d.diskHash = file.hash;
    d.conflict = false;
    if (choice === 'disk') {
      if (file.binary) throw new Error('The disk file is binary or too large; download it instead');
      const text = d.doc.getText('content');
      let update: Uint8Array | null = null;
      const capture = (value: Uint8Array) => (update = value);
      d.doc.on('update', capture);
      d.doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, file.content);
      });
      d.doc.off('update', capture);
      d.dirty = false;
      await store(d);
      if (update) broadcast(d, { type: 'update', update: Buffer.from(update).toString('base64') });
    } else {
      d.dirty = true;
      await store(d);
      await flush(d);
    }
    broadcast(d, { type: 'resolved' });
    return { ok: true };
  });
}
export async function closeDocuments(projectId: string) {
  for (const [k, promise] of opened)
    if (k.startsWith(projectId + ':')) {
      const d = await promise;
      d.closing = true;
      clearTimeout(d.timer);
      clearTimeout(d.idleTimer);
      await d.queue.catch(() => {});
      for (const ws of d.clients) ws.close(1012, 'Workspace files changed');
      d.awareness.destroy();
      d.doc.destroy();
      opened.delete(k);
    }
}
/** Stop new joins and drain accepted edits before moving files, so watcher events cannot recreate them. */
export async function structure<T>(
  projectId: string,
  from: string,
  to: string | undefined,
  operation: () => Promise<T>,
) {
  const releaseFileEvents = deferFileEvents(projectId);
  structuralChanges.add(projectId);
  try {
    await flushProject(projectId);
    const docs = await Promise.all(
      [...opened.entries()].filter(([k]) => k.startsWith(projectId + ':')).map(([, d]) => d),
    );
    for (const d of docs) {
      d.closing = true;
      clearTimeout(d.timer);
    }
    for (const d of docs) await enqueue(d, () => flush(d));
    await closeDocuments(projectId);
    const result = await operation();
    const rows = await db.select().from(documents).where(eq(documents.projectId, projectId));
    await db.transaction(async (tx) => {
      for (const row of rows)
        if (row.path === from || row.path.startsWith(from + '/')) {
          if (to)
            await tx
              .update(documents)
              .set({
                path: to + row.path.slice(from.length),
                revision: sql`${documents.revision} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(documents.id, row.id));
          else await tx.delete(documents).where(eq(documents.id, row.id));
        }
    });
    await emit(projectId, { type: 'structure', from, to: to || null });
    return result;
  } finally {
    releaseFileEvents();
    structuralChanges.delete(projectId);
    for (const [k, d] of opened) if (k.startsWith(projectId + ':')) (await d).closing = false;
  }
}

export async function reconcileFiles(projectId: string) {
  for (const [k, promise] of opened)
    if (k.startsWith(projectId + ':')) await externalChange(projectId, (await promise).path);
}
