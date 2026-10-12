import * as Y from 'yjs';
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export function validateDocument(doc: Y.Doc) {
  const content = doc.getText('content');
  if ([...doc.share.keys()].some((name) => name !== 'content') ||
      content.toDelta().some((part: { insert?: unknown }) => typeof part.insert !== 'string') ||
      doc.store.pendingStructs || doc.store.pendingDs ||
      Buffer.byteLength(content.toString()) > 2 * 1024 * 1024 ||
      Y.encodeStateAsUpdate(doc).byteLength > MAX_DOCUMENT_BYTES)
    throw Object.assign(new Error('Collaborative document limit reached'), { statusCode: 413 });
}
/** Validate an isolated candidate; rejected updates must never poison retained state. */
export function validateUpdate(doc: Y.Doc, update: Uint8Array) {
  if (update.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Document update too large');
  const candidate = new Y.Doc();
  try {
    candidate.getText('content');
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(candidate, update);
    validateDocument(candidate);
    return candidate;
  } catch (error) { candidate.destroy(); throw error; }
}
