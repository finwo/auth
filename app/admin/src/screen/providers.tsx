import m from 'mithril';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import { Breadcrumb } from '../component/breadcrumb';
import { RealmSelector } from '../component/realm-selector';
import { realmNavigation } from '../util/navigation';
import {
  deleteAdminRealmProvider,
  loadAdminRealmProviders,
  updateAdminRealmProvider,
} from '../util/auth';
import { appUrl, type AdminIdentityProvider, type AdminRealm } from '../util/api';

interface ProvidersAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  canCreateRealm: boolean;
  onAuthExpired: () => void;
}

function providerRequestError(e: any): boolean {
  return e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request');
}

function matchesSearch(provider: AdminIdentityProvider, term: string) {
  if (!term) return true;
  return `${provider.display_name} ${provider.slug} ${provider.issuer}`.toLowerCase().includes(term);
}

export const ProvidersPage: m.Component<ProvidersAttrs> = {
  attrs: null as ProvidersAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  providers: null as AdminIdentityProvider[] | null,
  error: null as Error | null,
  notice: null as string | null,
  search: '',

  toggleTarget: null as AdminIdentityProvider | null,
  toggleError: null as Error | null,
  toggling: false,

  deleteTarget: null as AdminIdentityProvider | null,
  deleteConfirm: '',
  deleteError: null as Error | null,
  deleting: false,

  oninit(this: any, vnode: m.Vnode<ProvidersAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<ProvidersAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.loadedRealm = null;
      this.providers = null;
      this.loading = false;
      this.error = null;
      if (!this.redirecting) {
        this.redirecting = true;
        m.route.set('/realms', null, { replace: true });
      }
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
    this.showSavedNotice(realmSlug!);
    if (this.loadedRealm !== realmSlug) {
      this.load(realmSlug!);
    }
  },

  showSavedNotice(this: any, realmSlug: string) {
    const saved = m.route.param('saved');
    if (typeof saved !== 'string' || !saved) return;
    this.notice = `Provider ${saved} saved.`;
    m.route.set(`/providers/${encodeURIComponent(realmSlug)}`, null, { replace: true });
  },

  async load(this: any, realmSlug: string) {
    this.loadedRealm = realmSlug;
    this.loading = true;
    this.error = null;
    this.search = '';
    this.providers = null;
    m.redraw();

    try {
      const providers = await loadAdminRealmProviders(realmSlug);
      if (this.loadedRealm !== realmSlug) return;
      this.providers = providers;
    } catch (e: any) {
      if (this.loadedRealm !== realmSlug) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedRealm === realmSlug) this.loading = false;
      m.redraw();
    }
  },

  resetToggle(this: any) {
    this.toggleTarget = null;
    this.toggleError = null;
    this.toggling = false;
  },

  async applyToggle(this: any, provider: AdminIdentityProvider, enabled: boolean) {
    const { realmSlug } = this.attrs;
    if (!realmSlug) return;

    this.toggling = true;
    if (this.toggleTarget) this.toggleError = null;
    m.redraw();

    try {
      const response = await updateAdminRealmProvider(realmSlug, provider.slug, { enabled });
      if (this.loadedRealm === realmSlug) {
        this.providers = (this.providers || []).map((entry) =>
          entry.slug === response.provider.slug ? response.provider : entry
        );
        this.notice = `Provider ${response.provider.display_name} ${enabled ? 'enabled' : 'disabled'}.`;
      }
      this.resetToggle();
    } catch (e: any) {
      this.toggling = false;
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      if (this.toggleTarget) {
        this.toggleError = e as Error;
        m.redraw();
        return;
      }
      this.error = e as Error;
      m.redraw();
    }
  },

  openToggle(this: any, provider: AdminIdentityProvider) {
    if (provider.enabled && provider.domains.length > 0) {
      this.resetToggle();
      this.toggleTarget = provider;
      m.redraw();
      return;
    }
    this.applyToggle(provider, !provider.enabled);
  },

  resetDelete(this: any) {
    this.deleteTarget = null;
    this.deleteConfirm = '';
    this.deleteError = null;
    this.deleting = false;
  },

  openDelete(this: any, provider: AdminIdentityProvider) {
    this.resetDelete();
    this.deleteTarget = provider;
    m.redraw();
  },

  async submitDelete(this: any) {
    const { realmSlug } = this.attrs;
    const target = this.deleteTarget;
    if (!realmSlug || !target || this.deleting) return;
    if (this.deleteConfirm.trim().toLowerCase() !== target.slug) return;

    this.deleting = true;
    this.deleteError = null;
    m.redraw();

    try {
      const result = await deleteAdminRealmProvider(realmSlug, target.slug);
      if (this.loadedRealm === realmSlug) {
        this.providers = (this.providers || []).filter((entry) => entry.slug !== result.slug);
        this.notice = `Provider ${result.slug} deleted.`;
      }
      this.resetDelete();
    } catch (e: any) {
      if (providerRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.deleteError = e as Error;
    } finally {
      this.deleting = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError, realmSlug, canCreateRealm } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === realmSlug) || realms?.[0] || null;
    const canManage = Boolean(selected?.can_edit);
    const nav = realmNavigation(realms, Boolean(canCreateRealm));
    const breadcrumbRealm = selected?.display_name || selected?.slug || realmSlug || '';
    const settingsHref = `/settings/${encodeURIComponent(selected?.slug || realmSlug || '')}`;

    const breadcrumbItems = [
      {
        label: nav.label,
        ...(nav.isPlural ? { path: '/realms' } : {}),
      },
      { label: breadcrumbRealm, path: settingsHref },
      { label: 'Identity providers' },
    ];

    const providers = this.providers as AdminIdentityProvider[] | null;
    const term = this.search.trim().toLowerCase();
    const visible = providers ? providers.filter((entry) => matchesSearch(entry, term)) : [];

    const toggleDomains = this.toggleTarget
      ? this.toggleTarget.domains.map((entry) => entry.domain).join(', ')
      : '';
    const deleteDomains = this.deleteTarget
      ? this.deleteTarget.domains.map((entry) => entry.domain).join(', ')
      : '';

    return (
      <div>
        <Breadcrumb items={breadcrumbItems} />
        <PageHeader
          row
          title="Identity providers"
          subtitle="External sign-in providers that accounts in this realm can use."
        >
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              this.notice = null;
              m.route.set(`/providers/${encodeURIComponent(slug)}`);
            }}
          />
        </PageHeader>

        {realmsError ? (
          <div class="alert" role="alert">
            {realmsError.message}
          </div>
        ) : null}

        {this.error ? (
          <div class="alert" role="alert">
            <p>{this.error.message}</p>
            <button
              class="button button-secondary"
              type="button"
              onclick={() => {
                if (realmSlug) {
                  this.load(realmSlug);
                }
              }}
            >
              Try again
            </button>
          </div>
        ) : null}

        {this.notice ? (
          <div class="notice" role="status">
            {this.notice}
          </div>
        ) : null}

        {!realms ? (
          <div class="loading">Loading realms</div>
        ) : realms.length === 0 ? (
          <div class="empty">
            <p>No realms are available for this account.</p>
          </div>
        ) : this.loading || this.redirecting || !providers ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <section class="card" aria-label="Realm identity providers">
            <div class="toolbar toolbar-panel">
              <div class="toolbar-search">
                <input
                  type="search"
                  value={this.search}
                  aria-label="Search providers"
                  placeholder="Search providers"
                  oninput={(event: Event) => {
                    this.search = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              {canManage ? (
                <div class="toolbar-actions">
                  <button
                    class="button button-primary"
                    type="button"
                    onclick={() => {
                      m.route.set(`/providers/${encodeURIComponent(realmSlug || '')}/new`);
                    }}
                  >
                    Add provider
                  </button>
                </div>
              ) : null}
            </div>

            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Issuer</th>
                  <th scope="col">Status</th>
                  <th scope="col">Domains</th>
                  {canManage ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((entry: AdminIdentityProvider) => (
                  <tr>
                    <td data-label="Provider">{entry.display_name}</td>
                    <td data-label="Issuer">
                      <span class="table-mono">{entry.issuer}</span>
                    </td>
                    <td data-label="Status" class="u-nowrap">
                      <span class="status">
                        <span class="status-dot" aria-hidden="true"></span>
                        {entry.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td data-label="Domains">{entry.domains.length}</td>
                    {canManage ? (
                      <td data-label="Actions" class="u-nowrap">
                        <a
                          class="button-inline"
                          href={appUrl(
                            `/providers/${encodeURIComponent(realmSlug || '')}/edit/${encodeURIComponent(entry.slug)}`
                          )}
                          onclick={(event: MouseEvent) => {
                            event.preventDefault();
                            m.route.set(
                              `/providers/${encodeURIComponent(realmSlug || '')}/edit/${encodeURIComponent(entry.slug)}`
                            );
                          }}
                        >
                          Edit
                        </a>
                        <button
                          class="button-inline"
                          type="button"
                          disabled={this.toggling}
                          onclick={() => this.openToggle(entry)}
                        >
                          {entry.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          class="button-inline button-danger"
                          type="button"
                          onclick={() => this.openDelete(entry)}
                        >
                          Delete
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {providers.length > 0 && visible.length === 0 ? (
              <div class="empty">
                <p>No providers match this search.</p>
              </div>
            ) : providers.length === 0 ? (
              <div class="empty">
                <p>No identity providers are configured for this realm.</p>
              </div>
            ) : null}
          </section>
        )}

        {this.toggleTarget ? (
          <Modal title="Disable provider" onClose={() => this.resetToggle()}>
            {this.toggleError ? (
              <div class="alert" role="alert">
                {this.toggleError.message}
              </div>
            ) : null}
            <p class="modal-note">
              While {this.toggleTarget.display_name} is disabled, sign-in for {toggleDomains} falls
              back to password. Existing sessions are not affected.
            </p>
            <div class="modal-actions">
              <button
                class="button button-secondary"
                type="button"
                disabled={this.toggling}
                onclick={() => this.resetToggle()}
              >
                Cancel
              </button>
              <button
                class="button button-primary"
                type="button"
                disabled={this.toggling}
                onclick={() => this.applyToggle(this.toggleTarget, false)}
              >
                {this.toggling ? 'Disabling' : 'Disable provider'}
              </button>
            </div>
          </Modal>
        ) : null}

        {this.deleteTarget ? (
          <Modal title="Delete provider" onClose={() => this.resetDelete()}>
            {this.deleteError ? (
              <div class="alert" role="alert">
                {this.deleteError.message}
              </div>
            ) : null}
            <p class="modal-note">
              Delete {this.deleteTarget.display_name}? This cannot be undone.
              {deleteDomains
                ? ` Connected domains ${deleteDomains} will be unlinked and fall back to password sign-in.`
                : ' No email domains are connected to this provider.'}
            </p>

            <div class="form-field">
              <span class="field-label">Confirm slug</span>
              <input
                class="field-control"
                type="text"
                value={this.deleteConfirm}
                maxlength="64"
                placeholder={this.deleteTarget.slug}
                autocomplete="off"
                spellcheck="false"
                data-modal-autofocus
                disabled={this.deleting}
                oninput={(event: Event) => {
                  this.deleteConfirm = (event.target as HTMLInputElement).value;
                  this.deleteError = null;
                }}
              />
            </div>
            <p class="modal-note">Type the provider slug exactly to confirm.</p>

            <div class="modal-actions">
              <button
                class="button button-secondary"
                type="button"
                disabled={this.deleting}
                onclick={() => this.resetDelete()}
              >
                Cancel
              </button>
              <button
                class="button button-danger"
                type="button"
                disabled={
                  this.deleting ||
                  this.deleteConfirm.trim().toLowerCase() !== this.deleteTarget.slug
                }
                onclick={() => this.submitDelete()}
              >
                {this.deleting ? 'Deleting' : 'Delete provider'}
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    );
  },
};
