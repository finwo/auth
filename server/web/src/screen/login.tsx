import m from 'mithril';
import { getRealm, resolveLogin, signInPassword, type LoginResolution, type RealmInfo } from '../util/api';

type Step = 'identifier' | 'password' | 'oidc';

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

export const Login: m.Component<{ realm?: string }> = {
  realmSlug: null as string | null,
  realm: null as RealmInfo | null,
  step: 'identifier' as Step,
  identifier: '',
  password: '',
  provider: null as LoginResolution['provider'] | null,
  error: null as Error | null,
  pending: false,

  oninit(this: any, vnode: any) {
    this.realmSlug = vnode.attrs.realm ?? null;
    this.loadRealm();
  },

  async loadRealm(this: any) {
    this.error = null;
    try {
      const realm = await getRealm(this.realmSlug);
      this.realm = realm;
      document.title = realm.display_name;
    } catch (e) {
      this.error = e as Error;
    }
    m.redraw();
  },

  async submitIdentifier(this: any) {
    this.pending = true;
    this.error = null;
    try {
      const result = await resolveLogin(this.realmSlug, this.identifier);
      this.realm = result.realm;
      document.title = result.realm.display_name;
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
      await signInPassword(this.realmSlug, this.identifier, this.password);
    } catch (e) {
      this.error = e as Error;
    }
    this.pending = false;
    m.redraw();
  },

  back(this: any) {
    this.step = 'identifier';
    this.password = '';
    this.provider = null;
    this.error = null;
    m.redraw();
  },

  view(this: any) {
    const branding = this.realm?.branding || {};
    const primary = typeof branding.primary_color === 'string' ? branding.primary_color : '#25A';
    const style = { '--realm-primary': primary } as any;

    if (!this.realm && this.error) {
      return (
        <div class="auth-page" style={style}>
          <div class="auth-card">
            <h1>Sign in</h1>
            <p class="auth-error">{this.error.message}</p>
          </div>
        </div>
      );
    }

    const title = this.realm?.display_name || 'Sign in';

    return (
      <div class="auth-page" style={style}>
        <div class="auth-card">
          {typeof branding.logo_url === 'string' && branding.logo_url ? (
            <img class="auth-logo" src={branding.logo_url} alt={title} />
          ) : null}
          <h1>{title}</h1>

          {this.step === 'identifier' ? this.renderIdentifier(title) : null}
          {this.step === 'password' ? this.renderPassword() : null}
          {this.step === 'oidc' ? this.renderProvider() : null}
        </div>
      </div>
    );
  },

  renderIdentifier(this: any, title: string) {
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
          {provider ? `This account signs in with ${provider.display_name}.` : 'This account signs in with an identity provider.'}
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
};
