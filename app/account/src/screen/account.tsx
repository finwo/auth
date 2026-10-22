import { AppWindow, LayoutGrid, ShieldCheck } from 'lucide';
import m from 'mithril';
import { AppShell } from '@component/app-shell';
import { Nav, type NavItem } from '@component/nav';
import { StatusPage } from '@component/status-page';
import { Topbar } from '@component/topbar';
import { UserMenu } from '@component/user-menu';
import { applyTheme, cycleTheme, getTheme, type Theme } from '@util/theme';
import {
  appUrl,
  getClientConsent,
  getClientSession,
  getDiscovery,
  getFullAccountUrl,
  revokeClientConsent,
  type ClientConsentInfo,
  type Discovery,
  type SessionInfo,
  type UserInfo,
} from '../util/api';
import {
  accountSignOut,
  completeAccountLogin,
  getAccountTokens,
  loadAccountUser,
  startAccountLogin,
  type AccountTokens,
} from '../util/auth';
import { AppsPage } from './apps';
import { ClientOverviewPage, LoadingOverview, OverviewPage } from './overview';
import { SecurityPage } from './security';

type Mode = 'oidc' | 'client';
type Page = 'overview' | 'security' | 'apps';

function currentPath() {
  return (m.route.get() || '/').split('?')[0];
}

function currentPage(): Page {
  const path = currentPath();
  if (path === '/security') return 'security';
  if (path === '/apps') return 'apps';
  return 'overview';
}

export const Account: m.Component = {
  mode: null as Mode | null,
  user: null as UserInfo | null,
  session: null as SessionInfo | null,
  consent: null as ClientConsentInfo | null,
  discovery: null as Discovery | null,
  fullAccountUrl: null as string | null,
  notice: null as string | null,
  error: null as Error | null,
  pending: false,
  revokePending: false,
  signedOut: false,
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
      const discovery = await getDiscovery();
      this.discovery = discovery;

      if (!discovery) {
        this.mode = 'client';
        if (currentPage() !== 'overview') {
          m.route.set('/', null, { replace: true });
        }
        this.session = await getClientSession();
        const clientId = this.session.scope.client_id;
        if (clientId) {
          this.consent = await getClientConsent(clientId);
        }
        this.fullAccountUrl = this.consent?.account_url || (await getFullAccountUrl());
      } else if (!getAccountTokens()) {
        await startAccountLogin();
        return;
      } else {
        this.mode = 'oidc';
        this.user = await loadAccountUser();
      }
      this.updateTitle();
    } catch (e) {
      const error = e as any;
      if (this.mode === 'oidc' && (error?.status === 401 || error?.status === 400)) {
        try {
          await startAccountLogin();
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

  async signOut(this: any) {
    if (this.pending) return;
    this.pending = true;
    this.error = null;
    if (this.mode === 'client') {
      try {
        await fetch('/api/v1/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
        this.session = null;
        this.signedOut = true;
        this.pending = false;
        m.redraw();
      } catch (e) {
        this.error = e as Error;
        this.pending = false;
        m.redraw();
      }
      return;
    }
    await accountSignOut();
  },

  async revokeConsent(this: any) {
    const clientId = this.session?.scope.client_id;
    if (!clientId) return;
    this.revokePending = true;
    this.error = null;
    this.notice = null;
    try {
      this.consent = await revokeClientConsent(clientId);
      this.notice = 'Access revoked. You can still use your account here.';
    } catch (e) {
      this.error = e as Error;
    }
    this.revokePending = false;
    m.redraw();
  },

  updateTitle(this: any) {
    const page = currentPage();
    if (this.mode === 'client') {
      document.title = 'Account';
      return;
    }
    document.title =
      page === 'security'
        ? 'Security · Account'
        : page === 'apps'
          ? 'Apps · Account'
          : 'Account';
  },

  cycleTheme(this: any) {
    this.theme = cycleTheme();
  },

  view(this: any) {
    const page = currentPage();
    const activePage = this.mode === 'client' ? 'overview' : page;
    const tokens = getAccountTokens() as AccountTokens | null;
    const name =
      this.user?.name || this.session?.user.display_name || this.session?.user.username;
    const meta =
      this.user?.email ||
      this.user?.preferred_username ||
      this.session?.user.username ||
      'Loading account';

    const navItems: NavItem[] = [
      {
        href: appUrl('/'),
        label: 'Overview',
        icon: LayoutGrid,
        active: activePage === 'overview',
        onclick: (event: Event) => {
          event.preventDefault();
          m.route.set('/');
        },
      },
    ];

    if (this.mode !== 'client') {
      navItems.push(
        {
          href: appUrl('/security'),
          label: 'Security',
          icon: ShieldCheck,
          active: activePage === 'security',
          onclick: (event: Event) => {
            event.preventDefault();
            m.route.set('/security');
          },
        },
        {
          href: appUrl('/apps'),
          label: 'Apps',
          icon: AppWindow,
          active: activePage === 'apps',
          onclick: (event: Event) => {
            event.preventDefault();
            m.route.set('/apps');
          },
        }
      );
    }

    return (
      <AppShell
        topbar={
          <Topbar
            href={appUrl('/')}
            label="Auth account"
            onclick={(event: Event) => {
              event.preventDefault();
              m.route.set('/');
            }}
          >
            <UserMenu
              name={name || 'Account'}
              meta={meta}
              theme={this.theme}
              onCycleTheme={() => this.cycleTheme()}
              onSignOut={() => {
                this.signOut().catch((error: Error) => {
                  this.error = error;
                  m.redraw();
                });
              }}
            />
          </Topbar>
        }
        nav={<Nav label="Account" ariaLabel="Account" items={navItems} />}
      >
        {this.error ? (
          <div class="alert" role="alert">
            {this.error.message}
          </div>
        ) : null}

        {this.notice ? (
          <div class="notice" role="status">
            {this.notice}
          </div>
        ) : null}

        {this.signedOut ? (
          <div class="empty">
            <p>You are signed out.</p>
          </div>
        ) : !name ? (
          this.error ? null : (
            <LoadingOverview />
          )
        ) : this.mode === 'client' ? (
          <ClientOverviewPage
            session={this.session!}
            consent={this.consent}
            fullAccountUrl={this.fullAccountUrl}
            revokePending={this.revokePending}
            onRevoke={() => this.revokeConsent()}
          />
        ) : activePage === 'security' ? (
          <SecurityPage />
        ) : activePage === 'apps' ? (
          <AppsPage />
        ) : (
          <OverviewPage user={this.user!} discovery={this.discovery} tokens={tokens} />
        )}
      </AppShell>
    );
  },
};

export const AccountCallback: m.Component = {
  error: null as Error | null,

  oninit(this: any) {
    this.complete();
  },

  async complete(this: any) {
    const query = (m.route.get() || '').split('?')[1] || '';
    try {
      await completeAccountLogin(query);
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
            : 'Establishing the account session.'
        }
        error={Boolean(this.error)}
        action={
          this.error
            ? { href: appUrl('/'), label: 'Return to account' }
            : undefined
        }
      />
    );
  },
};
