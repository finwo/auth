import m from 'mithril';
import {
  appUrl,
  getClientConsent,
  getClientSession,
  getDiscovery,
  getFullAccountUrl,
  revokeClientConsent,
  type ClientConsentInfo,
  type SessionInfo,
  type UserInfo,
} from '../util/api';
import {
  accountSignOut,
  completeAccountLogin,
  getAccountTokens,
  loadAccountUser,
  startAccountLogin,
} from '../util/auth';
import { formatTime } from '@util/format';

type Mode = 'oidc' | 'client';

function PageHeader(title: string, subtitle: string) {
  return (
    <div class="account-page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  );
}

export const Account: m.Component = {
  mode: null as Mode | null,
  user: null as UserInfo | null,
  session: null as SessionInfo | null,
  consent: null as ClientConsentInfo | null,
  fullAccountUrl: null as string | null,
  notice: null as string | null,
  error: null as Error | null,
  pending: false,
  revokePending: false,

  oninit(this: any) {
    this.load();
  },

  async load(this: any) {
    try {
      const discovery = await getDiscovery();
      if (!discovery) {
        this.mode = 'client';
        this.session = await getClientSession();
        const clientId = this.session.scope.client_id;
        if (clientId) {
          this.consent = await getClientConsent(clientId);
        }
        this.fullAccountUrl = this.consent?.account_url || (await getFullAccountUrl());
        document.title = 'Account';
      } else if (!getAccountTokens()) {
        await startAccountLogin();
        return;
      } else {
        this.mode = 'oidc';
        this.user = await loadAccountUser();
        document.title = 'Account';
      }
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
    this.pending = true;
    this.error = null;
    if (this.mode === 'client') {
      try {
        await fetch('/api/v1/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
        this.session = null;
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

  view(this: any) {
    const tokens = getAccountTokens();
    const user = this.user;
    const session = this.session;
    const name = user?.name || session?.user.display_name || session?.user.username;

    return (
      <div class="account-app">
        <header class="account-topbar">
          <a class="account-brand" href={appUrl('/')}>
            Account
          </a>
          <button
            class="account-signout"
            type="button"
            disabled={this.pending || (!user && !session)}
            onclick={() => this.signOut()}
          >
            {this.pending ? 'Signing out' : 'Sign out'}
          </button>
        </header>

        {PageHeader('Account', 'Identity and access settings')}

        <main class="account-content">
          {this.error ? (
            <div class="account-alert" role="alert">
              {this.error.message}
            </div>
          ) : null}

          {this.notice ? (
            <div class="account-notice" role="status">
              {this.notice}
            </div>
          ) : null}

          {!name ? (
            <div class="account-loading">Loading account</div>
          ) : (
            <div class="account-grid">
              <section class="account-card">
                <h2>Identity</h2>
                <dl class="account-definition">
                  <div>
                    <dt>Name</dt>
                    <dd>{name}</dd>
                  </div>
                  <div>
                    <dt>Username</dt>
                    <dd>{user?.preferred_username || session?.user.username}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{user?.email || 'Not set'}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{session ? session.scope.type : 'account client'}</dd>
                  </div>
                </dl>
              </section>

              <section class="account-card">
                <h2>Access</h2>
                <dl class="account-definition">
                  <div>
                    <dt>Client</dt>
                    <dd>{session?.scope.client_id || 'account'}</dd>
                  </div>
                  <div>
                    <dt>Realm</dt>
                    <dd>{session?.realm?.display_name || 'Global'}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{formatTime(session?.expires_at || tokens?.expires_at)}</dd>
                  </div>
                  <div>
                    <dt>Permissions</dt>
                    <dd>
                      {session
                        ? this.consent?.active
                          ? 'Granted'
                          : 'Not granted'
                        : 'Full account'}
                    </dd>
                  </div>
                </dl>
              </section>

              {this.mode === 'client' ? (
                <section class="account-card account-card-wide">
                  <h2>App access</h2>
                  <dl class="account-definition">
                    <div>
                      <dt>App</dt>
                      <dd>{this.consent?.client.name || session?.scope.client_id}</dd>
                    </div>
                    <div>
                      <dt>Scopes</dt>
                      <dd>
                        {this.consent?.scopes.length
                          ? this.consent.scopes.join(', ')
                          : 'None'}
                      </dd>
                    </div>
                    <div>
                      <dt>Granted</dt>
                      <dd>
                        {this.consent?.consent
                          ? formatTime(this.consent.consent.created_at)
                          : 'Not granted'}
                      </dd>
                    </div>
                    <div>
                      <dt>Revoked</dt>
                      <dd>
                        {this.consent?.consent?.revoked_at
                          ? formatTime(this.consent.consent.revoked_at)
                          : 'Not revoked'}
                      </dd>
                    </div>
                  </dl>
                  <p class="account-note account-card-note">
                    {this.consent?.active
                      ? `${this.consent.client.name} can use the access above. Revoking it does not sign you out here.`
                      : `${session?.scope.client_id || 'This app'} no longer has access to your account.`}
                  </p>
                  <div class="account-actions">
                    {this.consent?.active ? (
                      <button
                        class="account-danger"
                        type="button"
                        disabled={this.revokePending}
                        onclick={() => this.revokeConsent()}
                      >
                        {this.revokePending ? 'Revoking' : 'Revoke access'}
                      </button>
                    ) : null}
                    {this.fullAccountUrl ? (
                      <a class="account-link" href={this.fullAccountUrl}>
                        Open full account
                      </a>
                    ) : null}
                  </div>
                </section>
              ) : (
                <section class="account-card account-card-wide">
                  <h2>Permissions</h2>
                  <p class="account-note">
                    App permissions and consent management arrive in the next account slice.
                  </p>
                </section>
              )}
            </div>
          )}
        </main>
      </div>
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
      <div class="account-status-page">
        <div class="account-status-panel">
          <h1>{this.error ? 'Sign-in failed' : 'Completing sign-in'}</h1>
          {this.error ? (
            <p class="account-alert" role="alert">
              {this.error.message}
            </p>
          ) : (
            <p class="account-note">Establishing the account session.</p>
          )}
          {this.error ? (
            <a class="account-link" href={appUrl('/')}>
              Return to account
            </a>
          ) : null}
        </div>
      </div>
    );
  },
};
