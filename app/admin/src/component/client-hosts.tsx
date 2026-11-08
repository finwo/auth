import m from 'mithril';
import { Modal } from '@component/modal';
import {
  createAdminClientHost,
  deleteAdminClientHost,
  loadAdminClientHosts,
} from '../util/auth';
import { type AdminClientHost } from '../util/api';
import { formatDate } from '../util/format';
import { hostFormatError, normalizeHostValue } from '../util/hosts';

interface ClientHostsAttrs {
  realmSlug: string;
  clientId: string;
  clientName: string;
  canEdit: boolean;
  onAuthExpired: () => void;
}

function hostRequestError(e: any): boolean {
  return e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request');
}

function clientKey(realmSlug: string, clientId: string) {
  return `${realmSlug}:${clientId}`;
}

export const ClientHostsPanel: m.Component<ClientHostsAttrs> = {
  attrs: null as ClientHostsAttrs | null,
  loadedKey: null as string | null,
  loading: false,
  hosts: null as AdminClientHost[] | null,
  error: null as Error | null,
  notice: null as string | null,
  search: '',

  addOpen: false,
  addValue: '',
  addError: null as Error | string | null,
  addInvalid: false,
  creating: false,

  removeTarget: null as string | null,
  removeConfirm: '',
  removeError: null as Error | null,
  removing: false,

  oninit(this: any, vnode: m.Vnode<ClientHostsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<ClientHostsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realmSlug, clientId } = this.attrs;
    const key = clientKey(realmSlug, clientId);
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    this.load(realmSlug, clientId);
  },

  async load(this: any, realmSlug: string, clientId: string) {
    const key = clientKey(realmSlug, clientId);
    this.loading = true;
    this.error = null;
    this.notice = null;
    this.hosts = null;
    this.search = '';
    m.redraw();

    try {
      const hosts = await loadAdminClientHosts(realmSlug, clientId);
      if (this.loadedKey !== key) return;
      this.hosts = hosts;
    } catch (e: any) {
      if (this.loadedKey !== key) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedKey === key) this.loading = false;
      m.redraw();
    }
  },

  resetAdd(this: any) {
    this.addOpen = false;
    this.addValue = '';
    this.addError = null;
    this.addInvalid = false;
    this.creating = false;
  },

  openAdd(this: any) {
    this.resetAdd();
    this.addOpen = true;
    m.redraw();
  },

  async submitAdd(this: any) {
    const { realmSlug, clientId } = this.attrs;
    const formatError = hostFormatError(this.addValue);
    if (formatError) {
      this.addError = formatError;
      this.addInvalid = true;
      m.redraw();
      return;
    }

    const host = normalizeHostValue(this.addValue);
    this.creating = true;
    this.addError = null;
    this.addInvalid = false;
    m.redraw();

    try {
      const response = await createAdminClientHost(realmSlug, clientId, host);
      if (this.loadedKey !== clientKey(realmSlug, clientId)) {
        this.resetAdd();
        return;
      }
      this.hosts = [response.host, ...(this.hosts || [])];
      this.notice = `Host ${response.host.host} added.`;
      this.resetAdd();
    } catch (e: any) {
      if (hostRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.addError = (e as Error).message || 'Unable to add host.';
      this.addInvalid = true;
    } finally {
      this.creating = false;
      m.redraw();
    }
  },

  resetRemove(this: any) {
    this.removeTarget = null;
    this.removeConfirm = '';
    this.removeError = null;
    this.removing = false;
  },

  openRemove(this: any, host: string) {
    this.resetRemove();
    this.removeTarget = host;
    m.redraw();
  },

  async submitRemove(this: any) {
    const { realmSlug, clientId } = this.attrs;
    const target = this.removeTarget;
    if (!target || this.removing) return;
    if (normalizeHostValue(this.removeConfirm) !== target) return;

    this.removing = true;
    this.removeError = null;
    m.redraw();

    try {
      const result = await deleteAdminClientHost(realmSlug, clientId, target);
      if (this.loadedKey === clientKey(realmSlug, clientId)) {
        this.hosts = (this.hosts || []).filter((entry) => entry.host !== result.host);
        this.notice = `Host ${result.host} removed.`;
      }
      this.resetRemove();
    } catch (e: any) {
      if (hostRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.removeError = e as Error;
    } finally {
      this.removing = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { clientName, canEdit } = this.attrs;
    const hosts = this.hosts as AdminClientHost[] | null;
    const term = this.search.trim().toLowerCase();
    const visible = hosts ? hosts.filter((entry) => !term || entry.host.includes(term)) : [];

    return (
      <section class="panel" aria-label="Client hosts">
        <h2>Hosts</h2>
        <p class="note">Hostnames that resolve to this client.</p>

        {this.notice ? (
          <div class="notice" role="status">
            {this.notice}
          </div>
        ) : null}

        {this.error ? (
          <div class="alert" role="alert">
            <p>{this.error.message}</p>
            <button
              class="button-secondary"
              type="button"
              onclick={() => this.load(this.attrs.realmSlug, this.attrs.clientId)}
            >
              Try again
            </button>
          </div>
        ) : null}

        {this.loading || !hosts ? (
          <div aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <div>
            <div class="table-toolbar">
              <div class="table-search">
                <input
                  type="search"
                  value={this.search}
                  aria-label="Search hosts"
                  placeholder="Search hosts"
                  oninput={(event: Event) => {
                    this.search = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              {canEdit ? (
                <div class="table-actions">
                  <button class="button" type="button" onclick={() => this.openAdd()}>
                    Add host
                  </button>
                </div>
              ) : null}
            </div>

            <div class="data-table-wrap">
              <table class="data-table data-table-static host-table">
                <thead>
                  <tr>
                    <th class="data-table-primary host-name-column" scope="col">Hostname</th>
                    <th class="host-added-column" scope="col">Added</th>
                    {canEdit ? <th class="host-action-column" scope="col">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry: AdminClientHost) => (
                    <tr>
                      <td class="data-table-primary host-name-column" data-label="Hostname">
                        <span class="host-name">{entry.host}</span>
                      </td>
                      <td class="host-added-column" data-label="Added">
                        <span class="host-added">{formatDate(entry.created_at)}</span>
                      </td>
                      {canEdit ? (
                        <td class="host-action-column" data-label="Actions">
                          <div class="host-row-action">
                            <button
                              class="action-button is-danger"
                              type="button"
                              onclick={() => this.openRemove(entry.host)}
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
              {hosts.length > 0 && visible.length === 0 ? (
                <div class="empty">
                  <p>No hosts match this search.</p>
                </div>
              ) : hosts.length === 0 ? (
                <div class="empty">
                  <p>No hosts are assigned to this client.</p>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {this.addOpen ? (
          <Modal title="Add host" onClose={() => this.resetAdd()}>
            <form
              onsubmit={(event: Event) => {
                event.preventDefault();
                this.submitAdd();
              }}
            >
              {this.addError ? (
                <div class="alert" role="alert">
                  {typeof this.addError === 'string' ? this.addError : this.addError.message}
                </div>
              ) : null}

              <div class="form-field">
                <span class="field-label">Hostname</span>
                <input
                  class="field-control"
                  type="text"
                  value={this.addValue}
                  maxlength="253"
                  placeholder="app.acme.test"
                  autocomplete="off"
                  spellcheck="false"
                  data-modal-autofocus
                  disabled={this.creating}
                  aria-invalid={this.addInvalid ? 'true' : null}
                  oninput={(event: Event) => {
                    this.addValue = (event.target as HTMLInputElement).value;
                    this.addError = null;
                    this.addInvalid = false;
                  }}
                />
              </div>
              <p class="modal-note">
                Lowercase hostname. Do not include a scheme, port, path or wildcard.
              </p>

              <div class="modal-actions">
                <button
                  class="button-secondary"
                  type="button"
                  disabled={this.creating}
                  onclick={() => this.resetAdd()}
                >
                  Cancel
                </button>
                <button class="button" type="submit" disabled={this.creating}>
                  {this.creating ? 'Adding' : 'Add host'}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}

        {this.removeTarget ? (
          <Modal title="Remove host" onClose={() => this.resetRemove()}>
            <p class="modal-note">
              Remove {this.removeTarget}? This hostname will stop resolving to {clientName}.
              Sessions for this client on that host will end. Client settings and users are
              unaffected.
            </p>
            {this.removeError ? (
              <div class="alert" role="alert">
                {this.removeError.message}
              </div>
            ) : null}

            <div class="form-field">
              <span class="field-label">Confirm hostname</span>
              <input
                class="field-control"
                type="text"
                value={this.removeConfirm}
                maxlength="253"
                placeholder={this.removeTarget}
                autocomplete="off"
                spellcheck="false"
                data-modal-autofocus
                disabled={this.removing}
                oninput={(event: Event) => {
                  this.removeConfirm = (event.target as HTMLInputElement).value;
                  this.removeError = null;
                }}
              />
            </div>
            <p class="modal-note">Type the hostname exactly to confirm.</p>

            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.removing}
                onclick={() => this.resetRemove()}
              >
                Cancel
              </button>
              <button
                class="button-danger"
                type="button"
                disabled={
                  this.removing ||
                  normalizeHostValue(this.removeConfirm) !== this.removeTarget
                }
                onclick={() => this.submitRemove()}
              >
                {this.removing ? 'Removing' : 'Remove host'}
              </button>
            </div>
          </Modal>
        ) : null}
      </section>
    );
  },
};
