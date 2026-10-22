import m from 'mithril';
import {
  Activity,
  CircleAlert,
  CircleUserRound,
  Hexagon,
  LayoutGrid,
  LogOut,
  Settings,
  Sun,
} from 'lucide';
import {
  adminSignOut,
  clearAdminTokens,
  completeAdminLogin,
  getAdminTokens,
  loadAdminRealms,
  loadAdminUser,
  startAdminLogin,
} from '../util/auth';
import { appUrl, getAuthUrl, type AdminRealm, type UserInfo } from '../util/api';
import { icon } from '../util/icon';
import { applyTheme, cycleTheme, getTheme, themeLabel, type Theme } from '../util/theme';
import { OverviewPage } from './overview';
import { SessionsPage } from './sessions';

function currentPath() {
  return (m.route.get() || '/').split('?')[0];
}

function sessionsRealm() {
  const path = currentPath();
  if (!path.startsWith('/sessions/')) return null;
  try {
    return decodeURIComponent(path.slice('/sessions/'.length));
  } catch {
    return null;
  }
}

export const Admin: m.Component = {
  user: null as UserInfo | null,
  realms: null as AdminRealm[] | null,
  realmsError: null as Error | null,
  error: null as Error | null,
  authUrl: window.location.origin,
  theme: getTheme() as Theme,

  oninit(this: any) {
    applyTheme(this.theme);
    this.load();
  },

  onupdate(this: any) {
    this.updateTitle();
  },

  async load(this: any) {
    try {
      this.authUrl = await getAuthUrl();
    } catch {
      this.authUrl = window.location.origin;
    }

    if (!getAdminTokens()) {
      await this.login();
      return;
    }

    try {
      this.user = await loadAdminUser();
      this.updateTitle();
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400 || !getAdminTokens()) {
        await this.login();
        return;
      }
      this.error = e as Error;
      m.redraw();
      return;
    }

    try {
      this.realms = await loadAdminRealms();
      this.realmsError = null;
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        await this.login();
        return;
      }
      this.realms = [];
      this.realmsError = e as Error;
    }
    m.redraw();
  },

  async login(this: any) {
    try {
      await startAdminLogin();
    } catch (e) {
      this.error = e as Error;
      m.redraw();
    }
  },

  async authExpired(this: any) {
    clearAdminTokens();
    await this.login();
  },

  updateTitle(this: any) {
    document.title =
      currentPath() === '/sessions' || currentPath().startsWith('/sessions/')
        ? 'Sessions · Administration'
        : 'Administration';
  },

  cycleTheme(this: any) {
    this.theme = cycleTheme();
  },

  view(this: any) {
    const user = this.user;
    const sessions = currentPath() === '/sessions' || currentPath().startsWith('/sessions/');
    const realmSlug = sessionsRealm();
    const sessionsHref =
      this.realms && this.realms.length > 0
        ? `/sessions/${encodeURIComponent(this.realms[0].slug)}`
        : '/sessions';

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
                <button
                  class="admin-user-menu-item"
                  type="button"
                  aria-label={`Theme: ${themeLabel(this.theme)}`}
                  onclick={() => this.cycleTheme()}
                >
                  {icon(Sun)}
                  <span>Theme</span>
                  <span class="admin-user-menu-value">{themeLabel(this.theme)}</span>
                </button>
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
                class={`admin-nav-item${sessions ? '' : ' is-active'}`}
                href={appUrl('/')}
                aria-current={sessions ? undefined : 'page'}
                onclick={(event: Event) => {
                  event.preventDefault();
                  m.route.set('/');
                }}
              >
                {icon(LayoutGrid)}
                <span>Overview</span>
              </a>
              <a
                class={`admin-nav-item${sessions ? ' is-active' : ''}`}
                href={appUrl(sessionsHref)}
                aria-current={sessions ? 'page' : undefined}
                onclick={(event: Event) => {
                  event.preventDefault();
                  m.route.set(sessionsHref);
                }}
              >
                {icon(Activity)}
                <span>Sessions</span>
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
              ) : sessions ? (
                <SessionsPage
                  key={realmSlug || 'select'}
                  realmSlug={realmSlug}
                  realms={this.realms}
                  realmsError={this.realmsError}
                  onAuthExpired={() => this.authExpired()}
                />
              ) : (
                <OverviewPage
                  user={user}
                  realms={this.realms}
                  realmsError={this.realmsError}
                />
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
          {this.error ? (
            icon(CircleAlert, { class: 'admin-status-icon' })
          ) : (
            <div class="admin-spinner" aria-hidden="true"></div>
          )}
          <h1>{this.error ? 'Sign-in failed' : 'Completing sign-in'}</h1>
          {this.error ? (
            <p class="admin-status-error" role="alert">
              {this.error.message}
            </p>
          ) : (
            <p class="admin-status-note">Establishing the administrative session.</p>
          )}
          {this.error ? (
            <div class="admin-status-actions">
              <a class="admin-button" href={appUrl('/')}>
                Return to administration
              </a>
            </div>
          ) : null}
        </div>
      </div>
    );
  },
};
