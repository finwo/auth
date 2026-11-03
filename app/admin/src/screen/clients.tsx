import { AppWindow } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import {
  brandingValidationErrorField,
  type BrandingField,
} from '@util/branding';
import { RealmSelector } from '../component/realm-selector';
import {
  ClientForm,
  defaultClientForm,
  parseUriLines,
  toClientInput,
  validateClientBranding,
  type ClientFormValue,
} from '../component/client-form';
import {
  createAdminClient,
  loadAdminClients,
  loadAdminRoles,
} from '../util/auth';
import {
  appUrl,
  type AdminClient,
  type AdminClientResponse,
  type AdminRealm,
  type AdminRole,
} from '../util/api';

interface ClientsAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
}

const ACCESS_MODE_LABELS: Record<AdminClient['access_mode'], string> = {
  internal: 'Internal',
  members: 'Members',
  public: 'Public',
};

function matchesSearch(client: AdminClient, term: string) {
  if (!term) return true;
  const haystack = [
    client.name,
    client.client_id,
    ACCESS_MODE_LABELS[client.access_mode],
  ].join(' ').toLowerCase();
  return haystack.includes(term);
}

function clientPath(realmSlug: string, clientId: string) {
  return `/clients/${encodeURIComponent(realmSlug)}/edit/${encodeURIComponent(clientId)}`;
}

