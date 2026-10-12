/** Project-side streaming adapter. No provider credential crosses this IPC channel. */
function createProviderFetch(request, notify, originalFetch, baseUrl) {
  const streams = new Map();
  const custom = baseUrl ? baseUrl.replace(/\/+$/, '') + '/responses' : null;
  const fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url !== custom && req.url !== 'https://chatgpt.com/backend-api/codex/responses')
      return originalFetch(input, init);
    const streamId = require('node:crypto').randomUUID();
    let controller;
    const cancel = () => { streams.delete(streamId); notify('repellet/provider/cancel', { streamId }); };
    const body = new ReadableStream({
      start(value) { controller = value; },
      cancel,
    });
    streams.set(streamId, controller);
    const abort = () => { controller.error(new Error('Provider request aborted')); cancel(); };
    req.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await request('repellet/provider/request', {
        streamId, url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text(),
      }, req.signal);
      if (result.error) { cancel(); return new Response(result.error, { status: result.status }); }
      return new Response(body, { status: result.status, headers: result.headers });
    } catch (error) { cancel(); throw error; }
    finally { req.signal.removeEventListener('abort', abort); }
  };
  const chunk = ({ streamId, data, done, error }) => {
    const controller = streams.get(streamId);
    if (!controller) return;
    if (error || done) {
      streams.delete(streamId);
      error ? controller.error(new Error('Provider stream failed')) : controller.close();
    } else if (typeof data === 'string') controller.enqueue(Buffer.from(data, 'base64'));
  };
  return { fetch, chunk };
}
module.exports = { createProviderFetch };
