import m from 'mithril';
import { PageHeader } from '@component/page-header';
import { SelectMenu } from '@component/select-menu';
import { Breadcrumb } from '../component/breadcrumb';
import { realmNavigation } from '../util/navigation';
import { formatDate } from '../util/format';
import {
  connectAdminProviderDomain,
  createAdminRealmProvider,
  disconnectAdminProviderDomain,
  loadAdminRealmEmailDomains,
  loadAdminRealmProvider,
  loadAdminRealmProviders,
  updateAdminRealmProvider,
} from '../util/auth';
import {
  appUrl,
  type AdminIdentityProvider,
  type AdminIdentityProviderPatchInput,
  type AdminRealm,
  type AdminRealmEmailDomain,
} from '../util/api';

interface ProviderEditAttrs {
  realmSlug: string | null;
  providerSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  canCreateRealm: boolean;
  onAuthExpired: () => void;
}

const SECRET_HELP_KEEP = 'The current secret is never displayed. Enter a new value to replace it.';
const SECRET_HELP_UNSET = 'This provider has no secret. Entering one switches it to confidential authentication.';
const SECRET_HELP_REMOVED = 'This provider will stop using a client secret after saving.';
const SECRET_PLACEHOLDER_SET = 'Configured. Leave blank to keep the current secret.';
const SECRET_PLACEHOLDER_UNSET = 'No secret configured. Enter one to make this a confidential client.';
const SECRET_PLACEHOLDER_REMOVED = 'The stored secret will be removed on save.';
const SECRET_PLACEHOLDER_CREATE = 'Optional. Leave blank for public or native apps.';
const SECRET_HELP_CREATE = 'Leave blank for public or native apps that do not use a secret.';

