import { providerFetch } from '../provider-fetch.js';
import type { AgentPrivateSettings } from '@repellet/shared';
import type { ChatgptAuthTokensRefreshResponse } from '@repellet/agent-protocol';
import type { AgentConnection } from './connection.js';
export const brokerToken = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'repellet-broker' } })).toString('base64url')}.broker`;
/** Credentials are substituted only here, never returned over project IPC. */
export function providerBroker(settings: AgentPrivateSettings & { allowPrivateProvider?: boolean }, initial?: ChatgptAuthTokensRefreshResponse, refresh?: () => Promise<ChatgptAuthTokensRefreshResponse>) {
  let tokens = initial;
  const running = new Map<string, AbortController>();
  function transform(message: any) {
    if (message.result?.accessToken) {
      tokens = message.result;
      return { ...message, result: { ...message.result, accessToken: brokerToken, chatgptAccountId: 'repellet-broker' } };
    }
    if (message.method === 'account/login/start' && message.params?.accessToken) {
      tokens = message.params;
      return { ...message, params: { ...message.params, accessToken: brokerToken, chatgptAccountId: 'repellet-broker' } };
    }
    return message;
  }
  async function handle(connection: AgentConnection, message: any) {
    const p = message.params;
    let controller: AbortController | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!p || typeof p.streamId !== 'string' || !/^[a-f0-9-]{36}$/.test(p.streamId) || running.size >= 2 || running.has(p.streamId) || typeof p.body !== 'string' || Buffer.byteLength(p.body) > 4 * 1024 * 1024 || p.method !== 'POST') throw new Error('Invalid provider request');
      const url = new URL(p.url);
      const custom = settings.baseUrl ? new URL(settings.baseUrl.replace(/\/+$/, '') + '/responses') : null;
      const isCustom = custom?.href === url.href;
      const isChatgpt = url.href === 'https://chatgpt.com/backend-api/codex/responses';
      const model = JSON.parse(p.body).model;
      if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(model) || (!isCustom && !isChatgpt)) throw new Error('Provider target rejected');
      const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity' });
      // Preserve protocol metadata, never a caller-selected authentication or routing header.
      for (const name of ['openai-beta', 'originator', 'version', 'session_id', 'x-codex-session-id']) {
        const value = p.headers?.[name];
        if (typeof value === 'string' && value.length <= 512 && !/[\r\n]/.test(value)) headers.set(name, value);
      }
      if (isCustom) {
        if (!settings.apiKey || !settings.proxyModels?.includes(model)) throw new Error('Proxy model is not allowed');
        headers.set('authorization', `Bearer ${settings.apiKey}`);
      } else {
        if (refresh) tokens = await refresh();
        if (!tokens) throw new Error('ChatGPT is disconnected');
        headers.set('authorization', `Bearer ${tokens.accessToken}`);
        headers.set('chatgpt-account-id', tokens.chatgptAccountId);
      }
      controller = new AbortController();
      running.set(p.streamId, controller);
      const response = await providerFetch(url.href, { method: 'POST', headers, body: p.body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60000)]) }, isCustom && settings.allowPrivateProvider === true);
      if (!response.ok) {
        await response.body?.cancel();
        connection.respond(message.id, { status: response.status, headers: {}, error: 'Provider request failed' }); return;
      }
      reader = response.body?.getReader();
      connection.respond(message.id, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'text/event-stream' } });
      let size = 0;
      while (reader && !connection.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.byteLength) > 32 * 1024 * 1024) throw new Error('Provider response limit reached');
        // Small IPC frames and transport backpressure keep streaming bounded.
        for (let at = 0; at < value.length; at += 65536)
          await connection.notifyInternalAsync('repellet/provider/chunk', { streamId: p.streamId, data: Buffer.from(value.subarray(at, at + 65536)).toString('base64') }, controller.signal);
      }
      if (!connection.closed) connection.notifyInternal('repellet/provider/chunk', { streamId: p.streamId, done: true });
    } catch {
      if (!connection.closed) {
        connection.reject(message.id, 'Provider request failed');
        if (p?.streamId) connection.notifyInternal('repellet/provider/chunk', { streamId: p.streamId, error: true });
      }
    } finally { await reader?.cancel().catch(() => {}); if (controller && p?.streamId) running.delete(p.streamId); }
  }
  return {
    transform,
    intercept: (connection: AgentConnection, message: any) => {
      if (message.method === 'account/chatgptAuthTokens/refresh') {
        void (refresh ? refresh() : Promise.resolve(tokens)).then((next) => {
          tokens = next;
          if (!tokens) throw new Error('ChatGPT disconnected');
          if (!connection.closed) connection.respond(message.id, { ...tokens, accessToken: brokerToken, chatgptAccountId: 'repellet-broker' });
        }).catch(() => { if (!connection.closed) connection.reject(message.id, 'ChatGPT disconnected'); });
        return true;
      }
      if (message.method === 'repellet/provider/request') { void handle(connection, message); return true; }
      if (message.method === 'repellet/provider/cancel') { running.get(message.params?.streamId)?.abort(); return true; }
      return false;
    },
    close: () => { for (const controller of running.values()) controller.abort(); running.clear(); },
  };
}
