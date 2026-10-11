import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { projectControlApiSchema, type TerminalInfo } from '@repellet/shared';
import type {
  ProjectControlInput,
  ProjectControlResult,
  ProjectControlStatus,
  ProjectPreparationLog,
} from '@repellet/agent-protocol';
import { db } from './db.js';
import { users, installation, projectRunProfiles, workspaceProcesses } from './schema.js';
import { config } from './config.js';
import { projectAgentAccess, tokenMatches } from './security.js';
import { bridge } from './worker.js';
import { serialize } from './lifecycle.js';
import {
  mainRunProcessIds,
  assertPrepared,
  probePreview,
  cancelReadiness,
  preparationJobs,
  prepareProject,
} from './preparation.js';
import { startProfile, stopProcess } from './processes.js';
import { flushProject } from './collaboration.js';
import { emit } from './live.js';
import { workspaceContext } from './workspaceContext.js';

const failure = (
  code: string,
  message: string,
  status?: ProjectControlStatus,
  uncertain = false,
): ProjectControlResult => ({
  outcome: 'error',
  status,
  error: { code, message, ...(uncertain ? { uncertain: true } : {}) },
});

async function authorizedProject(projectId: string, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw Object.assign(new Error('Project owner access required'), { statusCode: 403 });
  const project = await projectAgentAccess(user, projectId, false);
  const context = workspaceContext.getStore();
  if (context) {
    context.projectId = projectId;
    context.actor = { id: user.id, name: user.displayName, role: 'owner' };
  }
  return project;
}

async function snapshot(project: Awaited<ReturnType<typeof authorizedProject>>) {
  const [profile] = await db
    .select()
    .from(projectRunProfiles)
    .where(
      and(eq(projectRunProfiles.projectId, project.id), eq(projectRunProfiles.isDefault, true)),
    );
  const blockers: string[] = [];
  if (project.state !== 'running') blockers.push('Start the workspace in Repellet first.');
  if (!profile?.command.trim()) blockers.push('Configure the main Run command in Repellet.');
  if (project.storageExceeded)
    blockers.push('Project storage limit reached. Delete files to continue.');
  if (
    (project.starterId &&
      (!project.preparation.scaffolded ||
        !['none', 'ready'].includes(project.preparation.status))) ||
    (project.setupCommand.trim() && project.preparation.status !== 'ready')
  )
    blockers.push('Complete project preparation in Repellet before starting the app.');
  const status: ProjectControlStatus = {
    workspaceState: project.state,
    runState: 'not_running',
    command: profile?.command ?? null,
    cwd: profile?.cwd ?? null,
    preparation: { status: project.preparation.status, error: project.preparation.error },
    blockers,
    preview: {
      status: project.appStatus.status,
      ...(project.appStatus.httpStatus !== undefined
        ? { httpStatus: project.appStatus.httpStatus }
        : {}),
      ...(project.appStatus.error ? { error: project.appStatus.error } : {}),
    },
    processes: [],
  };
  if (project.state !== 'running') return { status, profile, pending: [] };
  try {
    const mainIds = await mainRunProcessIds(project.id);
    const live = await bridge<TerminalInfo[]>(project.id, '/terminals');
    if (
      !Array.isArray(live) ||
      live.some(
        (t) =>
          !t ||
          typeof t.id !== 'string' ||
          typeof t.name !== 'string' ||
          typeof t.isRun !== 'boolean' ||
          typeof t.alive !== 'boolean',
      )
    )
      throw new Error('Invalid process status');
    const running = live.filter((t) => mainIds.has(t.id) && t.isRun === true && t.alive === true);
    const records = profile
      ? await db
          .select()
          .from(workspaceProcesses)
          .where(
            and(
              eq(workspaceProcesses.projectId, project.id),
              eq(workspaceProcesses.profileId, profile.id),
              eq(workspaceProcesses.kind, 'run'),
              eq(workspaceProcesses.status, 'starting'),
            ),
          )
      : [];
    const pending = records.filter((p) => !live.some((t) => t.id === p.id));
    status.processes = running.map((t) => ({ id: t.id, name: t.name, status: 'running' }));
    for (const p of pending)
      status.processes.push({ id: p.id, name: profile!.name, status: 'starting' });
    status.runState = running.length ? 'running' : pending.length ? 'starting' : 'not_running';
    return { status, profile, pending };
  } catch {
    status.runState = 'unknown';
    return { status, profile, pending: [] };
  }
}

