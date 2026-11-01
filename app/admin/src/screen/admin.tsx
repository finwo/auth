import { Activity, AppWindow, LayoutGrid, Settings, Users } from 'lucide';
import m from 'mithril';
import { AppShell } from '@component/app-shell';
import { Nav, type NavItem } from '@component/nav';
import { StatusPage } from '@component/status-page';
import { Topbar } from '@component/topbar';
import { UserMenu } from '@component/user-menu';
import { applyTheme, cycleTheme, getTheme, type Theme } from '@util/theme';
import {
  adminSignOut,
  clearAdminTokens,
  completeAdminLogin,
  getAdminTokens,
  loadAdminMe,
  loadAdminRealms,
  loadAdminUser,
  startAdminLogin,
} from '../util/auth';
import { appUrl, getAuthUrl, type AdminRealm, type UserInfo } from '../util/api';
import { OverviewPage } from './overview';
import { SessionsPage } from './sessions';
import { ClientEditPage } from './client-edit';
import { ClientsPage } from './clients';
import { GlobalUserPage } from './global-user';
import { UserPage } from './user';
import { UsersPage } from './users';
import { SettingsPage } from './settings';

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

function clientsRealm() {
  const path = currentPath();
  if (path !== '/clients' && !path.startsWith('/clients/')) return null;
  const suffix = path.slice('/clients/'.length);
  if (!suffix) return null;
  const slug = suffix.split('/')[0];
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}

