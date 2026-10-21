import m from 'mithril';
import {
  adminSignOut,
  completeAdminLogin,
  getAdminTokens,
  loadAdminUser,
  startAdminLogin,
} from '../util/auth';
import { appUrl, type UserInfo } from '../util/api';

function formatTime(value: number | null | undefined) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function roleLabel(user: UserInfo) {
  return user.is_system_admin ? 'System administrator' : 'Realm administrator';
}

function Sidebar(user: UserInfo | null, page: any) {
  return (
    <aside class={page.sidebarOpen ? 'admin-sidebar is-open' : 'admin-sidebar'}>
      <div class="admin-sidebar-user">
        <span class="admin-sidebar-name">{user?.name || 'Administrator'}</span>
        <span class="admin-sidebar-meta">
          {user?.email || user?.preferred_username || 'Identity provider'}
        </span>
      </div>
      <nav class="admin-nav" aria-label="Administration">
        <div class="admin-nav-section">Administration</div>
        <a
          class="admin-nav-item is-active"
          href={appUrl('/')}
          aria-current="page"
          onclick={(event: Event) => {
            event.preventDefault();
            page.sidebarOpen = false;
            m.route.set('/');
          }}
        >
          Overview
        </a>
      </nav>
      <div class="admin-sidebar-footer">
        <span>{user ? roleLabel(user) : 'Administrative access'}</span>
      </div>
    </aside>
  );
}

export const Admin: m.Component = {
  user: null as UserInfo | null,
  error: null as Error | null,
  pending: false,
  sidebarOpen: false,

  oninit(this: any) {
    this.load();
  },

  async load(this: any) {
    if (!getAdminTokens()) {
      try {
        await startAdminLogin();
      } catch (e) {
        this.error = e as Error;
        m.redraw();
      }
      return;
    }

    try {
      this.user = await loadAdminUser();
      document.title = 'Administration';
    } catch (e) {
      const error = e as any;
      if (error?.status === 401 || error?.status === 400 || !getAdminTokens()) {
        try {
          await startAdminLogin();
          return;
        } catch (loginError) {
          this.error = loginError as Error;
        }
      } else {
        this.error = error as Error;
      }
    }
    m.redraw();
  },

  view(this: any) {
    const tokens = getAdminTokens();
    const user = this.user;

    return (
      <div class="admin-app">
        {Sidebar(user, this)}
        {this.sidebarOpen ? (
          <button
            class="admin-backdrop"
            type="button"
            aria-label="Close navigation"
            onclick={() => {
              this.sidebarOpen = false;
            }}
          />
        ) : null}
        <div class="admin-main">
          <header class="admin-topbar">
            <button
              class="admin-menu-button"
              type="button"
              aria-expanded={this.sidebarOpen}
              onclick={() => {
                this.sidebarOpen = !this.sidebarOpen;
              }}
            >
              Menu
            </button>
            <span class="admin-topbar-context">Administrative access</span>
            <details class="admin-session-menu">
              <summary>Session</summary>
              <div class="admin-session-panel">
                <span class="admin-session-label">
                  {user ? roleLabel(user) : 'Signing in'}
                </span>
                <span class="admin-session-detail">
                  Access expires {formatTime(tokens?.expires_at)}
                </span>
                <button type="button" onclick={() => adminSignOut()}>
                  Sign out
                </button>
              </div>
            </details>
          </header>

          <div class="admin-page-header">
            <div>
              <h1>Overview</h1>
              <p>Identity provider control plane</p>
            </div>
          </div>

          <main class="admin-content">
            {this.error ? (
              <div class="admin-alert" role="alert">
                {this.error.message}
              </div>
            ) : null}

            {!user ? (
              <div class="admin-loading">Loading session</div>
            ) : (
              <div class="admin-card-grid">
                <section class="admin-card">
                  <h2>Session</h2>
                  <dl class="admin-definition">
                    <div>
                      <dt>User</dt>
                      <dd>{user.name}</dd>
                    </div>
                    <div>
                      <dt>Email</dt>
                      <dd>{user.email || 'Not set'}</dd>
                    </div>
                    <div>
                      <dt>Username</dt>
                      <dd>{user.preferred_username}</dd>
                    </div>
                    <div>
                      <dt>Access token</dt>
                      <dd>{formatTime(tokens?.expires_at)}</dd>
                    </div>
                  </dl>
                </section>

                <section class="admin-card">
                  <h2>Access</h2>
                  <dl class="admin-definition">
                    <div>
                      <dt>Role</dt>
                      <dd>{roleLabel(user)}</dd>
                    </div>
                    <div>
                      <dt>Client</dt>
                      <dd>admin</dd>
                    </div>
                    <div>
                      <dt>Refresh</dt>
                      <dd>Automatic</dd>
                    </div>
                    <div>
                      <dt>Scope</dt>
                      <dd>{tokens?.scope || 'openid'}</dd>
                    </div>
                  </dl>
                </section>

                <section class="admin-card admin-card-wide">
                  <h2>Administration</h2>
                  <p class="admin-card-note">
                    Realm and session management arrive in the next admin slice.
                  </p>
                </section>
              </div>
            )}
          </main>
        </div>
      </div>
    );
  },
};

export const AdminCallback: m.Component = {
  error: null as Error | null,

  oninit(this: any) {
    this.complete();
  },

  async complete(this: any) {
    const query = (m.route.get() || '').split('?')[1] || '';
    try {
      await completeAdminLogin(query);
      m.route.set('/');
    } catch (e) {
      this.error = e as Error;
      m.redraw();
    }
  },

  view(this: any) {
    return (
      <div class="admin-status-page">
        <div class="admin-status-panel">
          <h1>{this.error ? 'Sign-in failed' : 'Completing sign-in'}</h1>
          {this.error ? (
            <p class="admin-alert" role="alert">
              {this.error.message}
            </p>
          ) : (
            <p class="admin-status-note">Establishing the administrative session.</p>
          )}
          {this.error ? (
            <a class="admin-text-link" href={appUrl('/')}>
              Return to administration
            </a>
          ) : null}
        </div>
      </div>
    );
  },
};
