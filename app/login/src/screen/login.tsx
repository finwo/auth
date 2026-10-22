import { Check, CircleUserRound } from 'lucide';
import m from 'mithril';
import { icon } from '../util/icon';
import {
  decideConsent,
  getClientDiscovery,
  getConsent,
  getSession,
  resolveLogin,
  selectSession,
  signInPassword,
  signOut,
  type ClientDiscovery,
  type ConsentRequest,
  type LoginResolution,
  type PasswordLoginResult,
  type SessionAccount,
} from '../util/api';

type Step = 'accounts' | 'identifier' | 'password' | 'oidc' | 'consent' | 'done';

interface TextFieldAttrs {
  id: string;
  label: string;
  type?: string;
  value: string;
  autocomplete?: string;
  autofocus?: boolean;
  disabled?: boolean;
  oninput: (value: string) => void;
}

function queryParam(name: string) {
  const query = (m.route.get() || '').split('?')[1] || '';
  return new URLSearchParams(query).get(name);
}

function currentPath() {
  return (m.route.get() || '').split('?')[0];
}

function authorizeRoute() {
  return currentPath().replace(/\/(login|consent)$/, '/authorize');
}

function loginRoute() {
  return currentPath().replace(/\/consent$/, '/login');
}

function continueAuthorization() {
  window.location.assign(authorizeRoute());
}

function scopeDescription(scope: string, realmName: string) {
  if (scope === 'openid') return `Sign you in with your ${realmName} account.`;
  if (scope === 'profile') return 'See your name and username.';
  if (scope === 'email') return 'See your email address.';
  return `Use the ${scope} permission.`;
}

const TextField: m.Component<TextFieldAttrs> = {
  view({ attrs }) {
    return (
      <div class="auth-field">
        <input
          class="auth-input"
          id={attrs.id}
          type={attrs.type || 'text'}
          value={attrs.value}
          placeholder=" "
          autocomplete={attrs.autocomplete}
          disabled={attrs.disabled}
          oninput={(e: Event) => attrs.oninput((e.target as HTMLInputElement).value)}
          oncreate={attrs.autofocus ? ({ dom }: any) => dom.focus() : undefined}
        />
        <label for={attrs.id}>{attrs.label}</label>
      </div>
    );
  },
};

