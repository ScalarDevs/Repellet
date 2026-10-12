// Disposable credential holder: no project mounts, hooks, attributes, or repository configuration.
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
async function main(input) {
  const url = new URL(input.remote);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)) throw new Error('Invalid Git credential target');
  if (!['clone', 'pull', 'push'].includes(input.action) || typeof input.token !== 'string' || !input.token || input.token.length > 4096 || /[\r\n]/.test(input.token)) throw new Error('Invalid Git transport request');
  if (input.action !== 'clone' && (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(input.branch || '') || input.branch.includes('..'))) throw new Error('Invalid branch');
  const dir = await fs.mkdtemp('/tmp/git-transport-');
  const env = { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' };
  const git = (args, authenticated = false) => exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', ...args], {
    cwd: dir, timeout: 120000, maxBuffer: 1024 * 1024,
    env: authenticated ? { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + input.token).toString('base64') } : env,
  });
  try {
    await git(['init', '--bare', 'repository']);
    const repo = ['--git-dir=' + dir + '/repository'];
    if (input.action !== 'clone') {
      if (typeof input.bundle !== 'string' || input.bundle.length > 180 * 1024 * 1024) throw new Error('Git bundle too large');
      await fs.writeFile(dir + '/input.bundle', Buffer.from(input.bundle, 'base64'), { mode: 0o600 });
      await git([...repo, 'fetch', dir + '/input.bundle', `refs/heads/${input.branch}:refs/heads/${input.branch}`]);
      await git([...repo, 'symbolic-ref', 'HEAD', `refs/heads/${input.branch}`]);
    }
    if (input.action === 'push') {
      await git([...repo, 'push', input.remote, `refs/heads/${input.branch}:refs/heads/${input.branch}`], true);
      await git([...repo, 'update-ref', `refs/remotes/origin/${input.branch}`, `refs/heads/${input.branch}`]);
    } else {
      await git([...repo, 'fetch', input.remote, '+refs/heads/*:refs/remotes/origin/*'], true);
      if (input.action === 'clone') {
        const result = await git([...repo, 'ls-remote', '--symref', input.remote, 'HEAD'], true);
        const branch = /^ref: refs\/heads\/([^\s]+)\s+HEAD/m.exec(result.stdout)?.[1];
        if (!branch || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..')) throw new Error('Remote has no default branch');
        await git([...repo, 'update-ref', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]);
        await git([...repo, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      }
    }
    await git([...repo, 'bundle', 'create', dir + '/result.bundle', '--all', 'HEAD']);
    const stat = await fs.stat(dir + '/result.bundle');
    if (stat.size > 128 * 1024 * 1024) throw new Error('Git transfer exceeds 128 MiB');
    return { bundle: (await fs.readFile(dir + '/result.bundle')).toString('base64') };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; if (data.length > 181 * 1024 * 1024) process.exit(1); });
  process.stdin.on('end', () => void main(JSON.parse(data)).then((result) => process.stdout.write(JSON.stringify(result))).catch(() => { process.stderr.write('Authenticated Git transport failed'); process.exitCode = 1; }));
}
module.exports = { main };
