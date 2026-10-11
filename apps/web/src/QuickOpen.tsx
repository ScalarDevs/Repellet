import { useEffect, useState } from 'react';
import type { FileIndex } from '@repellet/shared';
import { api, errorMessage } from './api';
import { EmptyState, LoadError, Modal, Spinner } from './ui';
export function QuickOpen({
  projectId,
  revision,
  onOpen,
  onClose,
}: {
  projectId: string;
  revision: number;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [paths, setPaths] = useState<string[] | null>(null),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setPaths(null);
    setError('');
    const load = () =>
      api<FileIndex>(`/projects/${projectId}/file-index`)
        .then((v) => {
          if (!disposed) {
            setPaths(v.paths);
            setError('');
          }
        })
        .catch((e) => {
          if (!disposed) setError(errorMessage(e));
        });
    void load();
    return () => {
      disposed = true;
    };
  }, [projectId, revision]);
  async function retry() {
    setPaths(null);
    setError('');
    try {
      const value = await api<FileIndex>(`/projects/${projectId}/file-index`);
      setPaths(value.paths);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const results = (paths || [])
    .filter((path) =>
      query
        .toLowerCase()
        .split(/\s+/)
        .every((part) => path.toLowerCase().includes(part)),
    )
    .slice(0, 100);
  useEffect(() => {
    setSelected((v) => Math.max(0, Math.min(v, results.length - 1)));
  }, [paths, query]);
  useEffect(() => {
    document.getElementById(`quick-file-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <Modal title="Open file" onClose={onClose}>
      <input
        autoFocus
        aria-label="Search file paths"
        value={query}
        placeholder="Search relative paths…"
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((v) =>
              Math.max(0, Math.min(results.length - 1, v + (e.key === 'ArrowDown' ? 1 : -1))),
            );
          }
          if (e.key === 'Enter' && results[selected]) {
            e.preventDefault();
            onOpen(results[selected]);
            onClose();
          }
        }}
        aria-controls="quick-open-results"
        aria-activedescendant={results[selected] ? `quick-file-${selected}` : undefined}
      />
      {error && <LoadError message={error} onRetry={() => void retry()} />}
      {paths === null && !error && <Spinner label="Loading file index…" />}
      <div className="quick-open-results" id="quick-open-results" role="listbox">
        {results.map((path, i) => (
          <button
            key={path}
            id={`quick-file-${i}`}
            role="option"
            aria-selected={i === selected}
            onClick={() => {
              onOpen(path);
              onClose();
            }}
          >
            {path}
          </button>
        ))}
        {paths !== null && !results.length && !error && (
          <EmptyState
            className="pane-empty"
            title="No matching files"
            description={
              query ? 'Try a different path fragment.' : 'This project has no indexed files yet.'
            }
          />
        )}
      </div>
    </Modal>
  );
}
