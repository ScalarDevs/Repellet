import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';
const MAX_BUNDLE = 128 * 1024 * 1024;
async function temporary<T>(operation: (file: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repellet-git-'));
  await fs.chmod(dir, 0o770);
  try { return await operation(path.join(dir, 'transfer.bundle')); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function assertRemote(remote: string) {
  for (const push of [false, true]) {
    const actual = (await git(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', 'origin'])).stdout.trim();
    if (actual !== remote) throw new Error('Origin remote changed. Reconnect the matching repository in settings.');
  }
}
export async function exportGit(remote: string) {
  await assertRemote(remote);
  const branch = (await git(['branch', '--show-current'])).stdout.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..')) throw new Error('Switch to a branch before transferring');
  return temporary(async (file) => {
    await git(['bundle', 'create', file, '--all', 'HEAD']);
    if ((await fs.stat(file)).size > MAX_BUNDLE) throw new Error('Git transfer exceeds 128 MiB');
    return { branch, bundle: (await fs.readFile(file)).toString('base64') };
  });
}
export async function importGit(input: { action: string; remote: string; bundle: string }) {
  if (!['clone', 'pull', 'push'].includes(input.action) || typeof input.bundle !== 'string' || input.bundle.length > Math.ceil(MAX_BUNDLE * 4 / 3)) throw new Error('Invalid Git transfer');
  if (input.action !== 'clone') await assertRemote(input.remote);
  return temporary(async (file) => {
    const data = Buffer.from(input.bundle, 'base64');
    if (data.length > MAX_BUNDLE) throw new Error('Git transfer exceeds 128 MiB');
    await fs.writeFile(file, data, { mode: 0o660, flag: 'wx' });
    if (input.action === 'clone') {
      await git(['clone', '--', file, '.']);
      await git(['remote', 'set-url', 'origin', input.remote]);
    } else {
      await git(['fetch', '--', file, '+refs/remotes/origin/*:refs/remotes/origin/*']);
      const branch = (await git(['branch', '--show-current'])).stdout.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..')) throw new Error('Switch to a branch before transferring');
      if (input.action === 'pull') await git(['merge', '--ff-only', `refs/remotes/origin/${branch}`]);
      else await git(['branch', '--set-upstream-to=origin/' + branch, branch]);
    }
    return { output: input.action === 'push' ? 'Pushed to GitHub' : input.action === 'pull' ? 'Pulled from GitHub' : 'Cloned from GitHub' };
  });
}