async function logs(
  projectId: string,
  status: ProjectControlStatus,
  tailLines: number,
): Promise<ProjectControlResult> {
  const health = await bridge<{ capabilities?: string[] }>(projectId, '/health');
  if (!health.capabilities?.includes('terminal-output'))
    return failure(
      'rebuild_required',
      'Rebuild the workspace in Repellet to enable project logs.',
      status,
    );
  const output: NonNullable<ProjectControlResult['logs']> = [];
  let remaining = 64 * 1024;
  for (const process of status.processes.filter((p) => p.status === 'running')) {
    const result = await bridge<{
      running: boolean;
      processId?: string;
      name?: string;
      text?: string;
      truncated?: boolean;
    }>(projectId, `/terminals/${process.id}/output?tailLines=${tailLines}`);
    if (result.running === false) continue;
    if (result.running !== true || typeof result.text !== 'string')
      throw new Error('Invalid terminal output');
    const bytes = Buffer.from(result.text);
    let offset = Math.max(0, bytes.length - remaining);
    while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
    const text = bytes.subarray(offset).toString('utf8');
    remaining -= Buffer.byteLength(text);
    output.push({
      processId: process.id,
      name: process.name,
      text,
      truncated: result.truncated === true || offset > 0,
    });
  }
  status.processes = status.processes.filter((p) => output.some((o) => o.processId === p.id));
  if (!output.length) {
    status.runState = 'not_running';
    return { outcome: 'not_running', status };
  }
  return { outcome: 'logs', status, logs: output, truncated: output.some((o) => o.truncated) };
}

function preparationOutput(log: string, tailLines: number) {
  const lines = log.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const selected = lines.slice(-tailLines).join('\n');
  const bytes = Buffer.from(selected);
  let offset = Math.max(0, bytes.length - 64 * 1024);
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
  const text = bytes.subarray(offset).toString('utf8');
  return {
    text,
    truncated: lines.length > tailLines || Buffer.byteLength(selected) > 64 * 1024 || offset > 0,
  };
}

async function preparationLogs(
  project: Awaited<ReturnType<typeof authorizedProject>>,
  tailLines: number,
): Promise<ProjectControlResult> {
  const [job] = await preparationJobs(project.id);
  const output = preparationOutput(job?.log || '', tailLines);
  const preparation: ProjectPreparationLog = {
    status: project.preparation.status,
    error: project.preparation.error,
    job: job
      ? {
          id: job.id,
          state: job.state,
          step: job.step,
          error: job.error,
          startedAt: job.startedAt?.toISOString() || null,
          finishedAt: job.finishedAt?.toISOString() || null,
        }
      : null,
    text: output.text,
    truncated: output.truncated,
  };
  return {
    outcome: job ? 'preparation_logs' : 'no_preparation',
    preparation,
    truncated: preparation.truncated,
  };
}

async function preparationLogsControl(
  projectId: string,
  userId: string,
  tailLines: number,
): Promise<ProjectControlResult> {
  try {
    return await preparationLogs(await authorizedProject(projectId, userId), tailLines);
  } catch (error) {
    const code = (error as { statusCode?: number }).statusCode;
    return failure(
      code === 401 || code === 403 ? 'access_denied' : 'control_unavailable',
      code === 401 || code === 403
        ? 'Enabled project owner access is required for these tools.'
        : 'Could not read preparation logs.',
    );
  }
}

