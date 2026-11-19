import m from 'mithril';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import { Breadcrumb } from '../component/breadcrumb';
import { RealmSelector } from '../component/realm-selector';
import { realmNavigation } from '../util/navigation';
import {
  createAdminRealmHost,
  deleteAdminRealmHost,
  loadAdminRealmHosts,
} from '../util/auth';
import { type AdminRealm, type AdminRealmHost } from '../util/api';
import { formatDate } from '../util/format';
import { hostFormatError, normalizeHostValue } from '../util/hosts';

interface HostsAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  canCreateRealm: boolean;
  onAuthExpired: () => void;
}

function hostRequestError(e: any): boolean {
  return e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request');
}

export const HostsPage: m.Component<HostsAttrs> = {
  attrs: null as HostsAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  hosts: null as AdminRealmHost[] | null,
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

  oninit(this: any, vnode: m.Vnode<HostsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<HostsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.loadedRealm = null;
      this.hosts = null;
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
        m.route.set(`/hosts/${encodeURIComponent(realms[0].slug)}`, null, { replace: true });
      }
      return;
    }

    this.redirecting = false;
    if (this.loadedRealm !== realmSlug) {
      this.load(realmSlug!);
    }
  },

  async load(this: any, realmSlug: string) {
    this.loadedRealm = realmSlug;
    this.loading = true;
    this.error = null;
    this.notice = null;
    this.hosts = null;
    this.search = '';
    m.redraw();

    try {
      const hosts = await loadAdminRealmHosts(realmSlug);
      if (this.loadedRealm !== realmSlug) return;
      this.hosts = hosts;
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
    const { realmSlug } = this.attrs;
    if (!realmSlug) return;

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
      const response = await createAdminRealmHost(realmSlug, host);
      if (this.loadedRealm !== realmSlug) {
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
    const { realmSlug } = this.attrs;
    const target = this.removeTarget;
    if (!realmSlug || !target || this.removing) return;
    if (normalizeHostValue(this.removeConfirm) !== target) return;

    this.removing = true;
    this.removeError = null;
    m.redraw();

    try {
      const result = await deleteAdminRealmHost(realmSlug, target);
      if (this.loadedRealm === realmSlug) {
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
      { label: 'Hosts' },
    ];

    const hosts = this.hosts as AdminRealmHost[] | null;
    const term = this.search.trim().toLowerCase();
    const visible = hosts ? hosts.filter((entry) => !term || entry.host.includes(term)) : [];

    return (
      <div>
        <Breadcrumb items={breadcrumbItems} />
        <PageHeader row title="Hosts" subtitle="Hostnames that resolve to this realm.">
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              m.route.set(`/hosts/${encodeURIComponent(slug)}`);
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
          <p class="note">Loading realms</p>
        ) : realms.length === 0 ? (
          <div class="empty">
            <p>No realms are available for this account.</p>
          </div>
        ) : this.loading || this.redirecting || !hosts ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <section class="card" aria-label="Realm hosts">
            <div class="toolbar toolbar-panel">
              <div class="toolbar-search">
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
              {canManage ? (
                <div class="toolbar-actions">
                  <button class="button button-primary" type="button" onclick={() => this.openAdd()}>
                    Add host
                  </button>
                </div>
              ) : null}
            </div>

            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Hostname</th>
                  <th scope="col">Added</th>
                  {canManage ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((entry: AdminRealmHost) => (
                  <tr>
                    <td data-label="Hostname">
                      <span class="table-mono">{entry.host}</span>
                    </td>
                    <td data-label="Added" class="table-meta u-nowrap">{formatDate(entry.created_at)}</td>
                    {canManage ? (
                      <td data-label="Actions">
                        <button
                          class="button-inline button-danger"
                          type="button"
                          onclick={() => this.openRemove(entry.host)}
                        >
                          Remove
                        </button>
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
                <p>No hosts are assigned to this realm.</p>
              </div>
            ) : null}
          </section>
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

              <div class="field">
                <span class="field-label">Hostname</span>
                <input
                  class="field-control"
                  type="text"
                  value={this.addValue}
                  maxlength="253"
                  placeholder="login.acme.test"
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
                  class="button button-secondary"
                  type="button"
                  disabled={this.creating}
                  onclick={() => this.resetAdd()}
                >
                  Cancel
                </button>
                <button class="button button-primary" type="submit" disabled={this.creating}>
                  {this.creating ? 'Adding' : 'Add host'}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}

        {this.removeTarget ? (
          <Modal title="Remove host" onClose={() => this.resetRemove()}>
            <p class="modal-note">
              Remove {this.removeTarget}? This hostname will stop resolving to{' '}
              {breadcrumbRealm}. Sessions for this realm on that host will end. Realm settings,
              clients and users are unaffected.
            </p>
            {this.removeError ? (
              <div class="alert" role="alert">
                {this.removeError.message}
              </div>
            ) : null}

            <div class="field">
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
                class="button button-secondary"
                type="button"
                disabled={this.removing}
                onclick={() => this.resetRemove()}
              >
                Cancel
              </button>
              <button
                class="button button-danger"
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
      </div>
    );
  },
};
