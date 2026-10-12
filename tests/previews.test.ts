import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  config: {
    inDocker: true,
    publicUrl: 'https://night-mac.example.ts.net:3000',
    portRange: [42000, 42003],
    token: 'preview-test-worker-secret'.repeat(2),
  },
  inspect: vi.fn(),
  request: vi.fn(),
  createServer: vi.fn(),
  createProxyServer: vi.fn(),
  responseStatus: vi.fn<(destination: string, options: http.RequestOptions) => number | null>(),
}));
vi.mock('../apps/worker/src/config.js', () => ({ config: fake.config }));
vi.mock('../apps/worker/src/workspaces.js', () => ({
  inspect: fake.inspect,
  containerName: (id: string) => `repellet-project-${id}`,
}));
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      request: fake.request,
      createServer: fake.createServer,
    },
  };
});
vi.mock('http-proxy', () => ({
  default: { createProxyServer: fake.createProxyServer },
}));

import { enablePreview, disablePreview, probePreview, revokePreview } from '../apps/worker/src/previews.js';

type Request = EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
const requests: Request[] = [];
const responses: { statusCode: number; destroy: ReturnType<typeof vi.fn> }[] = [];
let testEpoch = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(testEpoch += 120000);
  requests.length = 0;
  responses.length = 0;
  fake.config.inDocker = true;
  fake.config.publicUrl = 'https://night-mac.example.ts.net:3000';
  fake.inspect.mockReset().mockResolvedValue({
    State: { Running: true },
    NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: '53000' }] } },
  });
  fake.responseStatus.mockReset().mockReturnValue(200);
  fake.createProxyServer.mockReset().mockImplementation(() => new EventEmitter());
  fake.createServer.mockReset().mockImplementation(() => {
    const server = new EventEmitter();
    return Object.assign(server, {
      listen: vi.fn((_port: number, _host: string, ready: () => void) => ready()),
      closeAllConnections: vi.fn(),
      close: vi.fn((closed: () => void) => closed()),
    });
  });
  fake.request
    .mockReset()
    .mockImplementation(
      (
        destination: string,
        options: http.RequestOptions,
        receive: (response: http.IncomingMessage) => void,
      ) => {
        const request = Object.assign(new EventEmitter(), {
          end: vi.fn(() => {
            const statusCode = fake.responseStatus(destination, options);
            if (statusCode === null) return;
            const response = { statusCode, destroy: vi.fn() };
            responses.push(response);
            receive(response as unknown as http.IncomingMessage);
          }),
          destroy: vi.fn((error?: Error) => {
            if (error) request.emit('error', error);
            return request;
          }),
        });
        requests.push(request);
        return request;
      },
    );
});
afterEach(async () => {
  await disablePreview('project');
  await disablePreview('other-project');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function gatewayRequest(method = 'GET', origin?: string) {
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(function(this: EventEmitter) { this.emit('close'); }) });
  return { method, headers: { origin, cookie: 'repellet_session=test' }, socket } as unknown as http.IncomingMessage;
}
async function authenticatedGateway(expiresIn = 120000) {
  const proxy = Object.assign(new EventEmitter(), { web: vi.fn(), ws: vi.fn() });
  fake.createProxyServer.mockReturnValue(proxy);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ userId: 'user', sessionId: 'session', expiresAt: new Date(Date.now() + expiresIn).toISOString() }))));
  await enablePreview('project', 3000, 42001);
  const handle = fake.createServer.mock.calls[0]![0] as (req: http.IncomingMessage, res: any) => Promise<void>;
  return { proxy, handle, response: () => ({ writeHead: vi.fn(), end: vi.fn() }) };
}
it('rejects cross-port and missing-Origin writes while allowing exact-origin writes and navigation', async () => {
  const { proxy, handle, response } = await authenticatedGateway();
  for (const origin of [undefined, 'https://night-mac.example.ts.net:42002', 'null']) {
    const res = response(); await handle(gatewayRequest('POST', origin), res);
    expect(res.writeHead).toHaveBeenCalledWith(403);
  }
  expect(proxy.web).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await handle(gatewayRequest('POST', 'https://night-mac.example.ts.net:42001'), response());
  await handle(gatewayRequest(), response());
  expect(proxy.web).toHaveBeenCalledTimes(2);
});
it('closes only the authorizing session on logout and closes streams at expiry', async () => {
  const { handle, response } = await authenticatedGateway(1000);
  const req = gatewayRequest(); await handle(req, response());
  await vi.advanceTimersByTimeAsync(999); expect(req.socket.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(req.socket.destroy).toHaveBeenCalledOnce();
  const another = gatewayRequest(); await handle(another, response());
  revokePreview(undefined, undefined, 'unrelated'); expect(another.socket.destroy).not.toHaveBeenCalled();
  revokePreview(undefined, undefined, 'session'); expect(another.socket.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects authorization completing after a logout revocation and revalidates long streams', async () => {
  const { handle, response, proxy } = await authenticatedGateway();
  const request = gatewayRequest(); await handle(request, response());
  vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 403 }));
  await vi.advanceTimersByTimeAsync(60000);
  expect(request.socket.destroy).toHaveBeenCalledOnce();
  let complete!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
  const late = gatewayRequest(); const res = response(); const pending = handle(late, res);
  revokePreview(undefined, undefined, 'revoked');
  complete(new Response(JSON.stringify({ userId: 'user', sessionId: 'revoked', expiresAt: new Date(Date.now() + 10000).toISOString() })));
  await pending;
  expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object)); expect(proxy.web).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  'uses the public preview Host and the internal target (inDocker=%s)',
  async (inDocker) => {
    fake.config.inDocker = inDocker;
    await enablePreview('project', 3000, 42001);
    expect(await probePreview('project', 3000)).toEqual({ responding: true, httpStatus: 200 });
    expect(fake.request).toHaveBeenCalledExactlyOnceWith(
      inDocker ? 'http://repellet-project-project:3000' : 'http://127.0.0.1:53000',
      { method: 'GET', headers: { host: 'night-mac.example.ts.net:42001' } },
      expect.any(Function),
    );
    expect(requests[0]!.end).toHaveBeenCalledOnce();
    expect(responses[0]!.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('avoids a host-sensitive 403 without allowing the Docker hostname', async () => {
  const statusForHost = (host: string) =>
    new URL(`http://${host}`).hostname === 'night-mac.example.ts.net' ? 200 : 403;
  expect(statusForHost('repellet-project-project:3000')).toBe(403);
  fake.responseStatus.mockImplementation((destination, options) =>
    statusForHost((options.headers as Record<string, string>).host || new URL(destination).host),
  );
  await enablePreview('project', 3000, 42001);
  expect(await probePreview('project', 3000)).toEqual({ responding: true, httpStatus: 200 });
});

it('preserves brackets in an IPv6 preview Host', async () => {
  fake.config.publicUrl = 'https://[fd00::1234]:3000';
  await enablePreview('project', 3000, 42002);
  expect(await probePreview('project', 3000)).toEqual({ responding: true, httpStatus: 200 });
  expect(fake.request.mock.calls[0]![1].headers).toEqual({ host: '[fd00::1234]:42002' });
});

it('uses the allocated listener port, including allocation fallback', async () => {
  await enablePreview('other-project', 3000, 42001);
  const allocated = await enablePreview('project', 3000, 42001);
  expect(allocated).toBe(42000);
  await probePreview('project', 3000);
  expect(fake.request.mock.calls[0]![1].headers).toEqual({
    host: 'night-mac.example.ts.net:42000',
  });
});

it('does not probe without a listener matching both the project and target port', async () => {
  expect(await probePreview('project', 3000)).toEqual({ responding: false });
  await enablePreview('other-project', 3000);
  expect(await probePreview('project', 3000)).toEqual({ responding: false });
  await enablePreview('project', 8000);
  expect(await probePreview('project', 3000)).toEqual({ responding: false });
  expect(fake.inspect).not.toHaveBeenCalled();
  expect(fake.request).not.toHaveBeenCalled();
});

it.each([null, { State: { Running: false } }])(
  'does not probe a missing or stopped workspace (%j)',
  async (workspace) => {
    fake.inspect.mockResolvedValue(workspace);
    await enablePreview('project', 3000);
    expect(await probePreview('project', 3000)).toEqual({ responding: false });
    expect(fake.request).not.toHaveBeenCalled();
  },
);

it('does not probe a local workspace without a mapped target port', async () => {
  fake.config.inDocker = false;
  fake.inspect.mockResolvedValue({
    State: { Running: true },
    NetworkSettings: { Ports: {} },
  });
  await enablePreview('project', 3000);
  expect(await probePreview('project', 3000)).toEqual({ responding: false });
  expect(fake.request).not.toHaveBeenCalled();
});

it('treats workspace inspection errors as not responding', async () => {
  fake.inspect.mockRejectedValue(new Error('Inspection failed'));
  await enablePreview('project', 3000);
  expect(await probePreview('project', 3000)).toEqual({ responding: false });
  expect(fake.request).not.toHaveBeenCalled();
});

it.each([204, 301, 302, 307, 403, 500])(
  'reports HTTP %s without following redirects or consuming a response body',
  async (statusCode) => {
    fake.responseStatus.mockReturnValue(statusCode);
    await enablePreview('project', 3000);
    expect(await probePreview('project', 3000)).toEqual({
      responding: true,
      httpStatus: statusCode,
    });
    expect(fake.request).toHaveBeenCalledOnce();
    expect(responses[0]!.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('returns not responding on connection errors and clears the deadline', async () => {
  fake.responseStatus.mockReturnValue(null);
  await enablePreview('project', 3000);
  const result = probePreview('project', 3000);
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(1);
  requests[0]!.emit('error', new Error('ECONNREFUSED'));
  expect(await result).toEqual({ responding: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('destroys a stalled request at the two-second deadline', async () => {
  fake.responseStatus.mockReturnValue(null);
  await enablePreview('project', 3000);
  const result = probePreview('project', 3000);
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(requests[0]!.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ responding: false });
  expect(requests[0]!.destroy).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'Preview probe timed out' }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it('returns a fresh successful status after a genuine HTTP error', async () => {
  await enablePreview('project', 3000);
  fake.responseStatus.mockReturnValueOnce(403).mockReturnValueOnce(200);
  expect(await probePreview('project', 3000)).toEqual({ responding: true, httpStatus: 403 });
  expect(await probePreview('project', 3000)).toEqual({ responding: true, httpStatus: 200 });
});
