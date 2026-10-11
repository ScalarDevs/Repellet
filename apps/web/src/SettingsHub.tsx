import { useState, useEffect } from 'react';
import type { User } from '@repellet/shared';
import {
  UserCircle,
  Bot,
  Github,
  SlidersHorizontal,
  KeyRound,
  Shield,
  UserCheck,
} from 'lucide-react';
import { post, errorMessage } from './api';
import {
  useUi,
  PageHeader,
  Tabs,
  TabPanel,
  Field,
  Button,
  Avatar,
  Banner,
} from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { AgentSettingsContent } from './AgentSettings';
import { GitHubSettings } from './GitHub';
import { Admin } from './Admin';

export type SettingsTab = 'account' | 'agent' | 'github' | 'admin';

export function SettingsView({
  user,
  initialTab = 'account',
  onOpenProject,
  onTabChange,
}: {
  user: User;
  initialTab?: string;
  onOpenProject: (id: string) => void;
  onTabChange?: (tab: SettingsTab) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(() => {
    if (initialTab === 'admin' && user.isOwner) return 'admin';
    if (initialTab === 'agent') return 'agent';
    if (initialTab === 'github') return 'github';
    return 'account';
  });

  useEffect(() => {
    if (initialTab === 'admin' && user.isOwner) setTab('admin');
    else if (initialTab === 'agent' || initialTab === 'github' || initialTab === 'account')
      setTab(initialTab as SettingsTab);
  }, [initialTab, user.isOwner]);

  function handleTabChange(next: SettingsTab) {
    setTab(next);
    onTabChange?.(next);
  }

  const items = [
    { id: 'account' as const, label: 'Account', icon: UserCircle },
    { id: 'agent' as const, label: 'Agent', icon: Bot },
    { id: 'github' as const, label: 'GitHub', icon: Github },
    ...(user.isOwner
      ? [{ id: 'admin' as const, label: 'Administration', icon: SlidersHorizontal }]
      : []),
  ];

  return (
    <main className="settings-page">
      <PageHeader
        title="Settings"
        description="Manage your account profile, agent defaults, service connections, and server administration."
      />
      <div className="settings-tabs-wrap">
        <Tabs
          label="Settings sections"
          value={tab}
          items={items}
          onChange={handleTabChange}
        >
          <TabPanel>
            {tab === 'account' && <AccountSettingsSection user={user} />}

            {tab === 'agent' && (
              <div className="settings-card agent-settings-card">
                <header className="settings-section-header">
                  <h2>Agent Preferences</h2>
                  <p>
                    Configure default APIs, reasoning effort, connections, and conversation history.
                  </p>
                </header>
                <AgentSettingsContent isModal={false} />
              </div>
            )}

            {tab === 'github' && (
              <div className="settings-embed-wrap">
                <GitHubSettings user={user} />
              </div>
            )}

            {tab === 'admin' && user.isOwner && (
              <div className="settings-embed-wrap">
                <Admin onOpen={onOpenProject} />
              </div>
            )}
          </TabPanel>
        </Tabs>
      </div>
    </main>
  );
}

function AccountSettingsSection({ user }: { user: User }) {
  const { busy, run, alive } = useAsyncAction();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const ui = useUi();

  return (
    <div className="settings-stack">
      <section className="settings-card profile-card">
        <header className="settings-section-header">
          <h2>Profile & Role</h2>
          <p>Your user identity across all personal and operational workspaces.</p>
        </header>

        <div className="account-profile-details">
          <Avatar name={user.displayName} size={52} />
          <div className="account-profile-meta">
            <h3 className="profile-display-name">{user.displayName}</h3>
            <span className="profile-username">@{user.username}</span>
            <div className="profile-badges">
              <span className={`badge ${user.isOwner ? 'badge-accent' : 'badge-neutral'}`}>
                {user.isOwner ? (
                  <>
                    <Shield size={12} aria-hidden="true" /> Site owner
                  </>
                ) : (
                  <>
                    <UserCheck size={12} aria-hidden="true" /> Member
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-card security-card">
        <header className="settings-section-header">
          <h2>Security & Password</h2>
          <p>Update your credentials. Changing password will invalidate other active sessions.</p>
        </header>

        {error && <Banner tone="danger">{error}</Banner>}
        {success && <Banner tone="success">{success}</Banner>}

        <form
          className="change-password-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const values = Object.fromEntries(new FormData(form));
            setError('');
            setSuccess('');
            void run(async () => {
              try {
                await post<{ user: User }>('/auth/password', values);
                if (alive.current) {
                  setSuccess('Password changed successfully. Other sessions were signed out.');
                  ui.notify('Password changed successfully', 'success');
                  form.reset();
                }
              } catch (err) {
                if (alive.current) setError(errorMessage(err));
              }
            });
          }}
        >
          <Field label="Current password">
            <input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </Field>

          <Field label="New password" help="At least 12 characters.">
            <input
              type="password"
              name="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              disabled={busy}
            />
          </Field>

          <div className="form-actions start">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              icon={<KeyRound size={14} aria-hidden="true" />}
            >
              Update password
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
