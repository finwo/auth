import { Activity, AppWindow, LayoutGrid, LibraryBig, Settings, Users } from 'lucide';
import m from 'mithril';
import { AppShell } from '@component/app-shell';
import { type NavItem } from '@component/nav';
import { MobileNavAccount, MobileNavToggle } from '@component/mobile-nav';
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
import { realmNavigation } from '../util/navigation';
import { OverviewPage } from './overview';
import { RealmsPage } from './realms';
import { SessionsPage } from './sessions';
import { ClientEditPage } from './client-edit';
import { ClientsPage } from './clients';
import { GlobalUserPage } from './global-user';
import { HostsPage } from './hosts';
import { EmailDomainsPage } from './email-domains';
import { UserPage } from './user';
import { UsersPage } from './users';
import { SettingsPage } from './settings';
import { SystemSettingsPage } from './system-settings';

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

function hostsRealm() {
  const path = currentPath();
  if (path !== '/hosts' && !path.startsWith('/hosts/')) return null;
  const suffix = path.slice('/hosts/'.length);
  if (!suffix) return null;
  const slug = suffix.split('/')[0];
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}

function emailDomainsRealm() {
  const path = currentPath();
  if (path !== '/email-domains' && !path.startsWith('/email-domains/')) return null;
  const suffix = path.slice('/email-domains/'.length);
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
  canCreateRealm: false,
  adminAccessLoaded: false,
  accountRedirecting: false,
  routeGuardActive: false,
  realms: null as AdminRealm[] | null,
  realmsError: null as Error | null,
  error: null as Error | null,
  authUrl: window.location.origin,
  theme: getTheme() as Theme,
  mobileNavOpen: false,
  lastPath: '',
  desktopMedia: null as MediaQueryList | null,
  onDesktopMediaChange: null as ((event: MediaQueryListEvent) => void) | null,

  oninit(this: any) {
    applyTheme(this.theme);
    this.lastPath = currentPath();
    this.load();
  },

  oncreate(this: any) {
    this.desktopMedia = window.matchMedia('(min-width: 60em)');
    this.onDesktopMediaChange = (event: MediaQueryListEvent) => {
      if (event.matches) this.mobileNavOpen = false;
    };
    this.desktopMedia.addEventListener('change', this.onDesktopMediaChange);
  },

  onremove(this: any) {
    if (this.desktopMedia && this.onDesktopMediaChange) {
      this.desktopMedia.removeEventListener('change', this.onDesktopMediaChange);
    }
  },

  onupdate(this: any) {
    const path = currentPath();
    if (path !== this.lastPath) {
      this.lastPath = path;
      this.mobileNavOpen = false;
    }
    this.ensureRouteAccess();
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
      this.canCreateRealm = me.can_create_realm;
      this.adminAccessLoaded = true;
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        await this.login();
        return;
      }
      this.systemAdmin = false;
      this.canCreateRealm = false;
    }

    this.ensureRouteAccess();
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
    let reloadFailed = false;

    try {
      this.realms = await loadAdminRealms();
      this.realmsError = null;
    } catch (e: any) {
      reloadFailed = true;
      if (e?.status === 401 || e?.status === 400) {
        await this.login();
        return;
      }
      this.realmsError = e as Error;
    }

    try {
      const me = await loadAdminMe();
      this.systemAdmin = me.is_system_admin;
      this.canCreateRealm = me.can_create_realm;
      this.adminAccessLoaded = true;
    } catch (e: any) {
      reloadFailed = true;
      if (e?.status === 401 || e?.status === 400) {
        await this.login();
        return;
      }
      this.canCreateRealm = false;
      this.adminAccessLoaded = false;
    }

    if (!reloadFailed) {
      this.ensureRouteAccess();
    }
    m.redraw();
  },

  ensureRouteAccess(this: any) {
    if (!this.realms || !this.adminAccessLoaded || this.accountRedirecting) return false;

    const path = currentPath();

    if (this.realms.length === 0 && !this.canCreateRealm) {
      this.accountRedirecting = true;
      this.routeGuardActive = true;
      clearAdminTokens();
      window.location.assign(`${this.authUrl}/app/account`);
      return true;
    }

    if (
      path === '/realms' &&
      this.realms.length === 1 &&
      !this.canCreateRealm
    ) {
      this.routeGuardActive = true;
      m.route.set(`/settings/${encodeURIComponent(this.realms[0].slug)}`, null, {
        replace: true,
      });
      return true;
    }

    if (path === '/system-settings' && !this.systemAdmin) {
      this.routeGuardActive = true;
      m.route.set('/', null, { replace: true });
      return true;
    }

    this.routeGuardActive = false;
    return false;
  },

  updateTitle(this: any) {
    const path = currentPath();
    const realmsPath = path === '/realms';
    const clients = path === '/clients' || path.startsWith('/clients/');
    const sessions = path === '/sessions' || path.startsWith('/sessions/');
    const users = path === '/users' || path.startsWith('/users/');
    const systemSettings = path === '/system-settings';
    const realmSettings = path === '/settings' || path.startsWith('/settings/');
    const hosts = path === '/hosts' || path.startsWith('/hosts/');
    const emailDomains = path === '/email-domains' || path.startsWith('/email-domains/');
    const title = realmsPath
      ? 'Realms | Administration'
      : clients
      ? path.includes('/edit/')
        ? 'Edit client | Administration'
        : 'Clients | Administration'
      : sessions
        ? 'Sessions | Administration'
        : users
          ? userDetailPath() || globalUserDetailPath()
            ? 'User | Administration'
            : 'Users | Administration'
          : systemSettings
            ? 'System settings | Administration'
            : hosts
              ? 'Hosts | Administration'
              : emailDomains
                ? 'Email domains | Administration'
                : realmSettings
                  ? 'Realm settings | Administration'
                  : 'Administration';
    document.title = title;
  },

  toggleMobileNav(this: any) {
    this.mobileNavOpen = !this.mobileNavOpen;
  },

  closeMobileNav(this: any) {
    this.mobileNavOpen = false;
  },

  cycleTheme(this: any) {
    this.theme = cycleTheme();
  },

  view(this: any) {
    const user = this.user;
    const path = currentPath();
    const routeGuardActive = Boolean(this.routeGuardActive || this.accountRedirecting);
    const realmsPath = path === '/realms';
    const sessions = path === '/sessions' || path.startsWith('/sessions/');
    const clients = path === '/clients' || path.startsWith('/clients/');
    const users = path === '/users' || path.startsWith('/users/');
    const systemSettings = path === '/system-settings';
    const realmSettings = path === '/settings' || path.startsWith('/settings/');
    const hosts = path === '/hosts' || path.startsWith('/hosts/');
    const emailDomains = path === '/email-domains' || path.startsWith('/email-domains/');
    const realmSlug = sessionsRealm();
    const clientRealmSlug = clientsRealm();
    const userRealmSlug = usersRealm();
    const settingsRealmSlug = settingsRealm();
    const hostsRealmSlug = hostsRealm();
    const emailDomainsRealmSlug = emailDomainsRealm();
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
    const realmNav = realmNavigation(this.realms, Boolean(this.canCreateRealm));

    const navItems: NavItem[] = [
      {
        href: appUrl('/'),
        label: 'Overview',
        icon: LayoutGrid,
        active: path === '/',
        onclick: (event: Event) => {
          event.preventDefault();
          m.route.set('/');
        },
      },
    ];

    if (realmNav.visible) {
      navItems.push({
        href: appUrl(realmNav.href),
        label: realmNav.label,
        icon: LibraryBig,
        active: realmsPath || realmSettings || hosts || emailDomains,
        onclick: (event: Event) => {
          event.preventDefault();
          m.route.set(realmNav.href);
        },
      });
    }

    if (firstRealm) {
      navItems.push(
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
        }
      );
    }

    if (this.systemAdmin) {
      navItems.push({
        href: appUrl('/system-settings'),
        label: 'Settings',
        icon: Settings,
        active: systemSettings,
        onclick: (event: Event) => {
          event.preventDefault();
          m.route.set('/system-settings');
        },
      });
    }

    return (
      <AppShell
        topbar={
          <Topbar
            href={appUrl('/')}
            onclick={(event: Event) => {
              event.preventDefault();
              this.closeMobileNav();
              m.route.set('/');
            }}
            menuButton={
              <MobileNavToggle
                expanded={this.mobileNavOpen}
                onToggle={() => this.toggleMobileNav()}
              />
            }
          >
            <UserMenu
              name={user?.name || 'Administrator'}
              meta={user?.email || user?.preferred_username || 'Identity provider'}
              accountHref={`${this.authUrl}/app/account`}
              theme={this.theme}
              onCycleTheme={() => this.cycleTheme()}
              onSignOut={() => {
                this.closeMobileNav();
                adminSignOut().catch((error: Error) => {
                  this.error = error;
                  m.redraw();
                });
              }}
            />
          </Topbar>
        }
        navLabel="Administration"
        navAriaLabel="Administration"
        navItems={navItems}
        accountPanel={
          <MobileNavAccount
            name={user?.name || 'Administrator'}
            meta={user?.email || user?.preferred_username || 'Identity provider'}
            accountHref={`${this.authUrl}/app/account`}
            theme={this.theme}
            onCycleTheme={() => this.cycleTheme()}
            onSignOut={() => {
              this.closeMobileNav();
              adminSignOut().catch((error: Error) => {
                this.error = error;
                m.redraw();
              });
            }}
          />
        }
        mobileNavOpen={this.mobileNavOpen}
        onMobileNavClose={() => this.closeMobileNav()}
      >
        {this.error ? (
          <div class="alert" role="alert">
            {this.error.message}
          </div>
        ) : null}

        {!user || routeGuardActive || this.accountRedirecting ? (
          <div class="loading">Loading session</div>
        ) : realmsPath ? (
          <RealmsPage
            realms={this.realms}
            realmsError={this.realmsError}
            canCreateRealm={Boolean(this.canCreateRealm)}
            onAuthExpired={() => this.authExpired()}
            onRealmsChanged={() => this.reloadRealms()}
          />
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
        ) : systemSettings ? (
          <SystemSettingsPage onAuthExpired={() => this.authExpired()} />
        ) : hosts ? (
          <HostsPage
            realmSlug={hostsRealmSlug}
            realms={this.realms}
            realmsError={this.realmsError}
            canCreateRealm={Boolean(this.canCreateRealm)}
            onAuthExpired={() => this.authExpired()}
          />
        ) : emailDomains ? (
          <EmailDomainsPage
            realmSlug={emailDomainsRealmSlug}
            realms={this.realms}
            realmsError={this.realmsError}
            canCreateRealm={Boolean(this.canCreateRealm)}
            onAuthExpired={() => this.authExpired()}
          />
        ) : realmSettings ? (
          <SettingsPage
            realmSlug={settingsRealmSlug}
            realms={this.realms}
            realmsError={this.realmsError}
            canCreateRealm={Boolean(this.canCreateRealm)}
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
          <OverviewPage user={user} />
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