export const ClientsPage: m.Component<ClientsAttrs> = {
  attrs: null as ClientsAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  clients: null as AdminClient[] | null,
  roles: [] as AdminRole[],
  search: '',
  error: null as Error | null,
  notice: null as string | null,
  secret: null as { clientId: string; secret: string } | null,
  creating: false,
  createOpen: false,
  createValue: defaultClientForm(),
  createError: null as Error | string | null,
  createInvalidField: null as BrandingField | null,

  oninit(this: any, vnode: m.Vnode<ClientsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<ClientsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.clients = [];
      this.loading = false;
      this.error = null;
      return;
    }

    const selected = realmSlug && realms.some((realm) => realm.slug === realmSlug);
    if (!selected) {
      if (!this.redirecting) {
        this.redirecting = true;
        m.route.set(`/clients/${encodeURIComponent(realms[0].slug)}`, null, {
          replace: true,
        });
      }
      return;
    }

    this.redirecting = false;
    if (this.loadedRealm !== realmSlug) {
      this.search = '';
      this.notice = null;
      this.secret = null;
      this.createOpen = false;
      this.createValue = defaultClientForm();
      this.createError = null;
      this.createInvalidField = null;
      this.load(realmSlug);
    }
  },

  async load(this: any, realmSlug: string) {
    this.loadedRealm = realmSlug;
    this.loading = true;
    this.error = null;
    this.clients = null;
    m.redraw();

    try {
      const [clients, roles] = await Promise.all([
        loadAdminClients(realmSlug),
        loadAdminRoles(realmSlug),
      ]);
      if (this.loadedRealm === realmSlug) {
        this.clients = clients;
        this.roles = roles;
      }
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

  openCreate(this: any) {
    this.createOpen = true;
    this.createValue = defaultClientForm();
    this.createError = null;
    this.createInvalidField = null;
    m.redraw();
  },

  cancelCreate(this: any) {
    this.createOpen = false;
    this.createValue = defaultClientForm();
    this.createError = null;
    this.createInvalidField = null;
    m.redraw();
  },

  async submitCreate(this: any) {
    const { realmSlug } = this.attrs;
    if (!realmSlug) return;

    const value: ClientFormValue = this.createValue;
    const clientId = value.client_id.trim();
    if (!clientId || !value.name.trim() || parseUriLines(value.redirect_uris).length === 0) {
      this.createError = 'Client ID, name, and at least one redirect URI are required.';
      this.createInvalidField = null;
      m.redraw();
      return;
    }

    const brandingError = validateClientBranding(value);
    if (brandingError) {
      this.createError = brandingError.message;
      this.createInvalidField = brandingError.field;
      m.redraw();
      return;
    }

    this.creating = true;
    this.createError = null;
    this.createInvalidField = null;
    this.secret = null;

    try {
      const response: AdminClientResponse = await createAdminClient(realmSlug, {
        client_id: clientId,
        ...toClientInput(value),
      });
      this.notice = `Client ${response.client.name} created.`;
      if (response.client_secret) {
        this.secret = { clientId: response.client.client_id, secret: response.client_secret };
      }
      this.createOpen = false;
      this.createValue = defaultClientForm();
      this.createInvalidField = null;
      await this.load(realmSlug);
    } catch (e: any) {
      if (e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request')) {
        this.attrs.onAuthExpired();
        return;
      }
      this.createError = e as Error;
      this.createInvalidField = brandingValidationErrorField(e?.message);
    } finally {
      this.creating = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === this.attrs.realmSlug) || realms?.[0] || null;
    const term = this.search.trim().toLowerCase();
    const visibleClients = (this.clients || []).filter((client: AdminClient) =>
      matchesSearch(client, term)
    );

    return (
      <div>
        <PageHeader
          row
          title="Clients"
          subtitle="OIDC clients registered in this realm."
        >
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              this.search = '';
              this.notice = null;
              this.secret = null;
              m.route.set(`/clients/${encodeURIComponent(slug)}`);
            }}
          />
        </PageHeader>

        {this.error ? (
          <div class="alert" role="alert">
            <p>{this.error.message}</p>
            {this.attrs.realmSlug ? (
              <button
                class="button-secondary"
                type="button"
                onclick={() => this.load(this.attrs.realmSlug)}
              >
                Try again
              </button>
            ) : null}
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
        ) : (
          <div class="table-panel">
            <div class="table-toolbar">
              <div class="table-search">
                <input
                  type="search"
                  value={this.search}
                  aria-label="Search clients"
                  placeholder="Search clients"
                  oninput={(event: Event) => {
                    this.search = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="table-actions">
                <button
                  class="button"
                  type="button"
                  disabled={!this.attrs.realmSlug}
                  onclick={() => this.openCreate()}
                >
                  New client
                </button>
              </div>
            </div>

            {this.loading || this.redirecting || !this.clients ? (
              <div class="panel" aria-busy="true">
                <div class="skeleton skeleton-title"></div>
                <div class="skeleton"></div>
                <div class="skeleton skeleton-short"></div>
                <div class="skeleton"></div>
                <div class="skeleton skeleton-short"></div>
              </div>
            ) : this.clients.length === 0 ? (
              <div class="empty">
                <p>No OIDC clients are registered in this realm.</p>
              </div>
            ) : (
              <div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th class="table-icon-column" scope="col">
                        <span class="sr-only">Icon</span>
                      </th>
                      <th class="data-table-primary" scope="col">Application</th>
                      <th scope="col">Access</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleClients.map((client: AdminClient) => {
                      const href = clientPath(this.attrs.realmSlug || '', client.client_id);
                      return (
                        <tr
                          tabindex="0"
                          onclick={() => {
                            if (this.attrs.realmSlug) m.route.set(href);
                          }}
                          onkeydown={(event: KeyboardEvent) => {
                            if (
                              event.target !== event.currentTarget ||
                              !this.attrs.realmSlug
                            ) {
                              return;
                            }
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            m.route.set(href);
                          }}
                        >
                          <td class="table-icon-column">
                            <span class="table-icon" aria-hidden="true">
                              {client.logo_url ? (
                                <img src={client.logo_url} alt="" />
                              ) : (
                                Icon(AppWindow)
                              )}
                            </span>
                          </td>
                          <td class="data-table-primary">
                            <a
                              class="client-title"
                              href={appUrl(href)}
                              onclick={(event: MouseEvent) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (this.attrs.realmSlug) m.route.set(href);
                              }}
                            >
                              <strong>{client.name}</strong>
                            </a>
                            <span class="data-table-sub">{client.client_id}</span>
                            {client.enabled ? null : (
                              <span class="data-table-status">Disabled</span>
                            )}
                          </td>
                          <td data-label="Access">{ACCESS_MODE_LABELS[client.access_mode]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {visibleClients.length === 0 ? (
                  <div class="empty">
                    <p>No clients match this search.</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {this.createOpen ? (
          <Modal title="Register a client" onClose={() => this.cancelCreate()}>
            <ClientForm
              value={this.createValue}
              roles={this.roles}
              editing={false}
              submitLabel="Create client"
              pending={this.creating}
              error={this.createError}
              invalidField={this.createInvalidField}
              onclearerror={() => {
                this.createError = null;
                this.createInvalidField = null;
              }}
              onsubmit={() => this.submitCreate()}
              oncancel={() => this.cancelCreate()}
            />
          </Modal>
        ) : null}

        {this.secret ? (
          <Modal
            title="Client secret created"
            onClose={() => {
              this.secret = null;
              m.redraw();
            }}
          >
            <p class="modal-note">
              Copy the secret for {this.secret.clientId} now. It will not be shown again.
            </p>
            <code class="secret-value">{this.secret.secret}</code>
            <div class="modal-actions">
              <button
                class="button"
                type="button"
                onclick={() => {
                  this.secret = null;
                  m.redraw();
                }}
              >
                Done
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    );
  },
};
