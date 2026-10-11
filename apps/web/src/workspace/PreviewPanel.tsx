import { RefreshCw, ExternalLink, X } from 'lucide-react';
import type { Project } from '@repellet/shared';
import { PaneHeader, IconButton, Banner, Button, EmptyState } from '../ui';
export function PreviewPanel({
  project,
  url,
  width,
  revision,
  editable,
  showTitle = true,
  onRefresh,
  onClose,
  onRetryReadiness,
}: {
  project: Project;
  url: string;
  width: number;
  revision: number;
  editable: boolean;
  showTitle?: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onRetryReadiness: () => void;
}) {
  const { appStatus } = project;
  const available = !!url && appStatus.status === 'available';
  const actions = (
    <>
      <IconButton
        size="sm"
        label="Refresh preview"
        icon={<RefreshCw size={13} />}
        onClick={onRefresh}
      />
      <IconButton
        size="sm"
        label="Open preview in new tab"
        icon={<ExternalLink size={13} />}
        onClick={() => window.open(url, '_blank', 'noopener')}
        disabled={!url}
      />
      <IconButton size="sm" label="Close right panel" icon={<X size={14} />} onClick={onClose} />
    </>
  );
  const emptyTitle =
    appStatus.status === 'starting'
      ? 'Starting app'
      : appStatus.error
        ? 'Preview unavailable'
        : 'No preview yet';
  const emptyDescription =
    appStatus.status === 'starting'
      ? 'Waiting for the app to become available…'
      : appStatus.error || (editable ? 'Click Run to start your app.' : 'The app isn’t running.');
  return (
    <aside className="preview-pane" style={{ width }}>
      {showTitle ? (
        <PaneHeader title="Preview" actions={actions} />
      ) : (
        <div className="pane-header preview-toolbar">{actions}</div>
      )}
      <div className="preview-url">
        <span
          className={`preview-availability ${available ? 'available' : ''}`}
          title={
            available ? 'App is responding' : url ? 'App is not responding yet' : 'No preview port'
          }
        />
        <input aria-label="Preview URL" readOnly value={url} placeholder="No preview yet" />
      </div>
      {appStatus.httpStatus && appStatus.httpStatus >= 400 && (
        <Banner tone="warning" compact className="preview-banner">
          The app responded with HTTP {appStatus.httpStatus}.
        </Banner>
      )}
      {available ? (
        <iframe
          key={`${appStatus.generation}-${revision}`}
          src={url}
          title="Project preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        />
      ) : (
        <EmptyState
          className="pane-empty"
          title={emptyTitle}
          description={emptyDescription}
          action={
            editable && appStatus.status === 'timeout' ? (
              <Button size="sm" onClick={onRetryReadiness}>
                Retry readiness
              </Button>
            ) : undefined
          }
        />
      )}
    </aside>
  );
}
