import type { Project } from '@repellet/shared';
import { formatBytes } from '../api';
const runtimeName = (r: string) =>
  r === 'node' ? 'Node.js' : r.charAt(0).toUpperCase() + r.slice(1);
export function StatusBar({
  project,
  connected,
  status,
  languageStatus,
  onProblems,
  onStorage,
}: {
  project: Project;
  connected: boolean;
  status: string;
  languageStatus: string;
  onProblems?: () => void;
  onStorage?: () => void;
}) {
  return (
    <footer className="workspace-status">
      <span className="status-left">
        <span
          className={`online-dot ${connected ? '' : 'offline'}`}
          title={connected ? 'Live updates connected' : 'Connecting to live updates'}
          aria-hidden="true"
        />
        <span title={connected ? 'Live updates connected' : 'Connecting to live updates'}>
          {connected ? 'Live' : 'Connecting…'}
        </span>
        {onProblems && (
          <button
            type="button"
            className="status-action"
            onClick={onProblems}
            title="Show problems"
          >
            Problems
          </button>
        )}
        {status && <span className="truncate">{status}</span>}
        {languageStatus && (
          <span className="language-status truncate" title={languageStatus}>
            {languageStatus}
          </span>
        )}
      </span>
      <span className="status-right">
        <span>{project.runtimes.map(runtimeName).join(' + ')}</span>
        {onStorage ? (
          <button
            type="button"
            className="status-action"
            onClick={onStorage}
            title="Workspace storage — open project settings"
          >
            {formatBytes(project.storageBytes)}
          </button>
        ) : (
          <span title="Workspace storage">{formatBytes(project.storageBytes)}</span>
        )}
      </span>
    </footer>
  );
}
