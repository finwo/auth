import m from 'mithril';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import { Breadcrumb } from '../component/breadcrumb';
import { RealmSelector } from '../component/realm-selector';
import { realmNavigation } from '../util/navigation';
import {
  createAdminRealmEmailDomain,
  deleteAdminRealmEmailDomain,
  loadAdminRealmEmailDomains,
  verifyAdminRealmEmailDomain,
} from '../util/auth';
import { type AdminRealm, type AdminRealmEmailDomain } from '../util/api';

interface EmailDomainsAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  canCreateRealm: boolean;
  onAuthExpired: () => void;
}

function normalizeDomainValue(raw: string) {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

function domainFormatError(raw: string): string | null {
  const value = raw.trim();
  const domain = normalizeDomainValue(value);

  if (!domain) return 'Email domain is required.';
  if (/\s/.test(value)) return 'Email domain must not contain spaces.';
  if (domain.includes('@')) return 'Enter the domain without the @ symbol.';
  if (domain.includes('://') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return 'Email domain must not include a scheme such as https://.';
  }
  if (domain.includes('/')) return 'Email domain must not include a path.';
  if (domain.includes('*')) return 'Wildcard domains are not supported.';
  if (domain.includes(':')) return 'Email domain must not include a port.';
  if (value.endsWith('.')) return 'Email domain must not end with a dot.';
  if (domain.startsWith('.')) return 'Email domain must not start with a dot.';
  if (domain.length > 253) return 'Email domain must be 253 characters or fewer.';

  const labels = domain.split('.');
  if (labels.length < 2) return 'Enter a complete domain such as acme.test.';
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return 'Domain labels may use lowercase letters, numbers and hyphens.';
    }
    if (label.length > 63) return 'Each domain label must be 63 characters or fewer.';
  }

  return null;
}

function domainRequestError(e: any): boolean {
  return e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request');
}

function statusLabel(status: string) {
  return status === 'verified' ? 'Verified' : 'Pending verification';
}

