import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WebSocket } from 'ws';
import { getEnvironment } from './terminals.js';
import { root } from './files.js';
import { projectIdentity } from './process-security.js';
const processes = new Set<ChildProcessWithoutNullStreams>();
const commands: Record<string, [string, string[]]> = {
  python: [
    '/opt/repellet/node/bin/node',
    ['/opt/language-tools/node_modules/pyright/langserver.index.js', '--stdio'],
  ],
  node: [
    '/opt/repellet/node/bin/node',
    ['/opt/language-tools/node_modules/typescript-language-server/lib/cli.mjs', '--stdio'],
  ],
  go: ['/opt/go-tools/bin/gopls', ['serve']],
  rust: ['/opt/rust/cargo/bin/rust-analyzer', []],
};
export function attachLanguage(ws: WebSocket, language: string) {
  const command = commands[language];
  if (!command) {
    ws.close(1008, 'Unsupported language');
    return;
  }
  if (processes.size >= 8) {
    ws.close(1013, 'Language service capacity reached');
    return;
  }
  const child = spawn(command[0], command[1], { ...projectIdentity(), cwd: root, env: getEnvironment(), stdio: 'pipe' });
  processes.add(child);
  let buffer = Buffer.alloc(0);
  let stderr = '';
  let stopped = false;
  let idle: NodeJS.Timeout;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(idle);
    child.kill('SIGTERM');
    // Retain capacity until the process actually exits.
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    kill.unref();
    child.once('exit', () => clearTimeout(kill));
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { ws.close(1000, 'Language service idle'); stop(); }, 10 * 60000);
    idle.unref();
  };
  touch();
  child.stdout.on('data', (chunk: Buffer) => {
    if (buffer.length + chunk.length > 16 * 1024 * 1024) {
      ws.close(1011, 'Language-server response too large');
      stop();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const length = Number(
        /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
      );
      if (!Number.isFinite(length) || length > 16 * 1024 * 1024) {
        ws.close(1011, 'Invalid language-server response');
        stop();
        return;
      }
      if (buffer.length < end + 4 + length) break;
      const message = buffer.subarray(end + 4, end + 4 + length);
      buffer = buffer.subarray(end + 4 + length);
      if (ws.bufferedAmount > 4 * 1024 * 1024) {
        ws.close(1013, 'Language client is too slow'); stop(); return;
      }
      if (ws.readyState === 1) ws.send(message.toString());
    }
  });
  child.stderr.on('data', (data) => (stderr = (stderr + String(data)).slice(-4096)));
  child.on('error', (e) => {
    clearTimeout(idle);
    processes.delete(child);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ method: 'repellet/error', params: { message: e.message } }));
      ws.close(1011, 'Language service unavailable');
    }
  });
  child.on('exit', () => {
    clearTimeout(idle);
    processes.delete(child);
    if (ws.readyState === 1) {
      if (stderr)
        ws.send(JSON.stringify({ method: 'repellet/error', params: { message: stderr } }));
      ws.close(1000, 'Language service stopped');
    }
  });
  ws.on('message', (raw) => {
    if (stopped) return;
    touch();
    if (Buffer.byteLength(String(raw)) > 4 * 1024 * 1024 || child.stdin.writableLength > 4 * 1024 * 1024) {
      ws.close(1013, 'Language input limit reached'); stop(); return;
    }
    try {
      const message = JSON.parse(String(raw));
      if (message.method === 'workspace/executeCommand') return;
      const body = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch {}
  });
  ws.on('close', stop);
}
export function stopLanguages() {
  for (const child of processes) child.kill('SIGTERM');
  processes.clear();
}