function clientEditPath() {
  const path = currentPath();
  const match = /^\/clients\/([^/]+)\/edit\/(.+)$/.exec(path);
  if (!match) return null;
  try {
    return {
      realmSlug: decodeURIComponent(match[1]),
      clientId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function usersRealm() {
  const path = currentPath();
  if (path !== '/users' && !path.startsWith('/users/')) return null;
  const suffix = path.slice('/users/'.length);
  if (!suffix) return null;
  const slug = suffix.split('/')[0];
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}

function userDetailPath() {
  const path = currentPath();
  if (path === '/users/global' || path.startsWith('/users/global/')) return null;
  const match = /^\/users\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    return {
      realmSlug: decodeURIComponent(match[1]),
      userId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function globalUserDetailPath() {
  const path = currentPath();
  const match = /^\/users\/global\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    return { userId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

function settingsRealm() {
  const path = currentPath();
  if (path !== '/settings' && !path.startsWith('/settings/')) return null;
  const suffix = path.slice('/settings/'.length);
  if (!suffix) return null;
  const slug = suffix.split('/')[0];
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}

export const Admin: m.Component = {
  user: null as UserInfo | null,
  systemAdmin: false,
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

    try {
      const me = await loadAdminMe();
      this.systemAdmin = me.is_system_admin;
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        await this.login();
        return;
      }
      this.systemAdmin = false;
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

  async reloadRealms(this: any) {
    try {
      this.realms = await loadAdminRealms();
      this.realmsError = null;
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        await this.login();
        return;
      }
      this.realmsError = e as Error;
    }
    m.redraw();
  },

  updateTitle(this: any) {
    const path = currentPath();
    const clients = path === '/clients' || path.startsWith('/clients/');
    const sessions = path === '/sessions' || path.startsWith('/sessions/');
    const users = path === '/users' || path.startsWith('/users/');
    const settings = path === '/settings' || path.startsWith('/settings/');
    const title = clients
      ? path.includes('/edit/')
        ? 'Edit client | Administration'
        : 'Clients | Administration'
      : sessions
        ? 'Sessions | Administration'
        : users
          ? userDetailPath() || globalUserDetailPath()
            ? 'User | Administration'
            : 'Users | Administration'
          : settings
            ? 'Realm settings | Administration'
            : 'Administration';
    document.title = title;
  },

  cycleTheme(this: any) {
    this.theme = cycleTheme();
  },

  view(this: any) {
    const user = this.user;
    const path = currentPath();
    const sessions = path === '/sessions' || path.startsWith('/sessions/');
    const clients = path === '/clients' || path.startsWith('/clients/');
    const users = path === '/users' || path.startsWith('/users/');
    const settings = path === '/settings' || path.startsWith('/settings/');
    const realmSlug = sessionsRealm();
    const clientRealmSlug = clientsRealm();
    const userRealmSlug = usersRealm();
    const settingsRealmSlug = settingsRealm();
    const clientEdit = clientEditPath();
    const userDetail = userDetailPath();
    const globalUser = globalUserDetailPath();
    const isGlobalUsers = usersRealm() === 'global';
    const firstRealm = this.realms && this.realms.length > 0 ? this.realms[0].slug : null;
    const sessionsHref = firstRealm
      ? `/sessions/${encodeURIComponent(firstRealm)}`
      : '/sessions';
    const clientsHref = firstRealm
      ? `/clients/${encodeURIComponent(firstRealm)}`
      : '/clients';
    const usersHref = firstRealm ? `/users/${encodeURIComponent(firstRealm)}` : '/users';
    const settingsHref = firstRealm ? `/settings/${encodeURIComponent(firstRealm)}` : '/settings';

    const navItems: NavItem[] = [
      {
        href: appUrl('/'),
        label: 'Overview',
        icon: LayoutGrid,
        active: !sessions && !clients && !users && !settings,
        onclick: (event: Event) => {
          event.preventDefault();
          m.route.set('/');
        },
      },
      {
        href: appUrl(clientsHref),
        label: 'Clients',
        icon: AppWindow,
        active: clients,
        onclick: (event: Event) => {
          event.preventDefault();
          m.route.set(clientsHref);
        },
      },
      {
        href: appUrl(sessionsHref),
        label: 'Sessions',
        icon: Activity,
        active: sessions,
          onclick: (event: Event) => {
            event.preventDefault();
            m.route.set(sessionsHref);
          },
        },
        {
          href: appUrl(usersHref),
          label: 'Users',
          icon: Users,
          active: users,
          onclick: (event: Event) => {
            event.preventDefault();
            m.route.set(usersHref);
          },
        },
        {
          href: appUrl(settingsHref),
          label: 'Settings',
          icon: Settings,
          active: settings,
          onclick: (event: Event) => {
            event.preventDefault();
            m.route.set(settingsHref);
          },
        },
      ];

    return (
      <AppShell
        topbar={
          <Topbar
            href={appUrl('/')}
            onclick={(event: Event) => {
              event.preventDefault();
              m.route.set('/');
            }}
          >
            <UserMenu
              name={user?.name || 'Administrator'}
              meta={user?.email || user?.preferred_username || 'Identity provider'}
              accountHref={`${this.authUrl}/app/account`}
              theme={this.theme}
              onCycleTheme={() => this.cycleTheme()}
              onSignOut={() => {
                adminSignOut().catch((error: Error) => {
                  this.error = error;
                  m.redraw();
                });
              }}
            />
          </Topbar>
        }
        nav={<Nav label="Administration" ariaLabel="Administration" items={navItems} />}
      >
        {this.error ? (
          <div class="alert" role="alert">
            {this.error.message}
          </div>
        ) : null}

        {!user ? (
          <div class="loading">Loading session</div>
        ) : clients && clientEdit ? (
          <ClientEditPage
            realmSlug={clientEdit.realmSlug}
            clientId={clientEdit.clientId}
            realms={this.realms}
            realmsError={this.realmsError}
            onAuthExpired={() => this.authExpired()}
          />
        ) : clients ? (
          <ClientsPage
            realmSlug={clientRealmSlug}
            realms={this.realms}
            realmsError={this.realmsError}
            onAuthExpired={() => this.authExpired()}
          />
        ) : users && globalUser ? (
          <GlobalUserPage
            userId={globalUser.userId}
            realmsError={this.realmsError}
            onAuthExpired={() => this.authExpired()}
          />
        ) : users && userDetail ? (
          <UserPage
            realmSlug={userDetail.realmSlug}
            userId={userDetail.userId}
            realms={this.realms}
            realmsError={this.realmsError}
            onAuthExpired={() => this.authExpired()}
          />
        ) : users ? (
          <UsersPage
            realmSlug={userRealmSlug}
            realms={this.realms}
            realmsError={this.realmsError}
            onAuthExpired={() => this.authExpired()}
            isSystemAdmin={Boolean(this.systemAdmin)}
            isGlobal={isGlobalUsers}
          />
        ) : settings ? (
          <SettingsPage
            realmSlug={settingsRealmSlug}
            realms={this.realms}
            realmsError={this.realmsError}
            onAuthExpired={() => this.authExpired()}
            onRealmsChanged={() => this.reloadRealms()}
          />
        ) : sessions ? (
          <SessionsPage
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
      </AppShell>
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
      <StatusPage
        title={this.error ? 'Sign-in failed' : 'Completing sign-in'}
        message={
          this.error
            ? this.error.message
            : 'Establishing the administrative session.'
        }
        error={Boolean(this.error)}
        action={
          this.error
            ? { href: appUrl('/'), label: 'Return to administration' }
            : undefined
        }
      />
    );
  },
};
