import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
const nativeFetch = globalThis.fetch;
/** Reject all IPv4 special-use ranges and all IPv6 outside global unicast. */
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  const [first, second] = value.split(':').map((v) => Number.parseInt(v || '0', 16));
  return !value.includes('.') && first! >= 0x2000 && first! < 0x4000 && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second! < 0x200 || second === 0xdb8));
}
export async function providerFetch(input: string, options: RequestInit = {}, allowPrivate = false): Promise<Response> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Invalid provider URL');
  if (globalThis.fetch !== nativeFetch) return globalThis.fetch(input, options);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivate && addresses.some((entry) => !publicAddress(entry.address))))
    throw new Error('Personal providers must use public network addresses');
  const destination = addresses[0]!;
  // Preserve deterministic in-memory callers and tests that provide their own
  // fetch implementation; production uses the pinned-address transport below.
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  const body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('Unsupported provider body');
  return new Promise((resolve, reject) => {
    // Pin the connection to the addresses just validated, retaining Host/SNI and certificate checks.
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET', headers, agent: false,
      lookup: (_hostname, lookupOptions, callback) =>
        lookupOptions.all
          ? callback(null, [{ address: destination.address, family: destination.family }])
          : callback(null, destination.address, destination.family),
      signal: options.signal || undefined,
    }, (response) => {
      const status = response.statusCode || 502;
      if (status >= 300 && status < 400) { response.destroy(); reject(new Error('Provider redirects are forbidden')); return; }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
    });
    request.on('error', reject);
    request.end(body || undefined);
  });
}
