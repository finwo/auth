import { AppWindow, ShieldCheck } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';
import { PageHeader } from '@component/page-header';
import type { AccountTokens } from '../util/auth';
import type { ClientConsentInfo, Discovery, SessionInfo, UserInfo } from '../util/api';

interface OverviewAttrs {
  user: UserInfo;
  discovery: Discovery | null;
  tokens: AccountTokens | null;
}

interface ClientOverviewAttrs {
  session: SessionInfo;
  consent: ClientConsentInfo | null;
  fullAccountUrl: string | null;
  revokePending: boolean;
  onRevoke: () => void;
}

export const OverviewPage: m.Component<OverviewAttrs> = {
  view({ attrs }) {
    const { user, discovery, tokens } = attrs;
    const account = discovery?.realm || 'Global';

    return (
      <div>
        <PageHeader
          title="Overview"
          subtitle="Identity and access settings for this account."
        />

        <div class="grid">
          <section class="panel">
            <h2>Identity</h2>
            <dl class="details">
              <div>
                <dt>Name</dt>
                <dd>{user.name}</dd>
              </div>
              <div>
                <dt>Username</dt>
                <dd>{user.preferred_username}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{user.email || 'Not set'}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{account}</dd>
              </div>
            </dl>
          </section>

          <section class="panel">
            <h2>Access</h2>
            <dl class="details">
              <div>
                <dt>Client</dt>
                <dd>account</dd>
              </div>
              <div>
                <dt>Realm</dt>
                <dd>{account}</dd>
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
        </div>

        <section class="panel panel-wide">
          <h2>Manage</h2>
          <ul class="summary-list">
            <li>
              <a
                class="summary-row"
                href="#"
                onclick={(event: Event) => {
                  event.preventDefault();
                  m.route.set('/security');
                }}
              >
                {Icon(ShieldCheck)}
                <span class="summary-body">
                  <span class="summary-title">Security</span>
                  <span class="summary-meta">
                    Password, multi-factor authentication and sessions.
                  </span>
                </span>
                <span class="summary-arrow" aria-hidden="true">
                  ›
                </span>
              </a>
            </li>
            <li>
              <a
                class="summary-row"
                href="#"
                onclick={(event: Event) => {
                  event.preventDefault();
                  m.route.set('/apps');
                }}
              >
                {Icon(AppWindow)}
                <span class="summary-body">
                  <span class="summary-title">Apps</span>
                  <span class="summary-meta">
                    Applications with access to this account.
                  </span>
                </span>
                <span class="summary-arrow" aria-hidden="true">
                  ›
                </span>
              </a>
            </li>
          </ul>
        </section>
      </div>
    );
  },
};

export const ClientOverviewPage: m.Component<ClientOverviewAttrs> = {
  view({ attrs }) {
    const { session, consent, fullAccountUrl, revokePending, onRevoke } = attrs;
    const name = session.user.display_name || session.user.username;
    const clientName = consent?.client.name || session.scope.client_id || 'This app';
    const realm = session.realm?.display_name || 'Global';

    return (
      <div>
        <PageHeader title="Overview" subtitle={`Signed in through ${clientName}.`} />

        <div class="grid">
          <section class="panel">
            <h2>Identity</h2>
            <dl class="details">
              <div>
                <dt>Name</dt>
                <dd>{name}</dd>
              </div>
              <div>
                <dt>Username</dt>
                <dd>{session.user.username}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{realm}</dd>
              </div>
            </dl>
          </section>

          <section class="panel">
            <h2>This app</h2>
            <dl class="details">
              <div>
                <dt>Client</dt>
                <dd>{clientName}</dd>
              </div>
              <div>
                <dt>Client ID</dt>
                <dd>{session.scope.client_id || 'None'}</dd>
              </div>
              <div>
                <dt>Realm</dt>
                <dd>{realm}</dd>
              </div>
              <div>
                <dt>Scopes</dt>
                <dd>{consent?.scopes.length ? consent.scopes.join(', ') : 'None'}</dd>
              </div>
            </dl>
          </section>
        </div>

        <section class="panel panel-wide">
          <h2>Access</h2>
          <dl class="details">
            <div>
              <dt>Consent</dt>
              <dd>{consent?.active ? 'Granted' : 'Not granted'}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>Active</dd>
            </div>
          </dl>
          <p class="note">
            {consent?.active
              ? `Revoking access removes ${clientName}'s consent. The app must ask again the next time it signs you in.`
              : `${clientName} no longer has access to this account.`}
          </p>
          {consent?.active ? (
            <p class="note">
              <button
                class="danger-link"
                type="button"
                disabled={revokePending}
                onclick={onRevoke}
              >
                {revokePending ? 'Revoking' : 'Revoke access'}
              </button>
            </p>
          ) : null}
        </section>

        <section class="panel panel-wide">
          <h2>Full account management</h2>
          <p class="note">
            Manage your identity, security and app permissions on the account host.
          </p>
          {fullAccountUrl ? (
            <p class="note">
              <a class="button" href={fullAccountUrl}>
                Open full account
              </a>
            </p>
          ) : null}
        </section>
      </div>
    );
  },
};

export const LoadingOverview: m.Component = {
  view() {
    return (
      <div>
        <PageHeader title="Overview" subtitle="Loading account." />

        <div class="grid">
          <section class="panel">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-medium"></div>
            <div class="skeleton skeleton-short"></div>
          </section>
          <section class="panel">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
            <div class="skeleton skeleton-medium"></div>
          </section>
        </div>
      </div>
    );
  },
};