export const Login: m.Component<{ clientId?: string }> = {
  clientId: null as string | null,
  discovery: null as ClientDiscovery | null,
  step: 'identifier' as Step,
  accounts: [] as SessionAccount[],
  identifier: '',
  password: '',
  longSession: false,
  provider: null as LoginResolution['provider'] | null,
  signedIn: null as PasswordLoginResult['user'] | null,
  consentRequest: null as ConsentRequest | null,
  consentRoute: false,
  error: null as Error | null,
  pending: false,
  reauth: false,

  oninit(this: any, vnode: any) {
    this.clientId = vnode.attrs.clientId ?? null;
    this.reauth = queryParam('reauth') === '1';
    this.consentRoute = /\/consent$/.test(currentPath());
    this.loadClient();
  },

  async loadClient(this: any) {
    this.error = null;
    try {
      const discovery = await getClientDiscovery(this.clientId);
      this.discovery = discovery;
      this.clientId = discovery.client_id;
      document.title = discovery.display_name;
      if (this.consentRoute) {
        this.step = 'consent';
        await this.loadConsent();
      } else {
        await this.loadAccounts();
      }
    } catch (e) {
      this.error = e as Error;
    }
    m.redraw();
  },

  async loadConsent(this: any) {
    this.consentRequest = await getConsent(this.clientId);
  },

  async loadAccounts(this: any) {
    if (this.reauth) {
      this.accounts = [];
      return;
    }
    try {
      const session = await getSession();
      if (session.accounts.length >= 2) {
        this.accounts = session.accounts;
        this.step = 'accounts';
      }
    } catch {
      this.accounts = [];
    }
  },

  async submitIdentifier(this: any) {
    this.pending = true;
    this.error = null;
    try {
      const result = await resolveLogin(this.clientId, this.identifier);
      if (result.next === 'oidc' && result.provider) {
        this.provider = result.provider;
        this.step = 'oidc';
      } else {
        this.step = 'password';
      }
    } catch (e) {
      this.error = e as Error;
    }
    this.pending = false;
    m.redraw();
  },

  async submitPassword(this: any) {
    this.pending = true;
    this.error = null;
    try {
      const result = await signInPassword(
        this.clientId,
        this.identifier,
        this.password,
        this.longSession
      );

      if (result.pending_auth_request) {
        continueAuthorization();
        return;
      }

      this.signedIn = result.user;
      this.step = 'done';
      this.pending = false;
      m.redraw();
    } catch (e) {
      this.error = e as Error;
      this.pending = false;
      m.redraw();
    }
  },

  async selectAccount(this: any, account: SessionAccount) {
    this.pending = true;
    this.error = null;
    try {
      const result = await selectSession(account.public_id, this.clientId);
      if (result.pending_auth_request) {
        continueAuthorization();
        return;
      }

      this.signedIn = result.user;
      this.step = 'done';
    } catch (e) {
      this.error = e as Error;
    }
    this.pending = false;
    m.redraw();
  },

  async decideConsent(this: any, decision: 'allow' | 'deny') {
    this.pending = true;
    this.error = null;
    try {
      const result = await decideConsent(this.clientId, decision);
      window.location.assign(result.redirect || authorizeRoute());
      return;
    } catch (e) {
      this.error = e as Error;
    }
    this.pending = false;
    m.redraw();
  },

  async differentConsentAccount(this: any) {
    this.pending = true;
    this.error = null;
    try {
      await signOut();
      window.location.assign(loginRoute());
      return;
    } catch (e) {
      this.error = e as Error;
    }
    this.pending = false;
    m.redraw();
  },

  differentAccount(this: any) {
    this.step = 'identifier';
    this.identifier = '';
    this.password = '';
    this.longSession = false;
    this.provider = null;
    this.error = null;
    m.redraw();
  },

  back(this: any) {
    this.step = 'identifier';
    this.password = '';
    this.longSession = false;
    this.provider = null;
    this.error = null;
    m.redraw();
  },

  backToAccounts(this: any) {
    this.step = 'accounts';
    this.error = null;
    m.redraw();
  },

  view(this: any) {
    const branding = this.discovery?.branding || {};
    const primary = typeof branding.primary_color === 'string' ? branding.primary_color : '#25A';
    const style = { '--realm-primary': primary } as any;

    if (!this.discovery && this.error) {
      return (
        <div class="auth-page" style={style}>
          <div class="auth-card">
            <h1>Sign in</h1>
            <p class="auth-error">{this.error.message}</p>
          </div>
        </div>
      );
    }

    const title =
      this.step === 'consent'
        ? this.consentRequest
          ? `Authorize ${this.consentRequest.client.name}`
          : 'Authorize access'
        : this.discovery?.display_name || 'Sign in';

    return (
      <div class="auth-page" style={style}>
        <div class={`auth-card${this.step === 'consent' ? ' auth-card-consent' : ''}`}>
          {typeof branding.logo_url === 'string' && branding.logo_url ? (
            <img class="auth-logo" src={branding.logo_url} alt={title} />
          ) : null}
          <h1>{title}</h1>

          {this.step === 'accounts' ? this.renderAccounts() : null}
          {this.step === 'identifier' ? this.renderIdentifier() : null}
          {this.step === 'password' ? this.renderPassword() : null}
          {this.step === 'oidc' ? this.renderProvider() : null}
          {this.step === 'consent' ? this.renderConsent() : null}
          {this.step === 'done' ? this.renderDone() : null}
        </div>
      </div>
    );
  },

  renderAccounts(this: any) {
    return (
      <div>
        <p class="auth-note">Choose an account to continue.</p>
        <div class="auth-accounts">
          {this.accounts.map((account: SessionAccount) => {
            const name = account.user.display_name || account.user.username;
            const secondary =
              account.user.display_name && account.user.display_name !== account.user.username
                ? account.user.username
                : null;
            return (
              <button
                class="auth-account"
                type="button"
                disabled={this.pending}
                onclick={() => this.selectAccount(account)}
              >
                <span class="auth-account-name">{name}</span>
                {secondary ? <span class="auth-account-username">{secondary}</span> : null}
              </button>
            );
          })}
        </div>
        {this.error ? <p class="auth-error">{this.error.message}</p> : null}
        <div class="auth-actions">
          <button class="auth-link" type="button" onclick={() => this.differentAccount()}>
            Different account
          </button>
        </div>
      </div>
    );
  },

  renderIdentifier(this: any) {
    return (
      <form
        onsubmit={(e: Event) => {
          e.preventDefault();
          if (!this.pending && this.identifier.trim()) this.submitIdentifier();
        }}
      >
        {this.reauth ? (
          <p class="auth-note">Confirm your password to continue.</p>
        ) : null}
        <TextField
          id="identifier"
          label="Email or username"
          value={this.identifier}
          autocomplete="username"
          autofocus
          disabled={this.pending}
          oninput={(value: string) => {
            this.identifier = value;
          }}
        />
        {this.error ? <p class="auth-error">{this.error.message}</p> : null}
        <div class="auth-actions">
          {!this.reauth && this.accounts.length >= 2 ? (
            <button class="auth-link" type="button" onclick={() => this.backToAccounts()}>
              Back to accounts
            </button>
          ) : null}
          <button class="auth-button" type="submit" disabled={this.pending || !this.identifier.trim()}>
            {this.pending ? 'Checking' : 'Next'}
          </button>
        </div>
      </form>
    );
  },

  renderPassword(this: any) {
    return (
      <form
        onsubmit={(e: Event) => {
          e.preventDefault();
          if (!this.pending) this.submitPassword();
        }}
      >
        <p class="auth-identifier">{this.identifier}</p>
        <TextField
          id="password"
          label="Password"
          type="password"
          value={this.password}
          autocomplete="current-password"
          autofocus
          disabled={this.pending}
          oninput={(value: string) => {
            this.password = value;
          }}
        />
        {this.discovery?.allow_session_duration_choice !== false ? (
          <label class="auth-choice">
            <input
              type="checkbox"
              checked={this.longSession}
              disabled={this.pending}
              onchange={(e: Event) => {
                this.longSession = (e.target as HTMLInputElement).checked;
              }}
            />
            <span>Keep me signed in</span>
          </label>
        ) : null}
        {this.error ? <p class="auth-error">{this.error.message}</p> : null}
        <div class="auth-actions">
          <button class="auth-link" type="button" onclick={() => this.back()}>
            Back
          </button>
          <button class="auth-button" type="submit" disabled={this.pending || !this.password}>
            {this.pending ? 'Signing in' : 'Sign in'}
          </button>
        </div>
      </form>
    );
  },

  renderProvider(this: any) {
    const provider = this.provider;
    return (
      <div>
        <p class="auth-identifier">{this.identifier}</p>
        <p class="auth-note">
          {provider
            ? `This account signs in with ${provider.display_name}.`
            : 'This account signs in with an identity provider.'}
        </p>
        <div class="auth-actions">
          <button class="auth-link" type="button" onclick={() => this.back()}>
            Back
          </button>
          <button class="auth-button" type="button" disabled>
            Continue
          </button>
        </div>
      </div>
    );
  },

  renderConsent(this: any) {
    const request = this.consentRequest;
    if (!request) {
      return <p class="auth-note">Loading request</p>;
    }

    const realmName = request.realm?.display_name || 'account';
    const name = request.user.display_name || request.user.username;
    const secondary =
      request.user.display_name && request.user.display_name !== request.user.username
        ? request.user.username
        : 'Signed in';

    return (
      <div>
        <p class="auth-note">
          {request.client.name} is requesting access to your {realmName} account.
        </p>

        <div class="auth-consent-account">
          {icon(CircleUserRound)}
          <span class="auth-consent-account-body">
            <span class="auth-consent-account-name">{name}</span>
            <span class="auth-consent-account-meta">{secondary}</span>
          </span>
          <button
            class="auth-link"
            type="button"
            disabled={this.pending}
            onclick={() => this.differentConsentAccount()}
          >
            Not you?
          </button>
        </div>

        <p class="auth-consent-title">
          This will allow {request.client.name} to:
        </p>
        <ul class="auth-consent-scopes">
          {request.scopes.map((scope: string) => (
            <li class="auth-consent-scope">
              {icon(Check)}
              <span>{scopeDescription(scope, realmName)}</span>
            </li>
          ))}
        </ul>

        <p class="auth-note auth-consent-footer">
          You can revoke access at any time from your account settings.
        </p>
        {this.error ? <p class="auth-error">{this.error.message}</p> : null}

        <div class="auth-actions">
          <button
            class="auth-link"
            type="button"
            disabled={this.pending}
            onclick={() => this.decideConsent('deny')}
          >
            Deny
          </button>
          <button
            class="auth-button"
            type="button"
            disabled={this.pending}
            onclick={() => this.decideConsent('allow')}
          >
            {this.pending ? 'Working' : 'Allow access'}
          </button>
        </div>
      </div>
    );
  },

  renderDone(this: any) {
    const user = this.signedIn;
    return (
      <div>
        <p class="auth-note">Signed in as {user?.display_name || user?.username}</p>
      </div>
    );
  },
};
