export type ProjectControlInput =
  | { operation: 'status' | 'start' | 'stop'; arguments: Record<string, never> }
  | { operation: 'prepare'; arguments: Record<string, never> }
  | {
      operation: 'logs' | 'preparation_logs';
      arguments: { tailLines?: number };
    };

export type ProjectControlRequest = ProjectControlInput & { threadId: string; turnId: string };

export type ProjectControlStatus = {
  workspaceState: string;
  runState: 'running' | 'not_running' | 'starting' | 'unknown';
  command: string | null;
  cwd: string | null;
  preparation: { status: string; error: string | null };
  blockers: string[];
  preview: { status: string; httpStatus?: number; error?: string };
  processes: Array<{ id: string; name: string; status: string }>;
};

export type ProjectPreparationLog = {
  status: string;
  error: string | null;
  job: {
    id: string;
    state: string;
    step: string | null;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  text: string;
  truncated: boolean;
};

export type ProjectControlResult = {
  outcome:
    | 'status'
    | 'logs'
    | 'preparation_logs'
    | 'no_preparation'
    | 'preparing'
    | 'already_prepared'
    | 'started'
    | 'already_running'
    | 'stopped'
    | 'not_running'
    | 'starting'
    | 'error';
  status?: ProjectControlStatus;
  logs?: Array<{ processId: string; name: string; text: string; truncated: boolean }>;
  preparation?: ProjectPreparationLog;
  truncated?: boolean;
  error?: { code: string; message: string; uncertain?: boolean };
};
