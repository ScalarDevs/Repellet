import {
  Files,
  Search,
  GitBranch,
  CircleAlert,
  PanelRight,
  TerminalSquare,
  Bot,
  Database,
  AppWindow,
} from 'lucide-react';
const tools = [
  ['files', 'Files', Files],
  ['search', 'Search', Search],
  ['git', 'Source control', GitBranch],
  ['problems', 'Problems', CircleAlert],
] as const;
export function ActivityBar({
  pane,
  showSidebar,
  showTerminal,
  showRightPanel,
  rightPanel,
  onPane,
  onToggleTerminal,
  onToggleRightPanel,
  onPreview,
  agentOwner = false,
  onAgent,
  databaseAllowed = false,
  onDatabase,
}: {
  databaseAllowed?: boolean;
  onDatabase?: () => void;
  agentOwner?: boolean;
  onAgent?: () => void;
  onPreview?: () => void;
  pane: string;
  showSidebar: boolean;
  showTerminal: boolean;
  showRightPanel: boolean;
  rightPanel: 'preview' | 'agent' | 'database';
  onPane: (name: string) => void;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}) {
  return (
    <nav className="activity-bar" aria-label="Workspace tools">
      {tools.map(([name, label, Icon]) => {
        const active = pane === name && showSidebar;
        return (
          <button
            key={name}
            className={active ? 'active' : ''}
            aria-pressed={active}
            aria-label={label}
            title={active ? `${label} (click to hide sidebar)` : label}
            onClick={() => onPane(name)}
          >
            <Icon size={19} />
          </button>
        );
      })}
      {agentOwner && (
        <button
          aria-label="Agent"
          title="Agent"
          aria-pressed={showRightPanel && rightPanel === 'agent'}
          className={showRightPanel && rightPanel === 'agent' ? 'active' : ''}
          onClick={onAgent}
        >
          <Bot size={19} />
        </button>
      )}
      <div className="activity-spacer" />
      <button
        aria-pressed={showTerminal}
        aria-label="Toggle bottom panel"
        title="Toggle bottom panel"
        className={showTerminal ? 'active-subtle' : ''}
        onClick={onToggleTerminal}
      >
        <TerminalSquare size={19} />
      </button>
      <button
        aria-label="Preview"
        title="Preview"
        aria-pressed={showRightPanel && rightPanel === 'preview'}
        className={showRightPanel && rightPanel === 'preview' ? 'active-subtle' : ''}
        onClick={onPreview}
      >
        <AppWindow size={19} />
      </button>
      {databaseAllowed && (
        <button
          aria-label="Database"
          title="Database"
          aria-pressed={showRightPanel && rightPanel === 'database'}
          className={showRightPanel && rightPanel === 'database' ? 'active-subtle' : ''}
          onClick={onDatabase}
        >
          <Database size={19} />
        </button>
      )}
      <button
        aria-pressed={showRightPanel}
        aria-label="Toggle right panel"
        title="Toggle right panel"
        className={showRightPanel ? 'active-subtle' : ''}
        onClick={onToggleRightPanel}
      >
        <PanelRight size={19} />
      </button>
    </nav>
  );
}
