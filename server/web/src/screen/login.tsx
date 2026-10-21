import m from 'mithril';
import {
  getClientDiscovery,
  getSession,
  resolveLogin,
  selectSession,
  signInPassword,
  type ClientDiscovery,
  type LoginResolution,
  type PasswordLoginResult,
  type SessionAccount,
} from '../util/api';

type Step = 'accounts' | 'identifier' | 'password' | 'oidc' | 'done';

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

export const Login: m.Component<{ realm?: string; clientId?: string }> = {
  realmSlug: null as string | null,
  clientId: null as string | null,
  discovery: null as ClientDiscovery | null,
  step: 'identifier' as Step,
  accounts: [] as SessionAccount[],
  identifier: '',
  password: '',
  longSession: false,
  provider: null as LoginResolution['provider'] | null,
  signedIn: null as PasswordLoginResult['user'] | null,
  error: null as Error | null,
  pending: false,

  oninit(this: any, vnode: any) {
    this.realmSlug = vnode.attrs.realm ?? null;
    this.clientId = vnode.attrs.clientId ?? null;
    this.loadClient();
  },

  async loadClient(this: any) {
    this.error = null;
    try {
      const discovery = await getClientDiscovery(this.clientId);
      this.discovery = discovery;
      this.realmSlug = discovery.realm;
      this.clientId = discovery.client_id;
      document.title = discovery.display_name;
      await this.loadAccounts();
    } catch (e) {
      this.error = e as Error;
    }
    m.redraw();
  },

  async loadAccounts(this: any) {
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
        const current = m.route.get() || '';
        m.route.set(current.replace(/\/login$/, '/authorize'));
        return;
      }

      if (this.clientId === 'admin') {
        m.route.set(this.realmSlug ? `/realms/${this.realmSlug}/admin` : '/admin');
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
        const current = m.route.get() || '';
        m.route.set(current.replace(/\/login$/, '/authorize'));
        return;
      }

      if (this.clientId === 'admin') {
        m.route.set(this.realmSlug ? `/realms/${this.realmSlug}/admin` : '/admin');
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

    const title = this.discovery?.display_name || 'Sign in';

    return (
      <div class="auth-page" style={style}>
        <div class="auth-card">
          {typeof branding.logo_url === 'string' && branding.logo_url ? (
            <img class="auth-logo" src={branding.logo_url} alt={title} />
          ) : null}
          <h1>{title}</h1>

          {this.step === 'accounts' ? this.renderAccounts() : null}
          {this.step === 'identifier' ? this.renderIdentifier() : null}
          {this.step === 'password' ? this.renderPassword() : null}
          {this.step === 'oidc' ? this.renderProvider() : null}
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
          {this.accounts.length >= 2 ? (
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

  renderDone(this: any) {
    const user = this.signedIn;
    return (
      <div>
        <p class="auth-note">Signed in as {user?.display_name || user?.username}</p>
      </div>
    );
  },
};