async function prepareControl(
  projectId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<ProjectControlResult> {
  let status: ProjectControlStatus | undefined;
  let mutationStarted = false;
  try {
    signal?.throwIfAborted();
    const project = await authorizedProject(projectId, userId);
    status = (await snapshot(project)).status;
    if (project.state !== 'running')
      return failure('prepare_blocked', 'Start the workspace in Repellet first.', status);
    // `files` and `installing` mean a preparation job is running. `pending` means work is
    // needed or was auto-queued, so only skip queueing when a prepare is actually in flight.
    if (
      ['files', 'installing'].includes(project.preparation.status) ||
      (project.preparation.status === 'pending' &&
        (await preparationJobs(project.id)).some((job) =>
          ['pending', 'running'].includes(job.state),
        ))
    )
      return { outcome: 'preparing', status };
    if (!project.setupCommand.trim() && !project.starterId)
      return { outcome: 'already_prepared', status };
    const [settings] = await db.select().from(installation).where(eq(installation.id, 1));
    if (settings?.maintenance)
      return failure('maintenance', 'Installation is paused for backup or maintenance.', status);
    await authorizedProject(projectId, userId);
    signal?.throwIfAborted();
    mutationStarted = true;
    // Queue the durable preparation after this control operation completes.
    void Promise.resolve()
      .then(() => prepareProject(projectId))
      .catch(() => {});
    return { outcome: 'preparing', status };
  } catch (error) {
    const code = (error as { statusCode?: number }).statusCode;
    return failure(
      code === 401 || code === 403
        ? 'access_denied'
        : signal?.aborted
          ? 'cancelled'
          : 'control_unavailable',
      code === 401 || code === 403
        ? 'Enabled project owner access is required for these tools.'
        : mutationStarted
          ? 'Preparation was admitted but its outcome is uncertain. Call project_status or project_preparation_logs before retrying.'
          : 'Could not start preparation.',
      status,
      mutationStarted,
    );
  }
}

/** Start and stop use fresh state under the Run UI workspace lock. Status skips that lock so it can report progress while installation holds it. */
export async function projectControl(
  projectId: string,
  userId: string,
  input: ProjectControlInput,
  signal?: AbortSignal,
): Promise<ProjectControlResult> {
  if (input.operation === 'preparation_logs')
    return preparationLogsControl(projectId, userId, input.arguments.tailLines ?? 200);
  if (input.operation === 'prepare') return prepareControl(projectId, userId, signal);
  const decide = async (): Promise<ProjectControlResult> => {
    let status: ProjectControlStatus | undefined;
    let mutationStarted = false;
    try {
      signal?.throwIfAborted();
      const project = await authorizedProject(projectId, userId);
      const current = await snapshot(project);
      status = current.status;
      signal?.throwIfAborted();
      if (status.runState === 'unknown')
        return failure(
          'status_unavailable',
          'Could not verify app status. Call project_status again before changing the app.',
          status,
        );
      if (input.operation === 'status') return { outcome: 'status', status };
      if (input.operation === 'logs') {
        if (status.runState !== 'running') return { outcome: 'not_running', status };
        return await logs(projectId, status, input.arguments.tailLines ?? 200);
      }
      if (status.runState === 'starting') return { outcome: 'starting', status };
      if (input.operation === 'start') {
        if (status.runState === 'running') return { outcome: 'already_running', status };
        if (status.blockers.length)
          return failure('start_blocked', status.blockers.join(' '), status);
        const [settings] = await db.select().from(installation).where(eq(installation.id, 1));
        if (settings?.maintenance)
          return failure(
            'maintenance',
            'Installation is paused for backup or maintenance.',
            status,
          );
        const health = await bridge<{ protocolVersion?: number; capabilities?: string[] }>(
          projectId,
          '/health',
        );
        if (health.protocolVersion !== 1 || !health.capabilities?.includes('processes'))
          return failure(
            'rebuild_required',
            'Rebuild the workspace in Repellet to enable Run app control.',
            status,
          );
        await flushProject(projectId);
        await assertPrepared(projectId);
        signal?.throwIfAborted();
        // Recheck owner access immediately before admission of a mutation.
        await authorizedProject(projectId, userId);
        signal?.throwIfAborted();
        mutationStarted = true;
        await startProfile(projectId, current.profile!.id, userId, 'run', signal);
        await probePreview(projectId, project.runConfig.port);
        await emit(projectId, { type: 'terminals' });
        const after = await snapshot(await authorizedProject(projectId, userId));
        if (after.status.runState === 'unknown')
          return failure(
            'status_unavailable',
            'The app was started, but current status could not be verified. Call project_status before taking another action.',
            after.status,
            true,
          );
        return {
          outcome: after.status.runState === 'starting' ? 'starting' : 'started',
          status: after.status,
        };
      }
      if (status.runState !== 'running') return { outcome: 'not_running', status };
      const [settings] = await db.select().from(installation).where(eq(installation.id, 1));
      if (settings?.maintenance)
        return failure('maintenance', 'Installation is paused for backup or maintenance.', status);
      await authorizedProject(projectId, userId);
      signal?.throwIfAborted();
      mutationStarted = true;
      for (const process of status.processes) {
        if (process.id === 'run') await bridge(projectId, '/run/stop', 'POST');
        else await stopProcess(projectId, process.id);
      }
      await cancelReadiness(projectId);
      await emit(projectId, { type: 'terminals' });
      return {
        outcome: 'stopped',
        status: (await snapshot(await authorizedProject(projectId, userId))).status,
      };
    } catch (error) {
      if (status) status.runState = 'unknown';
      const code = (error as { statusCode?: number }).statusCode;
      if (code === 401 || code === 403 || code === 404)
        return failure(
          'access_denied',
          'Enabled project owner access is required for these tools.',
        );
      if (code === 507)
        return failure(
          'storage_limit',
          'Project storage limit reached. Delete files to continue.',
          status,
        );
      if (code === 400 || code === 409)
        return failure(
          'start_blocked',
          'The app cannot be changed yet. Check Run configuration, preparation, and workspace compatibility in Repellet.',
          status,
          mutationStarted,
        );
      return failure(
        signal?.aborted ? 'cancelled' : 'control_unavailable',
        mutationStarted
          ? 'The action outcome is uncertain. Call project_status before retrying; do not replay the action automatically.'
          : 'Could not complete the request. Call project_status before changing the app.',
        status,
        mutationStarted,
      );
    }
  };
  // prepareProject holds the workspace lock for the whole install. Status must not queue behind it.
  if (input.operation === 'status') return decide();
  return serialize(projectId, decide);
}

export async function projectControlRoutes(app: FastifyInstance) {
  app.post('/internal/agent/project-control', async (req, reply) => {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, '') || '', config.workerToken))
      return reply.code(401).send({ error: 'Unauthorized' });
    const { projectId, userId, control } = projectControlApiSchema.parse(req.body);
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on('close', cancel);
    try {
      if (req.raw.aborted) controller.abort();
      return await projectControl(projectId, userId, control, controller.signal);
    } finally {
      reply.raw.off('close', cancel);
    }
  });
}