export const EmailDomainsPage: m.Component<EmailDomainsAttrs> = {
  attrs: null as EmailDomainsAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  domains: null as AdminRealmEmailDomain[] | null,
  error: null as Error | null,
  notice: null as string | null,
  search: '',

  addOpen: false,
  addValue: '',
  addError: null as Error | string | null,
  addInvalid: false,
  creating: false,

  verifyTarget: null as { domain: string; token: string } | null,
  verifyError: null as Error | null,
  verifying: false,
  copied: false,
  copyTimer: 0 as number | ReturnType<typeof setTimeout>,

  removeTarget: null as string | null,
  removeConfirm: '',
  removeError: null as Error | null,
  removing: false,

  oninit(this: any, vnode: m.Vnode<EmailDomainsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<EmailDomainsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.loadedRealm = null;
      this.domains = null;
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
        m.route.set(`/email-domains/${encodeURIComponent(realms[0].slug)}`, null, {
          replace: true,
        });
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
    this.domains = null;
    this.search = '';
    m.redraw();

    try {
      const domains = await loadAdminRealmEmailDomains(realmSlug);
      if (this.loadedRealm !== realmSlug) return;
      this.domains = domains;
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

    const formatError = domainFormatError(this.addValue);
    if (formatError) {
      this.addError = formatError;
      this.addInvalid = true;
      m.redraw();
      return;
    }

    const domain = normalizeDomainValue(this.addValue);
    this.creating = true;
    this.addError = null;
    this.addInvalid = false;
    m.redraw();

    try {
      const response = await createAdminRealmEmailDomain(realmSlug, domain);
      if (this.loadedRealm !== realmSlug) {
        this.resetAdd();
        return;
      }
      this.domains = [response.email_domain, ...(this.domains || [])];
      this.notice = `Email domain ${response.email_domain.domain} added. Add the TXT record to verify this domain.`;
      this.resetAdd();
    } catch (e: any) {
      if (domainRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.addError = (e as Error).message || 'Unable to add email domain.';
      this.addInvalid = true;
    } finally {
      this.creating = false;
      m.redraw();
    }
  },

  resetVerify(this: any) {
    this.verifyTarget = null;
    this.verifyError = null;
    this.verifying = false;
    this.copied = false;
    if (this.copyTimer) {
      clearTimeout(this.copyTimer as ReturnType<typeof setTimeout>);
      this.copyTimer = 0;
    }
  },

  openVerify(this: any, entry: AdminRealmEmailDomain) {
    this.resetVerify();
    this.verifyTarget = { domain: entry.domain, token: entry.verification_token || '' };
    m.redraw();
  },

  flashCopied(this: any) {
    this.copied = true;
    if (this.copyTimer) clearTimeout(this.copyTimer as ReturnType<typeof setTimeout>);
    this.copyTimer = setTimeout(() => {
      this.copied = false;
      m.redraw();
    }, 2000);
    m.redraw();
  },

  copyToken(this: any) {
    const text = this.verifyTarget ? this.verifyTarget.token : '';
    if (!text) return;
    const clipboard =
      typeof navigator !== 'undefined' && navigator.clipboard
        ? navigator.clipboard
        : null;
    if (clipboard && clipboard.writeText) {
      clipboard
        .writeText(text)
        .then(() => this.flashCopied())
        .catch(() => this.fallbackCopy(text));
      return;
    }
    this.fallbackCopy(text);
  },

  fallbackCopy(this: any, text: string) {
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'absolute';
      scratch.style.left = '-9999rem';
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand('copy');
      document.body.removeChild(scratch);
      this.flashCopied();
    } catch {
      /* clipboard unavailable */
    }
  },

  async submitVerify(this: any) {
    const { realmSlug } = this.attrs;
    const target = this.verifyTarget;
    if (!realmSlug || !target || this.verifying) return;

    this.verifying = true;
    this.verifyError = null;
    m.redraw();

    try {
      const response = await verifyAdminRealmEmailDomain(realmSlug, target.domain);
      if (this.loadedRealm === realmSlug) {
        this.domains = (this.domains || []).map((entry) =>
          entry.domain === response.email_domain.domain ? response.email_domain : entry
        );
        this.notice = `Email domain ${response.email_domain.domain} verified.`;
      }
      this.resetVerify();
    } catch (e: any) {
      if (domainRequestError(e)) {
        this.attrs.onAuthExpired();
        return;
      }
      this.verifyError = e as Error;
    } finally {
      this.verifying = false;
      m.redraw();
    }
  },

  resetRemove(this: any) {
    this.removeTarget = null;
    this.removeConfirm = '';
    this.removeError = null;
    this.removing = false;
  },

  openRemove(this: any, domain: string) {
    this.resetRemove();
    this.removeTarget = domain;
    m.redraw();
  },

  async submitRemove(this: any) {
    const { realmSlug } = this.attrs;
    const target = this.removeTarget;
    if (!realmSlug || !target || this.removing) return;
    if (normalizeDomainValue(this.removeConfirm) !== target) return;

    this.removing = true;
    this.removeError = null;
    m.redraw();

    try {
      const result = await deleteAdminRealmEmailDomain(realmSlug, target);
      if (this.loadedRealm === realmSlug) {
        this.domains = (this.domains || []).filter((entry) => entry.domain !== result.domain);
        this.notice = `Email domain ${result.domain} removed.`;
      }
      this.resetRemove();
    } catch (e: any) {
      if (domainRequestError(e)) {
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
      { label: 'Email domains' },
    ];

    const domains = this.domains as AdminRealmEmailDomain[] | null;
    const term = this.search.trim().toLowerCase();
    const visible = domains ? domains.filter((entry) => !term || entry.domain.includes(term)) : [];

    return (
      <div>
        <Breadcrumb items={breadcrumbItems} />
        <PageHeader
          row
          title="Email domains"
          subtitle="Domains used to assign new accounts to this realm."
        >
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              m.route.set(`/email-domains/${encodeURIComponent(slug)}`);
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
        ) : this.loading || this.redirecting || !domains ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <section class="table-panel domain-table-panel" aria-label="Realm email domains">
            <div class="table-toolbar">
              <div class="table-search">
                <input
                  type="search"
                  value={this.search}
                  aria-label="Search email domains"
                  placeholder="Search email domains"
                  oninput={(event: Event) => {
                    this.search = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              {canManage ? (
                <div class="table-actions">
                  <button class="button" type="button" onclick={() => this.openAdd()}>
                    Add email domain
                  </button>
                </div>
              ) : null}
            </div>

            <div class="data-table-wrap">
              <table class="data-table data-table-static domain-table">
                <thead>
                  <tr>
                    <th class="data-table-primary domain-name-column" scope="col">Domain</th>
                    <th class="domain-status-column" scope="col">Status</th>
                    {canManage ? <th class="domain-action-column" scope="col">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry: AdminRealmEmailDomain) => (
                    <tr>
                      <td class="data-table-primary domain-name-column" data-label="Domain">
                        <span class="domain-name">{entry.domain}</span>
                      </td>
                      <td class="domain-status-column" data-label="Status">
                        <span
                          class={
                            entry.status === 'pending'
                              ? 'domain-status is-pending'
                              : 'domain-status'
                          }
                        >
                          <span class="domain-status-dot" aria-hidden="true"></span>
                          {statusLabel(entry.status)}
                        </span>
                      </td>
                      {canManage ? (
                        <td class="domain-action-column" data-label="Actions">
                          <div class="domain-row-action">
                            {entry.status === 'pending' ? (
                              <button
                                class="action-button is-primary"
                                type="button"
                                onclick={() => this.openVerify(entry)}
                              >
                                Verify
                              </button>
                            ) : null}
                            <button
                              class="action-button is-danger"
                              type="button"
                              onclick={() => this.openRemove(entry.domain)}
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
              {domains.length > 0 && visible.length === 0 ? (
                <div class="empty">
                  <p>No email domains match this search.</p>
                </div>
              ) : domains.length === 0 ? (
                <div class="empty">
                  <p>No email domains are assigned to this realm.</p>
                </div>
              ) : null}
            </div>
          </section>
        )}

        {this.addOpen ? (
          <Modal title="Add email domain" onClose={() => this.resetAdd()}>
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
                <span class="field-label">Email domain</span>
                <input
                  class="field-control"
                  type="text"
                  value={this.addValue}
                  maxlength="253"
                  placeholder="acme.test"
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
                Enter the domain without @ or a protocol. New accounts matching this domain are
                assigned to the realm once the domain is verified.
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
                  {this.creating ? 'Adding' : 'Add domain'}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}

        {this.verifyTarget ? (
          <Modal title="Verify email domain" onClose={() => this.resetVerify()}>
            <p class="modal-note">
              Add the TXT record below to prove control of {this.verifyTarget.domain}. Accounts
              using this domain are assigned to the realm automatically once verified.
            </p>
            {this.verifyError ? (
              <div class="alert" role="alert">
                {this.verifyError.message}
              </div>
            ) : null}

            <div class="form-field">
              <span class="field-label">TXT record name</span>
              <input
                class="field-control verify-record-name"
                type="text"
                value={`_auth-domain-challenge.${this.verifyTarget.domain}`}
                readonly
              />
            </div>

            <div class="form-field">
              <span class="field-label">TXT record value</span>
              <input
                class="field-control verify-record-value"
                type="text"
                value={this.verifyTarget.token}
                readonly
              />
              <div class="verify-copy-row">
                <button
                  class="button-secondary"
                  type="button"
                  onclick={() => this.copyToken()}
                >
                  {this.copied ? 'Copied' : 'Copy value'}
                </button>
              </div>
            </div>

            <p class="modal-note">
              Automated DNS checking arrives in a later slice; mark the domain verified once the
              record is in place.
            </p>

            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.verifying}
                onclick={() => this.resetVerify()}
              >
                Close
              </button>
              <button
                class="button"
                type="button"
                disabled={this.verifying}
                onclick={() => this.submitVerify()}
              >
                {this.verifying ? 'Verifying' : 'Mark as verified'}
              </button>
            </div>
          </Modal>
        ) : null}

        {this.removeTarget ? (
          <Modal title="Remove email domain" onClose={() => this.resetRemove()}>
            <p class="modal-note">
              Remove {this.removeTarget}? This domain will stop assigning new accounts to{' '}
              {breadcrumbRealm}. Existing accounts keep their current home realm, and realm
              memberships are unaffected.
            </p>
            {this.removeError ? (
              <div class="alert" role="alert">
                {this.removeError.message}
              </div>
            ) : null}

            <div class="form-field">
              <span class="field-label">Confirm domain</span>
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
            <p class="modal-note">Type the domain exactly to confirm.</p>

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
                  normalizeDomainValue(this.removeConfirm) !== this.removeTarget
                }
                onclick={() => this.submitRemove()}
              >
                {this.removing ? 'Removing' : 'Remove domain'}
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    );
  },
};
