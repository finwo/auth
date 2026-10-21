import m from 'mithril';
import { CircleUserRound, Hexagon, LayoutGrid, LogOut, Settings } from 'lucide';
import {
  adminSignOut,
  completeAdminLogin,
  getAdminTokens,
  loadAdminUser,
  startAdminLogin,
} from '../util/auth';
import { appUrl, getAuthUrl, type UserInfo } from '../util/api';
import { icon } from '../util/icon';

function roleLabel(user: UserInfo) {
  return user.is_system_admin ? 'System administrator' : 'Realm administrator';
}

export const Admin: m.Component = {
  user: null as UserInfo | null,
  error: null as Error | null,
  authUrl: window.location.origin,

  oninit(this: any) {
    this.load();
  },

  async load(this: any) {
    try {
      this.authUrl = await getAuthUrl();
    } catch {
      this.authUrl = window.location.origin;
    }

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
        <header class="admin-topbar">
          <a
            class="admin-brand"
            href={appUrl('/')}
            onclick={(event: Event) => {
              event.preventDefault();
              m.route.set('/');
            }}
          >
            {icon(Hexagon, { class: 'admin-brand-icon' })}
            <span class="admin-brand-name">Auth</span>
          </a>

          <details
            class="admin-user-menu"
            oncreate={({ dom }: any) => {
              const close = (event: Event) => {
                if (dom.open && !dom.contains(event.target as Node)) dom.open = false;
              };
              dom.closeOnOutsideClick = close;
              document.addEventListener('click', close);
            }}
            onremove={({ dom }: any) => {
              document.removeEventListener('click', dom.closeOnOutsideClick);
            }}
          >
            <summary aria-label="Account menu">
              {icon(CircleUserRound)}
            </summary>
            <div class="admin-user-panel">
              <div class="admin-user-summary">
                <span class="admin-user-name">{user?.name || 'Administrator'}</span>
                <span class="admin-user-meta">
                  {user?.email || user?.preferred_username || 'Identity provider'}
                </span>
              </div>
              <div class="admin-user-menu-list">
                <a class="admin-user-menu-item" href={`${this.authUrl}/app/account`}>
                  {icon(Settings)}
                  <span>Account settings</span>
                </a>
                <a
                  class="admin-user-menu-item"
                  href="#"
                  onclick={(event: Event) => {
                    event.preventDefault();
                    adminSignOut().catch((error: Error) => {
                      this.error = error;
                      m.redraw();
                    });
                  }}
                >
                  {icon(LogOut)}
                  <span>Sign out</span>
                </a>
              </div>
            </div>
          </details>
        </header>

        <div class="admin-body">
          <aside class="admin-sidebar">
            <nav class="admin-nav" aria-label="Administration">
              <p class="admin-nav-label">Administration</p>
              <a
                class="admin-nav-item is-active"
                href={appUrl('/')}
                aria-current="page"
                onclick={(event: Event) => {
                  event.preventDefault();
                  m.route.set('/');
                }}
              >
                {icon(LayoutGrid)}
                <span>Overview</span>
              </a>
            </nav>
          </aside>

          <main class="admin-main">
            <div class="admin-content">
              {this.error ? (
                <div class="admin-alert" role="alert">
                  {this.error.message}
                </div>
              ) : null}

              {!user ? (
                <div class="admin-loading">Loading session</div>
              ) : (
                <div class="admin-grid">
                  <section class="admin-panel">
                    <h2>Account</h2>
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
                        <dt>Role</dt>
                        <dd>{roleLabel(user)}</dd>
                      </div>
                    </dl>
                  </section>

                  <section class="admin-panel">
                    <h2>Access</h2>
                    <dl class="admin-definition">
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
                      <div>
                        <dt>Session</dt>
                        <dd>Active</dd>
                      </div>
                    </dl>
                  </section>

                  <section class="admin-panel admin-panel-wide">
                    <h2>Administration</h2>
                    <p class="admin-note">
                      Realm and session management arrive in the next admin slice.
                    </p>
                  </section>
                </div>
              )}
            </div>
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
            <p class="admin-status-error" role="alert">
              {this.error.message}
            </p>
          ) : (
            <p class="admin-status-note">Establishing the administrative session.</p>
          )}
          {this.error ? (
            <a class="admin-status-link" href={appUrl('/')}>
              Return to administration
            </a>
          ) : null}
        </div>
      </div>
    );
  },
};
