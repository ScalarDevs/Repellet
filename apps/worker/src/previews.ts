import http from 'node:http';
import httpProxy from 'http-proxy';
import type { Socket } from 'node:net';
import { config } from './config.js';
import { inspect, containerName } from './workspaces.js';
import { encodePreviewCookie, decodePreviewCookies } from './preview-cookies.js';

type Preview = { server: http.Server; project: string; targetPort: number };
const previews = new Map<number, Preview>();
type Identity = { userId: string; sessionId: string; expiresAt: string };
const activeSockets = new Map<Socket, Identity & { projectId: string; timer: NodeJS.Timeout }>();
let authorizationGeneration = 0;
export function revokePreview(userId?: string, projectId?: string, sessionId?: string) {
  authorizationGeneration++;
  for (const [socket, identity] of activeSockets)
    if ((!userId || identity.userId === userId) && (!projectId || identity.projectId === projectId) && (!sessionId || identity.sessionId === sessionId)) socket.destroy();
}
function remember(req: http.IncomingMessage, identity: Identity, projectId: string) {
  const socket = req.socket;
  const remaining = Date.parse(identity.expiresAt) - Date.now();
  if (!identity.sessionId || !Number.isFinite(remaining) || remaining <= 0 || socket.destroyed) {
    socket.destroy(); return false;
  }
  const old = activeSockets.get(socket);
  clearTimeout(old?.timer);
  const cookie = req.headers.cookie || '';
  const timer = setTimeout(async () => {
    if (remaining <= 60000) { socket.destroy(); return; }
    const next = await allowed({ headers: { cookie } } as http.IncomingMessage, projectId);
    if (activeSockets.get(socket)?.timer !== timer) return;
    if (!next || next.sessionId !== identity.sessionId) socket.destroy();
    else remember({ socket, headers: { cookie } } as http.IncomingMessage, next, projectId);
  }, Math.min(remaining, 60000));
  timer.unref();
  activeSockets.set(socket, { ...identity, projectId, timer });
  if (!old) socket.once('close', () => {
    clearTimeout(activeSockets.get(socket)?.timer);
    activeSockets.delete(socket);
  });
  return true;
}
function previewOrigins(port: number) {
  return [config.publicUrl, ...(process.env.ADDITIONAL_ORIGINS || '').split(',').filter(Boolean)].map((address) => {
    const url = new URL(address); url.port = String(port); return url.origin;
  });
}
async function allowed(request: http.IncomingMessage, id: string) {
  const generation = authorizationGeneration;
  try {
    const response = await fetch(`${config.appUrl}/internal/authorize-preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: id, cookie: request.headers.cookie || '' }),
      signal: AbortSignal.timeout(5000),
    });
    const identity = response.ok ? ((await response.json()) as Identity) : null;
    return generation === authorizationGeneration ? identity : null;
  } catch {
    return null;
  }
}
async function target(id: string, port: number) {
  const state = await inspect(id);
  if (!state?.State.Running) throw new Error('Workspace is stopped');
  if (config.inDocker) return `http://${containerName(id)}:${port}`;
  const binding = state.NetworkSettings.Ports[`${port}/tcp`]?.[0];
  if (!binding) throw new Error('Restart the workspace after changing its preview port');
  return `http://127.0.0.1:${binding.HostPort}`;
}
function cleanCookies(req: http.IncomingMessage, id: string) {
  delete req.headers.authorization;
  delete req.headers['x-worker-token'];
  req.headers.cookie = decodePreviewCookies(id, req.headers.cookie || '');
  if (!req.headers.cookie) delete req.headers.cookie;
}
function sanitizeResponse(response: http.IncomingMessage, id: string) {
  const cookies = response.headers['set-cookie'];
  if (cookies) response.headers['set-cookie'] = cookies.map((c) => encodePreviewCookie(id, c)).filter((c): c is string => c !== null);
  delete response.headers['clear-site-data'];
}
export function listPreviews() {
  return [...previews.entries()].map(([port, p]) => ({
    projectId: p.project,
    port,
    targetPort: p.targetPort,
  }));
}
export async function probePreview(
  id: string,
  targetPort: number,
): Promise<{ responding: boolean; httpStatus?: number }> {
  const preview = [...previews.entries()].find(
    ([, p]) => p.project === id && p.targetPort === targetPort,
  );
  if (!preview) return { responding: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const destination = await target(id, targetPort);
    const publicUrl = new URL(config.publicUrl);
    publicUrl.port = String(preview[0]);
    return await new Promise<{ responding: boolean; httpStatus?: number }>((resolve, reject) => {
      // Node fetch strips Host overrides. Match the gateway's public Host while
      // connecting directly to the workspace, without forwarding IDE credentials.
      const request = http.request(
        destination,
        { method: 'GET', headers: { host: publicUrl.host } },
        (response) => {
          response.destroy();
          resolve({ responding: true, httpStatus: response.statusCode });
        },
      );
      request.once('error', reject);
      timer = setTimeout(() => request.destroy(new Error('Preview probe timed out')), 2000);
      request.end();
    });
  } catch {
    return { responding: false };
  } finally {
    clearTimeout(timer);
  }
}
export async function enablePreview(id: string, targetPort: number, requested?: number | null) {
  const existing = [...previews.entries()].find(([, p]) => p.project === id);
  if (existing && existing[1].targetPort === targetPort) return existing[0];
  if (existing) await disablePreview(id);
  const [start, end] = config.portRange as [number, number];
  const port =
    requested && requested >= start && requested <= end && !previews.has(requested)
      ? requested
      : Array.from({ length: end - start + 1 }, (_, i) => start + i).find((p) => !previews.has(p));
  if (!port)
    throw Object.assign(
      new Error('No preview ports available; stop another workspace or expand PREVIEW_PORT_RANGE'),
      { statusCode: 409 },
    );
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });
  proxy.on('proxyRes', (proxyRes) => {
    sanitizeResponse(proxyRes, id);
    delete proxyRes.headers['x-frame-options'];
    proxyRes.headers['content-security-policy'] =
      `frame-ancestors ${new URL(config.publicUrl).origin} ${(process.env.ADDITIONAL_ORIGINS || '').split(',').filter(Boolean).join(' ')}`;
  });
  proxy.on('proxyReqWs', (request) => {
    request.on('upgrade', (response) => sanitizeResponse(response, id));
    request.on('response', (response) => sanitizeResponse(response, id));
  });
  proxy.on('error', (_error, _req, res) => {
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body style="background:#141619;color:#bfc4cb;font:14px system-ui;padding:32px"><h2>Waiting for your app</h2><p>Start the project’s run command and make sure the server listens on <code>0.0.0.0</code> at the configured preview port.</p></body></html>',
      );
    } else if ('destroy' in res) res.destroy();
  });
  const server = http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method || '') && !previewOrigins(port).includes(req.headers.origin || '')) {
      res.writeHead(403); res.end('Preview origin rejected'); return;
    }
    const identity = await allowed(req, id);
    if (!identity) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Sign in to Repellet with a project member account to view this preview.');
      return;
    }
    if (!remember(req, identity, id)) return;
    try {
      cleanCookies(req, id);
      const destination = await target(id, targetPort);
      proxy.web(req, res, { target: destination, ignorePath: false });
    } catch {
      res.writeHead(503);
      res.end('Workspace is stopped');
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    const origins = previewOrigins(port);
    if (!req.headers.origin || !origins.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const identity = await allowed(req, id);
    if (!identity) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!remember(req, identity, id)) return;
    try {
      cleanCookies(req, id);
      proxy.ws(req, socket as Socket, head, { target: await target(id, targetPort) });
    } catch {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  previews.set(port, { server, project: id, targetPort });
  return port;
}
export async function disablePreview(id: string) {
  authorizationGeneration++;
  for (const [port, p] of previews)
    if (p.project === id) {
      for (const [socket, identity] of activeSockets)
        if (identity.projectId === id) socket.destroy();
      p.server.closeAllConnections();
      await new Promise<void>((resolve) => p.server.close(() => resolve()));
      previews.delete(port);
    }
}
