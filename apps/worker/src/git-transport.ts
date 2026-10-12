import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { docker, BASE_IMAGE } from './images.js';
import { bridgeRequest } from './workspaces.js';
const inputSchema = z.object({
  action: z.enum(['clone', 'pull', 'push']), url: z.string().optional(),
  credential: z.object({ token: z.string().min(1).max(4096), remote: z.string().url() }).strict(),
});
export async function authenticatedGit(id: string, input: unknown): Promise<unknown> {
  const b = inputSchema.parse(input);
  const url = new URL(b.credential.remote);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)) throw new Error('Invalid credential target');
  if (b.action === 'clone' && b.url !== b.credential.remote) throw new Error('Clone target changed');
  const snapshot = b.action === 'clone' ? {} : await (await bridgeRequest(id, '/git/export', 'POST', { remote: b.credential.remote })).json() as { bundle: string; branch: string };
  const container = await docker.createContainer({
    Image: BASE_IMAGE, User: '1000:1000', Entrypoint: ['/opt/repellet/node/bin/node', '/opt/repellet/git-transport.cjs'],
    AttachStdin: true, OpenStdin: true, StdinOnce: true, AttachStdout: true, AttachStderr: true,
    Env: ['HOME=/tmp'], Labels: { 'repellet.helper': 'true', 'repellet.project': id },
    HostConfig: { NetworkMode: 'bridge', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PidsLimit: 32, Memory: 768 * 1024 * 1024, NanoCpus: 1e9, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m,mode=1777' } },
  });
  const timeout = setTimeout(() => void container.kill().catch(() => {}), 150000);
  timeout.unref();
  try {
    const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
    const output = new PassThrough(), errors = new PassThrough();
    docker.modem.demuxStream(stream, output, errors); errors.resume();
    const chunks: Buffer[] = []; let size = 0;
    output.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 180 * 1024 * 1024) chunks.push(chunk); else (stream as import('node:stream').Duplex).destroy(new Error('Git transfer too large')); });
    const done = new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
    await container.start();
    stream.end(JSON.stringify({ ...snapshot, action: b.action, remote: b.credential.remote, token: b.credential.token }));
    await done;
    if ((await container.wait()).StatusCode !== 0 || size > 180 * 1024 * 1024) throw new Error('Authenticated Git transport failed');
    const result = JSON.parse(Buffer.concat(chunks).toString());
    // The workspace receives Git objects and references, never the provider token.
    return await (await bridgeRequest(id, '/git/import', 'POST', { action: b.action, remote: b.credential.remote, ...result })).json();
  } finally { clearTimeout(timeout); await container.remove({ force: true }).catch(() => {}); }
}
