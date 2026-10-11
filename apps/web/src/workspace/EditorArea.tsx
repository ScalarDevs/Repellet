import { lazy, Suspense, type RefObject } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { User, WorkspacePreferences } from '@repellet/shared';
import { X, ChevronRight, Code2, MoreHorizontal } from 'lucide-react';
import { Spinner, Shortcut, MenuButton, MenuItem } from '../ui';
import { FileIcon } from '../Files';
const CodeEditor = lazy(() => import('../CodeEditor').then((m) => ({ default: m.CodeEditor })));
const overflowAt = 7;
type Selection = { line: number; column: number };
type Position = WorkspacePreferences['positions'][string];
function tabLabel(path: string, tabs: string[]) {
  const base = path.split('/').pop() || path;
  const duplicates = tabs.filter((tab) => (tab.split('/').pop() || tab) === base);
  if (duplicates.length <= 1) return base;
  const parent = path.includes('/') ? path.split('/').slice(-2, -1)[0] : '';
  return parent ? `${parent}/${base}` : base;
}
export function EditorArea({
  projectId,
  projectName,
  user,
  editable,
  tabs,
  active,
  selection,
  positions,
  viewStates,
  onSelect,
  onClose,
  onOpen,
  onPosition,
  onStatus,
  onLanguageStatus,
  initialLoadAttempts,
  onInitialLoad,
}: {
  projectId: string;
  projectName: string;
  user: User;
  editable: boolean;
  tabs: string[];
  active: string;
  selection?: Selection;
  positions: RefObject<Record<string, Position>>;
  viewStates: RefObject<Map<string, MonacoEditor.ICodeEditorViewState>>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onOpen: (path: string, line?: number, column?: number) => void;
  onPosition: (path: string, position: Position) => void;
  onStatus: (status: string) => void;
  onLanguageStatus: (status: string) => void;
  initialLoadAttempts?: Record<string, number>;
  onInitialLoad?: (path: string, error?: string) => void;
}) {
  return (
    <section className="editor-stack">
      {tabs.length > 0 && (
        <div className="editor-tabs">
          <div className="editor-tab-list">
            {tabs.map((path) => (
              <div
                className={`editor-tab ${active === path ? 'active' : ''}`}
                key={path}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    onClose(path);
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    onClose(path);
                  }
                }}
              >
                <button aria-pressed={active === path} onClick={() => onSelect(path)}>
                  <FileIcon name={path} />
                  <span title={path}>{tabLabel(path, tabs)}</span>
                </button>
                <button
                  aria-label={`Close ${path}`}
                  title="Close"
                  className="tab-close"
                  onClick={() => onClose(path)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          {tabs.length >= overflowAt && (
            <MenuButton
              label="Open editors"
              icon={<MoreHorizontal size={14} />}
              className="editor-tab-overflow"
              menuClassName="editor-tab-overflow-menu"
            >
              {tabs.map((path) => (
                <MenuItem key={path} onSelect={() => onSelect(path)}>
                  <FileIcon name={path} />
                  <span title={path}>{tabLabel(path, tabs)}</span>
                </MenuItem>
              ))}
            </MenuButton>
          )}
        </div>
      )}
      {active ? (
        <>
          <div className="breadcrumbs" title={active} tabIndex={0} aria-label="File path">
            {active.split('/').map((part, i) => (
              <span key={i}>
                {i > 0 && <ChevronRight size={11} />} {part}
              </span>
            ))}
          </div>
          <Suspense fallback={<Spinner label="Opening editor…" />}>
            {tabs.map((path) => (
              <div
                className="retained-editor"
                key={path}
                style={{ display: active === path ? 'flex' : 'none' }}
              >
                <CodeEditor
                  projectId={projectId}
                  path={path}
                  user={user}
                  editable={editable}
                  active={active === path}
                  initialLoadAttempt={initialLoadAttempts?.[path] || 0}
                  onInitialLoad={(error) => onInitialLoad?.(path, error)}
                  onStatus={(s) => {
                    if (path === active) onStatus(s);
                  }}
                  onLanguageStatus={(s) => {
                    if (path === active) onLanguageStatus(s);
                  }}
                  viewStates={viewStates.current}
                  onDefinition={onOpen}
                  selection={path === active ? selection : undefined}
                  position={positions.current[path]}
                  onPosition={(pos) => onPosition(path, pos)}
                />
              </div>
            ))}
          </Suspense>
        </>
      ) : (
        <div className="editor-welcome">
          <div className="welcome-mark">
            <Code2 size={40} strokeWidth={1} />
          </div>
          <h2>{projectName}</h2>
          <p>Open a file from the sidebar to start working.</p>
          <div className="shortcut-list">
            <span>
              Open file
              <Shortcut keys={['mod', 'P']} />
            </span>
            <span>
              Find in files
              <Shortcut keys={['mod', 'shift', 'F']} />
            </span>
            {editable && (
              <span>
                Run project
                <Shortcut keys={['mod', 'enter']} />
              </span>
            )}
          </div>
          <small>Changes save automatically.</small>
        </div>
      )}
    </section>
  );
}
