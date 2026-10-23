import { TemplateRuntime } from '@template';
import { bindActions } from '@template/runtime/actions';
import { getTheme, applyTheme } from '@util/theme';
import {
  decideConsent,
  getClientDiscovery,
  getConsent,
  getRealm,
  getSession,
  resolveLogin,
  selectSession,
  signInPassword,
  signOut,
  type ClientDiscovery,
  type ConsentRequest,
  type LoginResolution,
  type PasswordLoginResult,
  type RealmInfo,
  type SessionAccount,
} from './util/api';

import './assets/boot.css';

type Step =
  | 'loading'
  | 'accounts'
  | 'identifier'
  | 'password'
  | 'oidc'
  | 'consent'
  | 'done'
  | 'unavailable';

function routeInfo() {
  const match = location.pathname
    .replace(/\/+$/, '')
    .match(/\/oidc(?:\/([^/]+))?\/(login|consent)$/);
  return {
    clientId: match?.[1] ? decodeURIComponent(match[1]) : null,
    action: match?.[2] === 'consent' ? 'consent' : 'login',
  };
}

function authorizeUrl() {
  return location.pathname.replace(/\/(login|consent)\/?$/, '/authorize');
}

function loginUrl() {
  return location.pathname.replace(/\/consent\/?$/, '/login');
}

function continueAuthorization() {
  window.location.assign(authorizeUrl());
}

function scopeDescription(scope: string, realmName: string) {
  if (scope === 'openid') return `Sign you in with your ${realmName} account.`;
  if (scope === 'profile') return 'See your name and username.';
  if (scope === 'email') return 'See your email address.';
  return `Use the ${scope} permission.`;
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown) {
  const value = error as { status?: number; code?: string };
  if (value.code === 'invalid_credentials' || value.status === 401) {
    return 'The username or password is incorrect.';
  }
  if (value.status === 400 || value.status === 404) {
    return 'The sign-in request is no longer valid.';
  }
  return 'The sign-in service could not be reached. Try again in a moment.';
}

class LoginApp {
  private root: HTMLElement;
  private runtime: TemplateRuntime;
  private clientId: string | null;
  private consentRoute: boolean;
  private reauth: boolean;
  private discovery: ClientDiscovery | null = null;
  private realm: RealmInfo | null = null;
  private step: Step = 'loading';
  private accounts: SessionAccount[] = [];
  private identifier = '';
  private password = '';
  private longSession = false;
  private provider: LoginResolution['provider'] | null = null;
  private signedIn: PasswordLoginResult['user'] | null = null;
  private consentRequest: ConsentRequest | null = null;
  private error: string | null = null;
  private pending = false;

  constructor(root: HTMLElement, runtime: TemplateRuntime) {
    this.root = root;
    this.runtime = runtime;
    const route = routeInfo();
    this.clientId = route.clientId;
    this.consentRoute = route.action === 'consent';
    this.reauth = new URLSearchParams(location.search).get('reauth') === '1';
  }

  async start() {
    applyTheme(getTheme());
    try {
      await this.runtime.install();
      this.step = 'loading';
      this.render();
      await this.runtime.stylesReady();
      document.documentElement.dataset.templateReady = '';
      await this.loadClient();
    } catch (error) {
      console.error(error);
      this.showFatal();
    }
  }

  private async loadClient() {
    try {
      const discovery = await getClientDiscovery(this.clientId);
      this.discovery = discovery;
      this.clientId = discovery.client_id;
      document.title = discovery.display_name || discovery.client_name || 'Sign in';

      if (discovery.realm) {
        try {
          this.realm = await getRealm(discovery.realm);
        } catch {}
      }

      if (this.consentRoute) {
        await this.loadConsent();
        return;
      }
      await this.loadAccounts();
    } catch (error) {
      this.fail(error);
    }
  }

  private async loadConsent() {
    try {
      this.consentRequest = await getConsent(this.clientId);
      this.step = 'consent';
      this.render();
    } catch (error) {
      this.fail(error);
    }
  }