function providerKey(realmSlug: string | null, providerSlug: string | null) {
  return `${realmSlug || ''}:${providerSlug || 'new'}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function providerRequestError(e: any): boolean {
  return e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request');
}

export const ProviderEditPage: m.Component<ProviderEditAttrs> = {
  attrs: null as ProviderEditAttrs | null,
  loadedKey: null as string | null,
  loading: false,
  redirecting: false,
  provider: null as AdminIdentityProvider | null,
  providers: [] as AdminIdentityProvider[],
  emailDomains: [] as AdminRealmEmailDomain[],
  error: null as Error | null,
  formError: null as Error | string | null,
  notice: null as string | null,
  pendingNotice: null as string | null,
  saving: false,
  connecting: false,
  disconnecting: null as string | null,
  selectedDomain: '',

  slug: '',
  displayName: '',
  issuer: '',
  clientId: '',
  secret: '',
  scopes: 'openid email profile',
  enabled: true,
  secretCleared: false,
  slugTouched: false,

  oninit(this: any, vnode: m.Vnode<ProviderEditAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<ProviderEditAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug, providerSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.loading = false;
      this.error = null;
      return;
    }

    const selected = realmSlug && realms.some((realm) => realm.slug === realmSlug);
    if (!selected) {
      if (!this.redirecting) {
        this.redirecting = true;
        m.route.set(`/providers/${encodeURIComponent(realms[0].slug)}`, null, {
          replace: true,
        });
      }
      return;
    }

    this.redirecting = false;
    const key = providerKey(realmSlug, providerSlug);
    if (key === this.loadedKey) return;

    const saved = m.route.param('saved');
    if (typeof saved === 'string' && saved) {
      this.pendingNotice = `Provider ${saved} saved.`;
      m.route.set(
        providerSlug
          ? `/providers/${encodeURIComponent(realmSlug!)}/edit/${encodeURIComponent(providerSlug)}`
          : `/providers/${encodeURIComponent(realmSlug!)}`,
        null,
        { replace: true }
      );
    }

    this.loadedKey = key;
    this.provider = null;
    this.error = null;
    this.formError = null;
    this.notice = null;
    this.saving = false;
    this.connecting = false;
    this.disconnecting = null;
    this.selectedDomain = '';
    this.secret = '';
    this.secretCleared = false;
    this.slugTouched = false;

    if (providerSlug) {
      this.loadEdit(realmSlug!, providerSlug);
    } else {
      this.slug = '';
      this.displayName = '';
      this.issuer = '';
      this.clientId = '';
      this.scopes = 'openid email profile';
      this.enabled = true;
      this.loadCreate(realmSlug!);
    }
  },

  applyPendingNotice(this: any) {
    if (this.pendingNotice) {
      this.notice = this.pendingNotice;
      this.pendingNotice = null;
    }
  },

  async loadEdit(this: any, realmSlug: string, providerSlug: string) {
    this.loading = true;
    m.redraw();

    try {
      const [provider, providers, emailDomains] = await Promise.all([
        loadAdminRealmProvider(realmSlug, providerSlug),
        loadAdminRealmProviders(realmSlug),
        loadAdminRealmEmailDomains(realmSlug),
      ]);
      if (this.loadedKey !== providerKey(realmSlug, providerSlug)) return;

      this.provider = provider;
      this.providers = providers;
      this.emailDomains = emailDomains;
      this.slug = provider.slug;
      this.displayName = provider.display_name;
      this.issuer = provider.issuer;
      this.clientId = provider.client_id;
      this.scopes = provider.scopes || '';
      this.enabled = provider.enabled;
    } catch (e: any) {
      if (this.loadedKey !== providerKey(realmSlug, providerSlug)) return;
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedKey === providerKey(realmSlug, providerSlug)) {
        this.loading = false;
        this.applyPendingNotice();
      }
      m.redraw();
    }
  },

  async loadCreate(this: any, realmSlug: string) {
    this.loading = true;
    m.redraw();

    try {
      const providers = await loadAdminRealmProviders(realmSlug);
      if (this.loadedKey !== providerKey(realmSlug, null)) return;
      this.providers = providers;
    } catch (e: any) {
      if (this.loadedKey !== providerKey(realmSlug, null)) return;
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedKey === providerKey(realmSlug, null)) {
        this.loading = false;
        this.applyPendingNotice();
      }
      m.redraw();
    }
  },

  async refreshProviders(this: any) {
    const { realmSlug, providerSlug } = this.attrs;
    if (!realmSlug) return;
    try {
      const providers = await loadAdminRealmProviders(realmSlug);
      if (this.loadedKey !== providerKey(realmSlug, providerSlug)) return;
      this.providers = providers;
      const current = providers.find((entry) => entry.slug === providerSlug);
      if (current) this.provider = current;
    } catch {
      /* domain lists stay stale until the next load */
    }
  },

  connectedDomainNames(this: any) {
    return (this.provider?.domains || []).map((entry) => entry.domain);
  },

  mappedByOther(this: any, domain: string) {
    const currentSlug = this.provider?.slug || '';
    return this.providers.some(
      (entry: AdminIdentityProvider) =>
        entry.slug !== currentSlug && entry.domains.some((mapped) => mapped.domain === domain)
    );
  },

  availableDomains(this: any) {
    if (!this.provider) return [];
    return this.emailDomains
      .filter((entry) => entry.status === 'verified' && !this.mappedByOther(entry.domain))
      .map((entry) => entry.domain);
  },

  async submitConnect(this: any) {
    const { realmSlug, providerSlug } = this.attrs;
    const domain = this.selectedDomain;
    if (!realmSlug || !providerSlug || !domain || this.connecting) return;

    this.connecting = true;
    this.formError = null;
    this.notice = null;
    m.redraw();

    try {
      const result = await connectAdminProviderDomain(realmSlug, providerSlug, domain);
      this.selectedDomain = '';
      await this.refreshProviders();
      this.notice = `Email domain ${result.domain} connected to ${this.displayName}.`;
    } catch (e: any) {
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.formError = e as Error;
    } finally {
      this.connecting = false;
      m.redraw();
    }
  },

  async submitDisconnect(this: any, domain: string) {
    const { realmSlug, providerSlug } = this.attrs;
    if (!realmSlug || !providerSlug || this.disconnecting) return;

    this.disconnecting = domain;
    this.formError = null;
    this.notice = null;
    m.redraw();

    try {
      const result = await disconnectAdminProviderDomain(realmSlug, providerSlug, domain);
      await this.refreshProviders();
      this.notice = `Email domain ${result.domain} disconnected from ${this.displayName}.`;
    } catch (e: any) {
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.formError = e as Error;
    } finally {
      this.disconnecting = null;
      m.redraw();
    }
  },

  validate(this: any, isEdit: boolean): string | null {
    const name = this.displayName.trim();
    const slug = this.slug.trim().toLowerCase();
    const issuer = this.issuer.trim();
    const clientId = this.clientId.trim();

    if (!name) return 'Display name is required.';
    if (!isEdit) {
      if (!slug || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
        return 'Slug must use lowercase letters, numbers and hyphens.';
      }
      if (this.providers.some((entry: AdminIdentityProvider) => entry.slug === slug)) {
        return 'A provider with this slug already exists in the realm.';
      }
    }
    if (!issuer.startsWith('https://')) return 'Issuer must start with https://.';
    if (issuer.endsWith('/')) return 'Issuer must not end with a slash.';
    if (!issuer.slice(8).includes('.')) return 'Issuer must include a complete hostname.';
    if (!clientId || /\s/.test(clientId)) {
      return 'Client id is required and must not contain spaces.';
    }
    return null;
  },

  async submit(this: any) {
    const { realmSlug, providerSlug } = this.attrs;
    if (!realmSlug) return;
    const isEdit = Boolean(providerSlug);

    const validationError = this.validate(isEdit);
    if (validationError) {
      this.formError = validationError;
      this.notice = null;
      m.redraw();
      return;
    }

    this.saving = true;
    this.formError = null;
    this.notice = null;
    m.redraw();

    try {
      if (!isEdit) {
        const scopes = this.scopes.trim();
        const response = await createAdminRealmProvider(realmSlug, {
          slug: this.slug.trim().toLowerCase(),
          display_name: this.displayName.trim(),
          issuer: this.issuer.trim(),
          client_id: this.clientId.trim(),
          ...(this.secret ? { client_secret: this.secret } : {}),
          ...(scopes ? { scopes } : {}),
          enabled: this.enabled,
        });
        m.route.set(
          `/providers/${encodeURIComponent(realmSlug)}/edit/${encodeURIComponent(response.provider.slug)}`,
          { saved: response.provider.slug }
        );
        return;
      }

      const baseline = this.provider as AdminIdentityProvider;
      const patch: AdminIdentityProviderPatchInput = {};
      const displayName = this.displayName.trim();
      const issuer = this.issuer.trim();
      const clientId = this.clientId.trim();
      const scopes = this.scopes.trim();

      if (displayName !== baseline.display_name) patch.display_name = displayName;
      if (issuer !== baseline.issuer) patch.issuer = issuer;
      if (clientId !== baseline.client_id) patch.client_id = clientId;
      if (scopes && scopes !== baseline.scopes) patch.scopes = scopes;
      if (this.enabled !== baseline.enabled) patch.enabled = this.enabled;
      if (this.secret) patch.client_secret = this.secret;
      else if (this.secretCleared) patch.client_secret = null;

      if (Object.keys(patch).length === 0) {
        m.route.set(`/providers/${encodeURIComponent(realmSlug)}`);
        return;
      }

      await updateAdminRealmProvider(realmSlug, providerSlug!, patch);
      m.route.set(`/providers/${encodeURIComponent(realmSlug)}`, { saved: providerSlug });
    } catch (e: any) {
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.formError = e as Error;
    } finally {
      this.saving = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError, realmSlug, providerSlug, canCreateRealm } = this.attrs;
    const isEdit = Boolean(providerSlug);
    const selected = realms?.find((realm) => realm.slug === realmSlug) || realms?.[0] || null;
    const nav = realmNavigation(realms, Boolean(canCreateRealm));
    const breadcrumbRealm = selected?.display_name || selected?.slug || realmSlug || '';
    const realmEncoded = encodeURIComponent(realmSlug || '');
    const listHref = `/providers/${realmEncoded}`;
    const settingsHref = `/settings/${realmEncoded}`;
    const busy = this.loading || this.redirecting || (isEdit && !this.provider);

    const breadcrumbItems = [
      {
        label: nav.label,
        ...(nav.isPlural ? { path: '/realms' } : {}),
      },
      { label: breadcrumbRealm, path: settingsHref },
      { label: 'Identity providers', path: listHref },
      { label: isEdit ? this.displayName || 'Edit provider' : 'Add provider' },
    ];

    const available = this.availableDomains();
    const domainOptions = available.map((domain: string) => ({ value: domain, label: domain }));
    const hasSecret = isEdit ? Boolean(this.provider?.has_secret) : false;
    const secretPlaceholder = !isEdit
      ? SECRET_PLACEHOLDER_CREATE
      : this.secretCleared
        ? SECRET_PLACEHOLDER_REMOVED
        : hasSecret
          ? SECRET_PLACEHOLDER_SET
          : SECRET_PLACEHOLDER_UNSET;
    const secretHelp = !isEdit
      ? SECRET_HELP_CREATE
      : this.secretCleared
        ? SECRET_HELP_REMOVED
        : hasSecret || this.secret
          ? SECRET_HELP_KEEP
          : SECRET_HELP_UNSET;
    const connected = this.connectedDomainNames();
    const showFallbackNote = isEdit && !this.enabled && connected.length > 0;

    return (
      <div>
        <Breadcrumb items={breadcrumbItems} />
        <PageHeader
          title={isEdit ? `Edit ${this.displayName || providerSlug}` : 'Add provider'}
          subtitle={
            isEdit
              ? 'Update provider configuration and the email domains routed to it.'
              : 'Register an external sign-in provider for this realm.'
          }
        />

        {realmsError ? (
          <div class="alert" role="alert">
            {realmsError.message}
          </div>
        ) : null}

        {this.error ? (
          <div class="alert" role="alert">
            <p>{this.error.message}</p>
            <div class="action-row">
              <button
                class="button button-secondary"
                type="button"
                onclick={() => {
                  this.loadedKey = null;
                  this.ensure();
                }}
              >
                Try again
              </button>
              <a
                class="button button-secondary"
                href={appUrl(listHref)}
                onclick={(event: MouseEvent) => {
                  event.preventDefault();
                  m.route.set(listHref);
                }}
              >
                Back to providers
              </a>
            </div>
          </div>
        ) : null}

        {this.notice ? (
          <div class="notice" role="status">
            {this.notice}
          </div>
        ) : null}

        {busy ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <div class="stack">
            <form
              class="stack"
              novalidate
              onsubmit={(event: Event) => {
                event.preventDefault();
                this.submit();
              }}
            >
              <section class="panel" aria-label="Provider">
                <h2>Provider</h2>
                {this.formError ? (
                  <div class="alert" role="alert">
                    {typeof this.formError === 'string' ? this.formError : this.formError.message}
                  </div>
                ) : null}

                <label class="field">
                  <span class="field-label">Slug</span>
                  <input
                    class="field-control u-mono"
                    type="text"
                    value={this.slug}
                    maxlength="63"
                    placeholder="example-sso"
                    autocomplete="off"
                    spellcheck="false"
                    readonly={isEdit}
                    disabled={this.saving}
                    oninput={(event: Event) => {
                      this.slug = (event.target as HTMLInputElement).value;
                      this.slugTouched = true;
                      this.formError = null;
                    }}
                  />
                  <span class="field-hint">
                    {isEdit
                      ? 'The slug cannot be changed after the provider is created.'
                      : 'Lowercase letters, numbers and hyphens. Used in provider URLs and audit logs.'}
                  </span>
                </label>

                <label class="field">
                  <span class="field-label">Display name</span>
                  <input
                    class="field-control"
                    type="text"
                    value={this.displayName}
                    maxlength="120"
                    placeholder="Example SSO"
                    autocomplete="off"
                    disabled={this.saving}
                    oninput={(event: Event) => {
                      this.displayName = (event.target as HTMLInputElement).value;
                      this.formError = null;
                      if (!isEdit && !this.slugTouched) {
                        this.slug = slugify(this.displayName);
                      }
                    }}
                  />
                  <span class="field-hint">
                    Shown to users when this provider is offered at sign-in.
                  </span>
                </label>

                <label class="field">
                  <span class="field-label">Issuer</span>
                  <input
                    class="field-control u-mono"
                    type="text"
                    value={this.issuer}
                    maxlength="253"
                    placeholder="https://idp.example.com"
                    autocomplete="off"
                    spellcheck="false"
                    disabled={this.saving}
                    oninput={(event: Event) => {
                      this.issuer = (event.target as HTMLInputElement).value;
                      this.formError = null;
                    }}
                  />
                  <span class="field-hint">
                    The OIDC issuer URL. Must be https and must not end with a slash.
                  </span>
                </label>

                <label class="field">
                  <span class="field-label">Client id</span>
                  <input
                    class="field-control u-mono"
                    type="text"
                    value={this.clientId}
                    maxlength="255"
                    placeholder="auth-example"
                    autocomplete="off"
                    spellcheck="false"
                    disabled={this.saving}
                    oninput={(event: Event) => {
                      this.clientId = (event.target as HTMLInputElement).value;
                      this.formError = null;
                    }}
                  />
                </label>

                <label class="field">
                  <span class="field-label">Client secret</span>
                  <input
                    class="field-control u-mono"
                    type="password"
                    value={this.secret}
                    maxlength="255"
                    placeholder={secretPlaceholder}
                    autocomplete="new-password"
                    spellcheck="false"
                    disabled={this.saving}
                    oninput={(event: Event) => {
                      this.secret = (event.target as HTMLInputElement).value;
                      if (isEdit && this.secret && this.secretCleared) {
                        this.secretCleared = false;
                      }
                    }}
                  />
                  <span class="field-hint">{secretHelp}</span>
                  {isEdit && hasSecret && !this.secretCleared ? (
                    <span class="u-cluster">
                      <button
                        class="button button-secondary"
                        type="button"
                        disabled={this.saving}
                        onclick={() => {
                          this.secretCleared = true;
                          this.secret = '';
                        }}
                      >
                        Remove secret
                      </button>
                    </span>
                  ) : null}
                </label>

                <label class="field">
                  <span class="field-label">Scopes</span>
                  <input
                    class="field-control u-mono"
                    type="text"
                    value={this.scopes}
                    maxlength="255"
                    autocomplete="off"
                    spellcheck="false"
                    disabled={this.saving}
                    oninput={(event: Event) => {
                      this.scopes = (event.target as HTMLInputElement).value;
                      this.formError = null;
                    }}
                  />
                  <span class="field-hint">
                    Space-separated OIDC scopes requested from the provider.
                  </span>
                </label>

                <div class="action-row">
                  <a
                    class="button button-secondary"
                    href={appUrl(listHref)}
                    onclick={(event: MouseEvent) => {
                      event.preventDefault();
                      m.route.set(listHref);
                    }}
                  >
                    Cancel
                  </a>
                  <button class="button button-primary" type="submit" disabled={this.saving}>
                    {isEdit
                      ? this.saving
                        ? 'Saving'
                        : 'Save changes'
                      : this.saving
                        ? 'Creating'
                        : 'Create provider'}
                  </button>
                </div>
              </section>

              <section class="panel" aria-label="Status">
                <h2>Status</h2>
                <label class="checkbox">
                  <input
                    type="checkbox"
                    checked={this.enabled}
                    disabled={this.saving}
                    onchange={(event: Event) => {
                      this.enabled = (event.target as HTMLInputElement).checked;
                    }}
                  />
                  <span>Enabled</span>
                </label>
                <p class="note">
                  Disabled providers stay configured but new sign-ins use password instead.
                </p>
                {showFallbackNote ? (
                  <p class="note">
                    While this provider is disabled, sign-in for {connected.join(', ')} falls back
                    to password.
                  </p>
                ) : null}
              </section>
            </form>

            {isEdit ? (
              <section class="panel" aria-label="Connected domains">
                <h2>Connected domains</h2>
                <p class="note">Verified email domains that route sign-in through this provider.</p>

                <div class="toolbar toolbar-panel">
                  <div class="field">
                    <span class="field-label" id="provider-domain-select-label">
                      Email domain
                    </span>
                    <SelectMenu
                      labelledBy="provider-domain-select-label"
                      value={this.selectedDomain}
                      options={domainOptions}
                      placeholder="Select a domain"
                      disabled={this.connecting || domainOptions.length === 0}
                      onchange={(value: string) => {
                        this.selectedDomain = value;
                        this.formError = null;
                      }}
                    />
                  </div>
                  <div class="toolbar-actions">
                    <button
                      class="button button-primary"
                      type="button"
                      disabled={this.connecting || available.length === 0}
                      onclick={() => this.submitConnect()}
                    >
                      {this.connecting ? 'Connecting' : 'Connect'}
                    </button>
                  </div>
                </div>

                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">Domain</th>
                      <th scope="col">Added</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(this.provider?.domains || []).map((entry) => (
                      <tr>
                        <td data-label="Domain">
                          <span class="table-mono">{entry.domain}</span>
                        </td>
                        <td data-label="Added" class="table-meta u-nowrap">
                          {formatDate(entry.created_at)}
                        </td>
                        <td data-label="Actions">
                          <button
                            class="button-inline button-danger"
                            type="button"
                            disabled={Boolean(this.disconnecting)}
                            onclick={() => this.submitDisconnect(entry.domain)}
                          >
                            Disconnect
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(this.provider?.domains || []).length === 0 ? (
                  <p class="empty">No email domains are connected to this provider.</p>
                ) : null}
              </section>
            ) : (
              <section class="panel" aria-label="Connected domains">
                <h2>Connected domains</h2>
                <p class="note">Save the provider first to connect verified email domains to it.</p>
              </section>
            )}
          </div>
        )}
      </div>
    );
  },
};
