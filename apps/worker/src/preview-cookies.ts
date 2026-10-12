import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';
const key = () => createHmac('sha256', config.token).update('preview-cookie-encryption:v1').digest();
const prefix = (project: string) => `repellet_preview_${createHmac('sha256', key()).update(project).digest('hex').slice(0, 32)}_`;
/** Port-based previews require authenticated, project-scoped, HttpOnly cookies. */
export function encodePreviewCookie(project: string, cookie: string): string | null {
  const [pair, ...attributes] = cookie.split(';');
  const at = pair!.indexOf('=');
  const name = pair!.slice(0, at).trim();
  if (at < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^repellet_session$/i.test(name)) return null;
  if (attributes.some((a) => /^\s*domain\s*=/i.test(a))) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`${project}:${name}`));
  const value = Buffer.concat([iv, cipher.update(pair!.slice(at + 1)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  const physicalName = prefix(project) + Buffer.from(name).toString('base64url');
  const result = `${physicalName}=${value};${attributes.filter((a) => !/^\s*httponly\s*$/i.test(a)).join(';')}; HttpOnly`;
  return Buffer.byteLength(result) <= 4096 ? result : null;
}
export function decodePreviewCookies(project: string, header: string): string {
  const expected = prefix(project);
  const cookies: string[] = [];
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    const physicalName = pair.slice(0, at).trim();
    if (!physicalName.startsWith(expected)) continue;
    try {
      const name = Buffer.from(physicalName.slice(expected.length), 'base64url').toString();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^repellet_session$/i.test(name)) continue;
      const value = Buffer.from(pair.slice(at + 1), 'base64url');
      if (value.length < 28 || value.length > 4096) continue;
      const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${project}:${name}`));
      decipher.setAuthTag(value.subarray(-16));
      const plain = Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString();
      if (/[;\r\n\0]/.test(plain)) continue;
      cookies.push(`${name}=${plain}`);
    } catch { /* Unauthenticated or other-project cookies never reach applications. */ }
  }
  return cookies.join('; ');
}
