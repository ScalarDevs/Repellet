// @vitest-environment jsdom
import { useRef } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileTree } from '../../apps/web/src/Files';
import { EditorArea } from '../../apps/web/src/workspace/EditorArea';
import { TerminalPanel } from '../../apps/web/src/workspace/TerminalPanel';
import { ResizeHandle } from '../../apps/web/src/workspace/ResizeHandle';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post } from '../../apps/web/src/api';
import { user } from './helpers';

vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
vi.mock('../../apps/web/src/Terminal', () => ({ Terminal: () => <div>Output</div> }));
vi.mock('../../apps/web/src/CodeEditor', () => ({
  CodeEditor: () => <div>Editor</div>,
}));

const root = [
  { name: 'src', path: 'src', kind: 'directory' },
  { name: 'a.txt', path: 'a.txt', kind: 'file' },
];

beforeEach(() => {
  vi.mocked(post).mockReset().mockResolvedValue({});
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (url) => {
      if (url.endsWith('path=')) return root;
      if (url.endsWith('path=src')) return [{ name: 'b.txt', path: 'src/b.txt', kind: 'file' }];
      return [];
    });
});

it('offers New file and New folder from the file context menu', async () => {
  const onOpen = vi.fn();
  render(
    <UiProvider>
      <FileTree projectId="project" active="" revision={0} editable onOpen={onOpen} />
    </UiProvider>,
  );
  fireEvent.contextMenu(await screen.findByRole('button', { name: 'src' }));
  expect(screen.getByRole('menuitem', { name: 'New file' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'New folder' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'New file' }));
  const input = await screen.findByRole('textbox', { name: 'Workspace path' });
  expect((input as HTMLInputElement).value).toBe('src/');
  fireEvent.change(input, { target: { value: 'src/new.ts' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/create', {
      path: 'src/new.ts',
      kind: 'file',
    }),
  );
  expect(onOpen).toHaveBeenCalledWith('src/new.ts');
});

it('closes editor tabs with middle-click and disambiguates duplicate basenames', () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  function Harness() {
    const positions = useRef({});
    const viewStates = useRef(new Map());
    return (
      <UiProvider>
        <EditorArea
          projectId="project"
          projectName="Demo"
          user={user}
          editable
          tabs={['src/index.ts', 'lib/index.ts', 'readme.md']}
          active="src/index.ts"
          positions={positions}
          viewStates={viewStates}
          onSelect={onSelect}
          onClose={onClose}
          onOpen={vi.fn()}
          onPosition={vi.fn()}
          onStatus={vi.fn()}
          onLanguageStatus={vi.fn()}
        />
      </UiProvider>
    );
  }
  const { container } = render(<Harness />);
  expect(screen.getByText('src/index.ts')).toBeTruthy();
  expect(screen.getByText('lib/index.ts')).toBeTruthy();
  expect(screen.getByText('readme.md')).toBeTruthy();
  const tab = container.querySelector('.editor-tab')!;
  fireEvent.mouseDown(tab, { button: 1 });
  expect(onClose).toHaveBeenCalledWith('src/index.ts');
});

it('shows an overflow menu once many editor tabs are open', async () => {
  const tabs = Array.from({ length: 7 }, (_, i) => `file-${i}.ts`);
  function Harness() {
    const positions = useRef({});
    const viewStates = useRef(new Map());
    return (
      <UiProvider>
        <EditorArea
          projectId="project"
          projectName="Demo"
          user={user}
          editable
          tabs={tabs}
          active={tabs[0]!}
          positions={positions}
          viewStates={viewStates}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onOpen={vi.fn()}
          onPosition={vi.fn()}
          onStatus={vi.fn()}
          onLanguageStatus={vi.fn()}
        />
      </UiProvider>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Open editors' }));
  expect(screen.getByRole('menu')).toBeTruthy();
  expect(screen.getAllByRole('menuitem')).toHaveLength(7);
});

it('renders terminal sessions as a horizontal tab bar', () => {
  const { container } = render(
    <TerminalPanel
      projectId="project"
      visible
      terminals={[
        { id: 'shell', name: 'Shell', alive: true, isRun: false },
        {
          id: 'run',
          name: 'Run',
          alive: true,
          isRun: true,
          isMainRun: true,
        },
      ]}
      terminal="shell"
      error=""
      editable
      onSelect={vi.fn()}
      onStop={vi.fn()}
      onCreate={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(container.querySelector('.terminal-sidebar')).toBeNull();
  expect(container.querySelector('.terminal-session-bar')).toBeTruthy();
  expect(container.querySelector('.terminal-panel')?.className).not.toContain('sidebar');
  expect(screen.getByRole('button', { name: 'New terminal' })).toBeTruthy();
  expect(screen.getByTitle('Run output · Running')).toBeTruthy();
});

it('resets via double-click when onReset is provided', () => {
  const onReset = vi.fn();
  const { container } = render(
    <ResizeHandle onStart={vi.fn()} onDelta={vi.fn()} onReset={onReset} />,
  );
  fireEvent.doubleClick(container.querySelector('.resize-handle')!);
  expect(onReset).toHaveBeenCalledTimes(1);
});
