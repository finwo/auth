import m from 'mithril';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import {
  brandingValidationErrorField,
  type BrandingField,
} from '@util/branding';
import { Breadcrumb } from '../component/breadcrumb';
import { RealmSelector } from '../component/realm-selector';
import {
  ClientForm,
  clientFormValue,
  defaultClientForm,
  toClientInput,
  validateClientBranding,
} from '../component/client-form';
import { ClientHostsPanel } from '../component/client-hosts';
import {
  deleteAdminClient,
  loadAdminClients,
  loadAdminRoles,
  rotateAdminClientSecret,
  updateAdminClient,
} from '../util/auth';
import { appUrl, type AdminClient, type AdminRealm, type AdminRole } from '../util/api';

interface ClientEditAttrs {
  realmSlug: string | null;
  clientId: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
}

function clientKey(realmSlug: string | null, clientId: string | null) {
  return `${realmSlug || ''}:${clientId || ''}`;
}

export const ClientEditPage: m.Component<ClientEditAttrs> = {
  attrs: null as ClientEditAttrs | null,
  loadedKey: null as string | null,
  loading: false,
  redirecting: false,
  clients: null as AdminClient[] | null,
  roles: [] as AdminRole[],
  form: defaultClientForm(),
  error: null as Error | null,
  formError: null as Error | string | null,
  invalidField: null as BrandingField | null,
  notice: null as string | null,
  secret: null as { clientId: string; secret: string } | null,
  pending: false,
  rotateConfirm: false,
  rotating: false,
  deleteOpen: false,
  deleting: false,

  oninit(this: any, vnode: m.Vnode<ClientEditAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<ClientEditAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug, clientId } = this.attrs;
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
        m.route.set(`/clients/${encodeURIComponent(realms[0].slug)}`, null, { replace: true });
      }
      return;
    }

    this.redirecting = false;
    const key = clientKey(realmSlug, clientId);
    if (key === this.loadedKey) return;

    this.loadedKey = key;
    this.form = defaultClientForm();
    this.formError = null;
    this.invalidField = null;
    this.notice = null;
    this.secret = null;
    this.pending = false;
    this.rotateConfirm = false;
    this.rotating = false;
    this.deleteOpen = false;
    this.deleting = false;
    if (realmSlug && clientId) this.load(realmSlug, clientId);
  },

  async load(this: any, realmSlug: string, clientId: string) {
    this.loading = true;
    this.error = null;
    this.formError = null;
    this.invalidField = null;
    this.notice = null;
    this.secret = null;
    m.redraw();

    try {
      const [clients, roles] = await Promise.all([
        loadAdminClients(realmSlug),
        loadAdminRoles(realmSlug),
      ]);
      if (this.loadedKey !== clientKey(realmSlug, clientId)) return;

      this.clients = clients;
      this.roles = roles;
      const client = clients.find((item) => item.client_id === clientId);
      if (client) this.form = clientFormValue(client);
    } catch (e: any) {
      if (this.loadedKey !== clientKey(realmSlug, clientId)) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedKey === clientKey(realmSlug, clientId)) this.loading = false;
      m.redraw();
    }
  },

  async submit(this: any) {
    const { realmSlug, clientId } = this.attrs;
    if (!realmSlug || !clientId) return;

    const brandingError = validateClientBranding(this.form);
    if (brandingError) {
      this.formError = brandingError.message;
      this.invalidField = brandingError.field;
      this.notice = null;
      m.redraw();
      return;
    }

    this.pending = true;
    this.formError = null;
    this.invalidField = null;
    this.notice = null;

    try {
      const response = await updateAdminClient(realmSlug, clientId, toClientInput(this.form));
      this.form = clientFormValue(response.client);
      this.notice = 'Client settings saved.';
      await this.load(realmSlug, clientId);
    } catch (e: any) {
      if (e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request')) {
        this.attrs.onAuthExpired();
        return;
      }
      this.formError = e as Error;
      this.invalidField = brandingValidationErrorField(e?.message);
    } finally {
      this.pending = false;
      m.redraw();
    }
  },

  async rotate(this: any) {
    const { realmSlug, clientId } = this.attrs;
    if (!realmSlug || !clientId) return;

    this.rotating = true;
    this.error = null;
    this.notice = null;
    this.secret = null;

    try {
      const response = await rotateAdminClientSecret(realmSlug, clientId);
      this.secret = { clientId, secret: response.client_secret };
      this.rotateConfirm = false;
      await this.load(realmSlug, clientId);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.rotating = false;
      m.redraw();
    }
  },

  openDelete(this: any) {
    this.deleteOpen = true;
    this.error = null;
    m.redraw();
  },

  cancelDelete(this: any) {
    this.deleteOpen = false;
    m.redraw();
  },

  async deleteClient(this: any) {
    const { realmSlug, clientId } = this.attrs;
    if (!realmSlug || !clientId) return;

    this.deleting = true;
    this.error = null;

    try {
      await deleteAdminClient(realmSlug, clientId);
      m.route.set(`/clients/${encodeURIComponent(realmSlug)}`);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.deleting = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError, clientId } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === this.attrs.realmSlug) || realms?.[0] || null;
    const client = this.clients?.find((item) => item.client_id === clientId) || null;

    return (
      <div>
        <Breadcrumb
          items={[
            { label: 'Clients', path: `/clients/${encodeURIComponent(this.attrs.realmSlug || '')}` },
            { label: clientId || 'Unknown' },
          ]}
        />
        <PageHeader row title="Edit client" subtitle="OIDC client registration.">
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              m.route.set(`/clients/${encodeURIComponent(slug)}`);
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
              class="button-secondary"
              type="button"
              onclick={() => {
                if (this.attrs.realmSlug && clientId) {
                  this.load(this.attrs.realmSlug, clientId);
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

        {this.secret ? (
          <div class="panel secret-panel">
            <div class="secret-header">
              <div>
                <h2>Client secret</h2>
                <p class="note">{this.secret.clientId}</p>
              </div>
              <button
                class="button-secondary"
                type="button"
                onclick={() => {
                  this.secret = null;
                }}
              >
                Done
              </button>
            </div>
            <p class="note">Copy this secret now. The previous secret no longer works.</p>
            <code class="secret-value">{this.secret.secret}</code>
          </div>
        ) : null}

        {!realms ? (
          <div class="loading">Loading realms</div>
        ) : this.loading || this.redirecting ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : client ? (
          <div class="client-stack">
            <section class="panel">
              <h2>Settings</h2>
              <ClientForm
                value={this.form}
                roles={this.roles}
                editing={true}
                submitLabel="Save changes"
                pending={this.pending}
                error={this.formError}
                invalidField={this.invalidField}
                onclearerror={() => {
                  this.formError = null;
                  this.invalidField = null;
                }}
                onsubmit={() => this.submit()}
                oncancel={() => m.route.set(`/clients/${encodeURIComponent(this.attrs.realmSlug || '')}`)}
              />
            </section>

            <section class="panel">
              <h2>Secret</h2>
              <p class="note">
                {client.has_secret
                  ? 'A client secret is configured. Rotating invalidates the previous value.'
                  : 'No client secret is configured. Creating one switches this client to confidential authentication.'}
              </p>
              {this.rotateConfirm ? (
                <div class="client-actions">
                  <button
                    class="button-danger"
                    type="button"
                    disabled={this.rotating}
                    onclick={() => this.rotate()}
                  >
                    {this.rotating ? 'Rotating' : 'Confirm'}
                  </button>
                  <button
                    class="button-secondary"
                    type="button"
                    disabled={this.rotating}
                    onclick={() => {
                      this.rotateConfirm = false;
                      m.redraw();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div class="client-actions">
                  <button
                    class="button"
                    type="button"
                    disabled={this.rotating}
                    onclick={() => {
                      this.rotateConfirm = true;
                      m.redraw();
                    }}
                  >
                    {client.has_secret ? 'Rotate secret' : 'Create secret'}
                  </button>
                </div>
              )}
            </section>

            <ClientHostsPanel
              realmSlug={this.attrs.realmSlug || ''}
              clientId={clientId || ''}
              clientName={client.name}
              canEdit={Boolean(selected?.can_edit)}
              onAuthExpired={this.attrs.onAuthExpired}
            />

            <section class="panel danger-zone">
              <h2>Danger zone</h2>
              <p class="note">
                Deleting removes the client registration and related authorization state.
              </p>
              <div class="client-actions">
                <button
                  class="button-danger"
                  type="button"
                  onclick={() => this.openDelete()}
                >
                  Delete client
                </button>
              </div>
            </section>
          </div>
        ) : (
          <div class="empty">
            <p>This client was not found in the selected realm.</p>
          </div>
        )}

        {this.deleteOpen && client ? (
          <Modal title="Delete client" onClose={() => this.cancelDelete()}>
            <p class="modal-note">
              Delete {client.name} ({client.client_id}) from {this.attrs.realmSlug}?
              This cannot be undone.
            </p>
            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.deleting}
                onclick={() => this.cancelDelete()}
              >
                Cancel
              </button>
              <button
                class="button-danger"
                type="button"
                disabled={this.deleting}
                onclick={() => this.deleteClient()}
              >
                {this.deleting ? 'Deleting' : 'Delete client'}
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    );
  },
};