  private async loadAccounts() {
    if (this.reauth) {
      try {
        const session = await getSession();
        this.identifier = session.user.username;
      } catch {}
      this.step = this.identifier ? 'password' : 'identifier';
      this.render();
      return;
    }

    try {
      const session = await getSession();
      this.accounts = session.accounts || [];
    } catch {
      this.accounts = [];
    }

    this.step = this.accounts.length >= 2 ? 'accounts' : 'identifier';
    this.render();
  }

  async submitIdentifier(data: FormData) {
    if (this.pending) return;

    this.identifier = String(data.get('identifier') || '').trim();
    this.error = null;
    if (!this.identifier) {
      this.error = 'Enter an email address or username.';
      this.render();
      return;
    }

    this.pending = true;
    this.render();
    try {
      const result = await resolveLogin(this.clientId || '', this.identifier);
      this.realm = result.realm || this.realm;
      this.provider = result.provider || null;
      this.step = result.next === 'oidc' ? 'oidc' : 'password';
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.pending = false;
      this.render();
    }
  }

  async submitPassword(data: FormData) {
    if (this.pending) return;

    this.password = String(data.get('password') || '');
    this.longSession = data.get('long_session') === 'on';
    this.error = null;
    if (!this.password) {
      this.error = 'Enter your password.';
      this.render();
      return;
    }

    this.pending = true;
    this.render();
    try {
      const result = await signInPassword(
        this.clientId || '',
        this.identifier,
        this.password,
        this.longSession
      );
      this.realm = result.realm || this.realm;

      if (result.pending_auth_request) {
        continueAuthorization();
        return;
      }

      this.signedIn = result.user;
      this.step = 'done';
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.pending = false;
      this.render();
    }
  }

  async selectAccount(accountId: string) {
    if (this.pending || !accountId) return;

    this.pending = true;
    this.error = null;
    this.render();
    try {
      const result = await selectSession(accountId, this.clientId);
      if (result.pending_auth_request) {
        continueAuthorization();
        return;
      }

      this.signedIn = result.user;
      this.step = 'done';
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.pending = false;
      this.render();
    }
  }

  async decideConsent(decision: 'allow' | 'deny') {
    if (this.pending) return;

    this.pending = true;
    this.error = null;
    this.render();
    try {
      const result = await decideConsent(this.clientId || '', decision);
      window.location.assign(result.redirect || authorizeUrl());
      return;
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.pending = false;
      this.render();
    }
  }

  async differentConsentAccount() {
    if (this.pending) return;

    this.pending = true;
    this.error = null;
    this.render();
    try {
      await signOut();
      window.location.assign(loginUrl());
      return;
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.pending = false;
      this.render();
    }
  }

  differentAccount() {
    this.step = 'identifier';
    this.identifier = '';
    this.password = '';
    this.longSession = false;
    this.provider = null;
    this.error = null;
    this.render();
  }

  back() {
    this.step = 'identifier';
    this.password = '';
    this.provider = null;
    this.error = null;
    this.render();
  }

  backToAccounts() {
    this.step = 'accounts';
    this.error = null;
    this.render();
  }

  retry() {
    window.location.reload();
  }

  handleInput(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;

    if (target.name === 'identifier') this.identifier = target.value;
    if (target.name === 'password') this.password = target.value;
    if (target.name === 'long_session') this.longSession = target.checked;
    this.syncSubmit();
  }

  handleChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (target?.name === 'long_session') this.longSession = target.checked;
  }

  private syncSubmit() {
    const form = this.root.querySelector<HTMLFormElement>('form[data-form]');
    if (!form) return;

    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submit) return;

    if (form.dataset.form === 'identifier') {
      submit.disabled = this.pending || !this.identifier.trim();
    }
    if (form.dataset.form === 'password') {
      submit.disabled = this.pending || !this.password;
    }
  }

  private fail(error: unknown) {
    console.error(error);
    this.error = errorMessage(error);
    this.step = 'unavailable';
    this.render();
  }

  private showFatal() {
    this.root.innerHTML = `
      <main class="auth-page boot-page">
        <section class="auth-card boot-card">
          <h1>Sign-in unavailable</h1>
          <p class="auth-note">The sign-in interface could not be loaded. Try again in a moment.</p>
          <button class="boot-retry" type="button" data-action="retry">Try again</button>
        </section>
      </main>
    `;
    document.documentElement.dataset.templateReady = '';
  }

  private focusField() {
    const input = this.root.querySelector<HTMLInputElement>('input#identifier, input#password');
    input?.focus();
  }

  private viewData() {
    const realmName =
      this.consentRequest?.realm?.display_name ||
      this.realm?.display_name ||
      (this.discovery?.realm ? titleCase(this.discovery.realm) : 'Auth');
    const clientName =
      this.consentRequest?.client.name ||
      this.discovery?.display_name ||
      this.discovery?.client_name ||
      'this app';
    const user = this.consentRequest?.user || null;
    const userName = user?.display_name || user?.username || 'Signed in';
    const userMeta =
      user?.display_name && user.display_name !== user.username
        ? user.username
        : 'Signed in';
    const scopes = (this.consentRequest?.scopes || []).map((scope) => ({
      description: scopeDescription(scope, realmName),
    }));

    return {
      realmLabel: `${realmName} account`,
      realmName,
      clientName,
      identifier: this.identifier,
      identifierNote: `Continue to ${clientName}.`,
      password: this.password,
      longSession: this.longSession,
      allowLongSession: this.discovery?.allow_session_duration_choice !== false,
      reauth: this.reauth,
      pending: this.pending,
      error: this.error,
      invalid: this.step === 'password' && Boolean(this.error),
      backToAccounts: !this.reauth && this.accounts.length >= 2,
      nextDisabled: this.pending || !this.identifier.trim(),
      nextLabel: this.pending ? 'Checking' : 'Next',
      passwordDisabled: this.pending || !this.password,
      passwordLabel: this.pending ? 'Signing in' : 'Sign in',
      accounts: this.accounts.map((account) => ({
        publicId: account.public_id,
        name: account.user.display_name || account.user.username,
        username:
          account.user.display_name && account.user.display_name !== account.user.username
            ? account.user.username
            : '',
      })),
      providerName: this.provider?.display_name || '',
      userName,
      userMeta,
      scopes,
      consentLabel: this.pending ? 'Working' : 'Allow access',
      signedInName: this.signedIn?.display_name || this.signedIn?.username || 'your account',
      message: this.error || 'The sign-in service could not be reached. Try again in a moment.',
    };
  }

  private render() {
    try {
      this.runtime.render(`login/${this.step}`, this.viewData());
      this.focusField();
    } catch (error) {
      console.error(error);
      this.showFatal();
    }
  }
}

const root = document.querySelector<HTMLElement>('#app');
if (root) {
  const runtime = new TemplateRuntime({
    root,
    manifestUrl: '/app/templates/manifest.json',
    scope: 'login',
  });
  const login = new LoginApp(root, runtime);

  bindActions(
    root,
    {
      'select-account': (element) => {
        void login.selectAccount(element.dataset.account || '');
      },
      'different-account': () => login.differentAccount(),
      'back-to-accounts': () => login.backToAccounts(),
      back: () => login.back(),
      'different-consent-account': () => {
        void login.differentConsentAccount();
      },
      'deny-consent': () => {
        void login.decideConsent('deny');
      },
      'allow-consent': () => {
        void login.decideConsent('allow');
      },
      retry: () => login.retry(),
    },
    {
      identifier: (_form, data) => {
        void login.submitIdentifier(data);
      },
      password: (_form, data) => {
        void login.submitPassword(data);
      },
    },
    () => {}
  );

  root.addEventListener('input', (event) => login.handleInput(event));
  root.addEventListener('change', (event) => login.handleChange(event));
  void login.start();
}
