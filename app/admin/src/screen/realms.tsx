import { LibraryBig } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import {
  brandingFromInput,
  brandingValidationErrorField,
  logoUrlError,
  normalizePreviewColor,
  validateBrandingFields,
} from '@util/branding';
import { Breadcrumb } from '../component/breadcrumb';
import {
  createAdminRealm,
  deleteAdminRealm,
} from '../util/auth';
import {
  appUrl,
  type AdminRealm,
} from '../util/api';

interface RealmsAttrs {
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  canCreateRealm: boolean;
  onAuthExpired: () => void;
  onRealmsChanged: () => Promise<void>;
}

interface RealmCreateValue {
  display_name: string;
  slug: string;
  logo_url: string;
  primary_color: string;
}

type RealmCreateField = 'display_name' | 'slug' | 'logo_url' | 'primary_color';

interface RealmCreateValidation {
  message: string;
  field: RealmCreateField;
}

const RESERVED_SLUGS = new Set(['admin', 'account', 'global']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function defaultCreateValue(): RealmCreateValue {
  return {
    display_name: '',
    slug: '',
    logo_url: '',
    primary_color: '',
  };
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function pluralCount(count: number, label: string) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function realmCounts(realm: AdminRealm) {
  return [
    pluralCount(realm.member_count, 'member'),
    pluralCount(realm.host_count, 'host'),
    pluralCount(realm.email_domain_count, 'domain'),
    pluralCount(realm.client_count, 'client'),
  ];
}

function ownerName(realm: AdminRealm) {
  return realm.owner?.display_name || realm.owner?.username || 'Unassigned';
}

function ownerMeta(realm: AdminRealm) {
  return realm.owner?.email || realm.owner?.username || 'No owner assigned';
}

function matchesSearch(realm: AdminRealm, term: string) {
  if (!term) return true;
  return [
    realm.display_name,
    realm.slug,
    ownerName(realm),
    ownerMeta(realm),
    ...realmCounts(realm),
  ]
    .join(' ')
    .toLowerCase()
    .includes(term);
}

function validateCreate(
  value: RealmCreateValue,
  existingSlugs: Set<string>
): RealmCreateValidation | null {
  const displayName = value.display_name.trim();
  const slug = value.slug.trim().toLowerCase();

  if (!displayName) {
    return { message: 'Display name is required.', field: 'display_name' };
  }
  if (/[\r\n]/.test(value.display_name)) {
    return { message: 'Display name must be a single line.', field: 'display_name' };
  }
  if (displayName.length > 100) {
    return { message: 'Display name must be 100 characters or fewer.', field: 'display_name' };
  }
  if (!slug) {
    return { message: 'Realm ID is required.', field: 'slug' };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      message: 'Realm ID must use lowercase letters, numbers and hyphens.',
      field: 'slug',
    };
  }
  if (slug.length > 63) {
    return { message: 'Realm ID must be 63 characters or fewer.', field: 'slug' };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { message: `Realm ID ${slug} is reserved.`, field: 'slug' };
  }
  if (existingSlugs.has(slug)) {
    return { message: 'Realm ID already exists.', field: 'slug' };
  }

  return validateBrandingFields(value);
}

function createFieldFromError(message: string | null | undefined): RealmCreateField | null {
  if (!message) return null;
  if (/realm slug|realm id/i.test(message)) return 'slug';
  if (/display_name|display name/i.test(message)) return 'display_name';
  return brandingValidationErrorField(message);
}

export const RealmsPage: m.Component<RealmsAttrs> = {
  attrs: null as RealmsAttrs | null,
  search: '',
  notice: null as string | null,
  createOpen: false,
  createValue: defaultCreateValue(),
  createError: null as Error | string | null,
  createInvalidField: null as RealmCreateField | null,
  slugTouched: false,
  creating: false,
  deleteTarget: null as AdminRealm | null,
  deleteConfirm: '',
  deleteError: null as Error | null,
  deleting: false,

  oninit(this: any, vnode: m.Vnode<RealmsAttrs>) {
    this.attrs = vnode.attrs;
  },

  onupdate(this: any, vnode: m.Vnode<RealmsAttrs>) {
    this.attrs = vnode.attrs;
  },

  resetCreate(this: any) {
    this.createOpen = false;
    this.createValue = defaultCreateValue();
    this.createError = null;
    this.createInvalidField = null;
    this.slugTouched = false;
    this.creating = false;
  },

  resetDelete(this: any) {
    this.deleteTarget = null;
    this.deleteConfirm = '';
    this.deleteError = null;
    this.deleting = false;
  },

  existingSlugs(this: any) {
    return new Set((this.attrs?.realms || []).map((realm: AdminRealm) => realm.slug));
  },

  openCreate(this: any) {
    this.resetCreate();
    this.createOpen = true;
    m.redraw();
  },

  openDelete(this: any, realm: AdminRealm) {
    this.resetDelete();
    this.deleteTarget = realm;
    m.redraw();
  },

  async submitCreate(this: any) {
    const validationError = validateCreate(this.createValue, this.existingSlugs());
    if (validationError) {
      this.createError = validationError.message;
      this.createInvalidField = validationError.field;
      m.redraw();
      return;
    }

    this.creating = true;
    this.createError = null;
    this.createInvalidField = null;
    m.redraw();

    try {
      const response = await createAdminRealm({
        slug: this.createValue.slug.trim().toLowerCase(),
        display_name: this.createValue.display_name.trim(),
        ...brandingFromInput(this.createValue),
      });
      await this.attrs.onRealmsChanged();
      this.notice = `Realm ${response.realm.display_name} created.`;
      this.resetCreate();
    } catch (e: any) {
      if (e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request')) {
        this.attrs.onAuthExpired();
        return;
      }
      this.createError = e as Error;
      this.createInvalidField =
        e?.code === 'realm_slug_exists' ? 'slug' : createFieldFromError(e?.message);
    } finally {
      this.creating = false;
      m.redraw();
    }
  },

  async submitDelete(this: any) {
    const realm = this.deleteTarget;
    if (!realm || this.deleteConfirm.trim() !== realm.slug || this.deleting) return;

    this.deleting = true;
    this.deleteError = null;
    m.redraw();

    try {
      await deleteAdminRealm(realm.slug);
      await this.attrs.onRealmsChanged();
      this.notice = `Realm ${realm.display_name} deleted.`;
      this.resetDelete();
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
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
    const { realms, realmsError, canCreateRealm } = this.attrs;
    const term = this.search.trim().toLowerCase();
    const visibleRealms = (realms || []).filter((realm: AdminRealm) =>
      matchesSearch(realm, term)
    );
    const settingsPath = (realm: AdminRealm) =>
      `/settings/${encodeURIComponent(realm.slug)}`;
    const hostsPath = (realm: AdminRealm) => `/hosts/${encodeURIComponent(realm.slug)}`;
    const previewLogo = logoUrlError(this.createValue.logo_url)
      ? ''
      : this.createValue.logo_url.trim();
    const previewColor = normalizePreviewColor(this.createValue.primary_color);
    const deleteSlug = this.deleteTarget?.slug || '';
    const deleteConfirmationMatches =
      Boolean(this.deleteTarget) && this.deleteConfirm.trim() === deleteSlug;

    return (
      <div>
        <Breadcrumb items={[{ label: 'Realms' }]} />
        <PageHeader title="Realms" subtitle="Realm registry and administrative access." />

        {realmsError ? (
          <div class="alert" role="alert">
            <p>{realmsError.message}</p>
            <button
              class="button-secondary"
              type="button"
              onclick={() => this.attrs.onRealmsChanged()}
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
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <section class="table-panel realm-table-panel">
            <h2 class="sr-only">Realm registry</h2>
            <div class="table-toolbar">
              <div class="table-search">
                <input
                  type="search"
                  value={this.search}
                  aria-label="Search realms"
                  placeholder="Search realms"
                  oninput={(event: Event) => {
                    this.search = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="table-actions">
                {canCreateRealm ? (
                  <button class="button" type="button" onclick={() => this.openCreate()}>
                    Register realm
                  </button>
                ) : null}
              </div>
            </div>

            <div class="data-table-wrap">
              <table class="data-table realm-table">
                <thead>
                  <tr>
                    <th class="table-icon-column" scope="col">
                      <span class="sr-only">Realm</span>
                    </th>
                    <th class="data-table-primary realm-name-column" scope="col">Realm</th>
                    <th class="realm-owner-column" scope="col">Owner</th>
                    <th class="realm-action-column" scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRealms.map((realm: AdminRealm) => {
                    const href = settingsPath(realm);
                    return (
                      <tr
                        tabindex="0"
                        onclick={() => m.route.set(href)}
                        onkeydown={(event: KeyboardEvent) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          m.route.set(href);
                        }}
                      >
                        <td class="table-icon-column">
                          <span class="table-icon" aria-hidden="true">
                            {Icon(LibraryBig)}
                          </span>
                        </td>
                        <td class="data-table-primary realm-name-column">
                          <a
                            class="realm-display"
                            href={appUrl(href)}
                            onclick={(event: MouseEvent) => {
                              event.preventDefault();
                              event.stopPropagation();
                              m.route.set(href);
                            }}
                          >
                            {realm.display_name}
                          </a>
                          <span class="realm-meta">
                            <span class="realm-slug">{realm.slug}</span>
                            <span class="realm-count">{pluralCount(realm.member_count, 'member')}</span>
                            {realm.can_edit ? (
                              <a
                                class="realm-count realm-count-link"
                                href={appUrl(hostsPath(realm))}
                                onclick={(event: MouseEvent) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  m.route.set(hostsPath(realm));
                                }}
                              >
                                {pluralCount(realm.host_count, 'host')}
                              </a>
                            ) : (
                              <span class="realm-count">{pluralCount(realm.host_count, 'host')}</span>
                            )}
                            <span class="realm-count">
                              {pluralCount(realm.email_domain_count, 'domain')}
                            </span>
                            <span class="realm-count">{pluralCount(realm.client_count, 'client')}</span>
                          </span>
                        </td>
                        <td class="realm-owner-column" data-label="Owner">
                          <span class="realm-owner-name">{ownerName(realm)}</span>
                          <span class="realm-owner-meta">{ownerMeta(realm)}</span>
                        </td>
                          <td class="realm-action-column">
                            {realm.can_delete ? (
                              <div class="realm-row-action">
                                <button
                                  class="action-button is-danger"
                                  type="button"
                                  onclick={(event: MouseEvent) => {
                                    event.stopPropagation();
                                    this.openDelete(realm);
                                  }}
                                >
                                  Delete realm
                                </button>
                              </div>
                            ) : null}
                          </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {realms.length > 0 && visibleRealms.length === 0 ? (
                <div class="empty">
                  <p>No realms match this search.</p>
                </div>
              ) : realms.length === 0 ? (
                <div class="empty">
                  <p>No realms are available for this account.</p>
                </div>
              ) : null}
            </div>
          </section>
        )}

        {this.createOpen ? (
          <Modal title="Register a realm" onClose={() => this.resetCreate()}>
            <form
              class="realm-create-form"
              onsubmit={(event: Event) => {
                event.preventDefault();
                this.submitCreate();
              }}
            >
              {this.createError ? (
                <div class="alert" role="alert">
                  {typeof this.createError === 'string'
                    ? this.createError
                    : this.createError.message}
                </div>
              ) : null}

              <div class="form-field">
                <span class="field-label">Display name</span>
                <input
                  class="field-control"
                  value={this.createValue.display_name}
                  maxlength="100"
                  placeholder="Acme Inc"
                  data-modal-autofocus
                  disabled={this.creating}
                  aria-invalid={this.createInvalidField === 'display_name' ? 'true' : null}
                  oninput={(event: Event) => {
                    const value = (event.target as HTMLInputElement).value;
                    this.createValue.display_name = value;
                    if (!this.slugTouched) {
                      this.createValue.slug = slugify(value);
                    }
                    this.createError = null;
                    this.createInvalidField = null;
                  }}
                />
              </div>

              <div class="form-field">
                <span class="field-label">Realm ID</span>
                <input
                  class="field-control"
                  value={this.createValue.slug}
                  maxlength="63"
                  placeholder="acme"
                  spellcheck="false"
                  disabled={this.creating}
                  aria-invalid={this.createInvalidField === 'slug' ? 'true' : null}
                  oninput={(event: Event) => {
                    this.createValue.slug = (event.target as HTMLInputElement).value;
                    this.slugTouched = true;
                    this.createError = null;
                    this.createInvalidField = null;
                  }}
                />
              </div>
              <p class="modal-note">
                Lowercase letters, numbers and hyphens. admin, account and global are reserved.
              </p>

              <div class="field-grid">
                <div class="form-field">
                  <span class="field-label">Logo URL</span>
                  <input
                    class="field-control"
                    type="url"
                    value={this.createValue.logo_url}
                    placeholder="https://app.example.test/logo.svg"
                    maxlength="2048"
                    disabled={this.creating}
                    aria-invalid={this.createInvalidField === 'logo_url' ? 'true' : null}
                    oninput={(event: Event) => {
                      this.createValue.logo_url = (event.target as HTMLInputElement).value;
                      this.createError = null;
                      this.createInvalidField = null;
                    }}
                  />
                </div>

                <div class="form-field">
                  <span class="field-label">Primary color</span>
                  <input
                    class="field-control"
                    value={this.createValue.primary_color}
                    placeholder="#25a"
                    maxlength="7"
                    spellcheck="false"
                    disabled={this.creating}
                    aria-invalid={this.createInvalidField === 'primary_color' ? 'true' : null}
                    oninput={(event: Event) => {
                      this.createValue.primary_color = (event.target as HTMLInputElement).value;
                      this.createError = null;
                      this.createInvalidField = null;
                    }}
                  />
                </div>
              </div>

              <div class="branding-preview" aria-hidden="true">
                <span class={`branding-logo-preview${previewLogo ? '' : ' is-empty'}`}>
                  {previewLogo ? (
                    <img
                      src={previewLogo}
                      alt=""
                      onerror={(event: Event) => {
                        (event.target as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                  ) : null}
                </span>
                <span
                  class={`branding-color-preview${previewColor ? '' : ' is-empty'}`}
                  style={previewColor ? { background: previewColor } : {}}
                ></span>
              </div>

              <div class="modal-actions">
                <button
                  class="button-secondary"
                  type="button"
                  disabled={this.creating}
                  onclick={() => this.resetCreate()}
                >
                  Cancel
                </button>
                <button class="button" type="submit" disabled={this.creating}>
                  {this.creating ? 'Creating' : 'Create realm'}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}

        {this.deleteTarget ? (
          <Modal title="Delete realm" onClose={() => this.resetDelete()}>
            <p class="modal-note">
              Delete {this.deleteTarget.display_name} ({deleteSlug})? Realm settings, clients,
              hosts, email domains, sessions, consents, refresh tokens and memberships will be
              permanently removed. Users remain global accounts; home-realm users return to no
              home realm.
            </p>
            {this.deleteError ? (
              <div class="alert" role="alert">
                {this.deleteError.message}
              </div>
            ) : null}

            <div class="form-field">
              <span class="field-label">Confirm realm ID</span>
              <input
                class="field-control"
                value={this.deleteConfirm}
                maxlength="63"
                placeholder={deleteSlug}
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
            <p class="modal-note">Type the realm ID exactly to confirm.</p>

            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.deleting}
                onclick={() => this.resetDelete()}
              >
                Cancel
              </button>
              <button
                class="button-danger"
                type="button"
                disabled={!deleteConfirmationMatches || this.deleting}
                onclick={() => this.submitDelete()}
              >
                {this.deleting ? 'Deleting' : 'Delete realm'}
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    );
  },
};
