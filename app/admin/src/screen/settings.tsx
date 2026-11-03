import m from 'mithril';
import { PageHeader } from '@component/page-header';
import {
  brandingFromInput,
  brandingValidationErrorField,
  logoUrlError,
  normalizePreviewColor,
  validateBrandingFields,
} from '@util/branding';
import { RealmSelector } from '../component/realm-selector';
import { SettingsTargetSelector } from '../component/settings-target-selector';
import { loadAdminRealmSettings, updateAdminRealmSettings } from '../util/auth';
import type { AdminRealm, AdminRealmSettings } from '../util/api';

interface SettingsAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  isSystemAdmin: boolean;
  onAuthExpired: () => void;
  onRealmsChanged: () => Promise<void>;
}

interface SettingsFormValue {
  display_name: string;
  allow_session_duration_choice: boolean;
  logo_url: string;
  primary_color: string;
}

interface SettingsValidation {
  message: string;
  field: 'display_name' | 'logo_url' | 'primary_color';
}

function formFromSettings(settings: AdminRealmSettings): SettingsFormValue {
  return {
    display_name: settings.display_name,
    allow_session_duration_choice: settings.allow_session_duration_choice,
    logo_url: settings.logo_url || '',
    primary_color: settings.primary_color || '',
  };
}

function validateForm(value: SettingsFormValue): SettingsValidation | null {
  const displayName = value.display_name.trim();

  if (!displayName) {
    return { message: 'Display name is required.', field: 'display_name' };
  }
  if (/[\r\n]/.test(value.display_name)) {
    return { message: 'Display name must be a single line.', field: 'display_name' };
  }
  if (displayName.length > 100) {
    return {
      message: 'Display name must be 100 characters or fewer.',
      field: 'display_name',
    };
  }

  const brandingError = validateBrandingFields(value);
  if (brandingError) return brandingError;

  return null;
}

function fieldFromError(message: string | null | undefined): SettingsValidation['field'] | null {
  const brandingField = brandingValidationErrorField(message);
  if (brandingField) return brandingField;
  if (message?.includes('display_name')) return 'display_name';
  return null;
}

export const SettingsPage: m.Component<SettingsAttrs> = {
  attrs: null as SettingsAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  settings: null as AdminRealmSettings | null,
  form: {
    display_name: '',
    allow_session_duration_choice: true,
    logo_url: '',
    primary_color: '',
  } as SettingsFormValue,
  error: null as Error | null,
  formError: null as Error | string | null,
  invalidField: null as SettingsValidation['field'] | null,
  notice: null as string | null,
  pending: false,

  oninit(this: any, vnode: m.Vnode<SettingsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<SettingsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.loadedRealm = null;
      this.settings = null;
      this.loading = false;
      this.error = null;
      return;
    }

    const selected = realmSlug && realms.some((realm) => realm.slug === realmSlug);
    if (!selected) {
      if (!this.redirecting) {
        this.redirecting = true;
        m.route.set(`/settings/${encodeURIComponent(realms[0].slug)}`, null, {
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
    this.formError = null;
    this.notice = null;
    this.settings = null;
    this.invalidField = null;
    this.form = {
      display_name: '',
      allow_session_duration_choice: true,
      logo_url: '',
      primary_color: '',
    };
    m.redraw();

    try {
      const settings = await loadAdminRealmSettings(realmSlug);
      if (this.loadedRealm !== realmSlug) return;

      this.settings = settings;
      this.form = formFromSettings(settings);
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

  async submit(this: any) {
    const { realmSlug } = this.attrs;
    if (!realmSlug) return;

    const validationError = validateForm(this.form);
    if (validationError) {
      this.formError = validationError.message;
      this.invalidField = validationError.field;
      this.notice = null;
      m.redraw();
      return;
    }

    this.pending = true;
    this.formError = null;
    this.invalidField = null;
    this.notice = null;
    m.redraw();

    try {
      const settings = await updateAdminRealmSettings(realmSlug, {
        display_name: this.form.display_name.trim(),
        allow_session_duration_choice: this.form.allow_session_duration_choice,
        ...brandingFromInput(this.form),
      });

      if (this.loadedRealm !== realmSlug) return;

      this.settings = settings;
      this.form = formFromSettings(settings);
      this.notice = 'Realm settings saved.';
      await this.attrs.onRealmsChanged();
    } catch (e: any) {
      if (
        e?.status === 401 ||
        (e?.status === 400 && e?.code !== 'invalid_request')
      ) {
        this.attrs.onAuthExpired();
        return;
      }
      this.formError = e as Error;
      this.invalidField = fieldFromError(e?.message);
    } finally {
      this.pending = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError, realmSlug, isSystemAdmin } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === realmSlug) || realms?.[0] || null;
    const previewLogo = logoUrlError(this.form.logo_url) ? '' : this.form.logo_url.trim();
    const previewColor = normalizePreviewColor(this.form.primary_color);

    return (
      <div>
        <PageHeader row title="Realm settings" subtitle="Realm name, branding, and login behavior.">
          {isSystemAdmin ? (
            <SettingsTargetSelector
              realms={realms}
              selectedSystem={false}
              selectedRealm={selected}
              onchange={(target: string) => {
                if (target === 'system') {
                  m.route.set('/system-settings');
                  return;
                }
                m.route.set(`/settings/${encodeURIComponent(target)}`);
              }}
            />
          ) : (
            <RealmSelector
              realms={realms}
              selected={selected}
              onchange={(slug: string) => {
                m.route.set(`/settings/${encodeURIComponent(slug)}`);
              }}
            />
          )}
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
        ) : this.loading || this.redirecting ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : this.settings ? (
          <div class="settings-stack">
            <section class="panel">
              <h2>Realm details</h2>
              <form class="settings-form" onsubmit={(event: Event) => {
                event.preventDefault();
                this.submit();
              }}>
                {this.formError ? (
                  <div class="alert" role="alert">
                    {typeof this.formError === 'string' ? this.formError : this.formError.message}
                  </div>
                ) : null}

                <div class="form-field">
                  <span class="field-label">Realm ID</span>
                  <input class="field-control" value={this.settings.slug} disabled />
                </div>

                <div class="form-field">
                  <span class="field-label">Display name</span>
                  <input
                    class="field-control"
                    value={this.form.display_name}
                    maxlength="100"
                    disabled={this.pending}
                    aria-invalid={this.invalidField === 'display_name' ? 'true' : null}
                    oninput={(event: Event) => {
                      this.form.display_name = (event.target as HTMLInputElement).value;
                      this.invalidField = null;
                    }}
                  />
                </div>

                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    checked={this.form.allow_session_duration_choice}
                    disabled={this.pending}
                    onchange={(event: Event) => {
                      this.form.allow_session_duration_choice = (
                        event.target as HTMLInputElement
                      ).checked;
                    }}
                  />
                  <span>Show "Keep me signed in" on login</span>
                </label>
              </form>
            </section>

            <section class="panel">
              <h2>Realm branding</h2>
              <p class="note">Shown on login and consent for clients in this realm.</p>
              <div class="settings-form">
                <div class="field-grid">
                  <div class="form-field">
                    <span class="field-label">Logo URL</span>
                    <input
                      class="field-control"
                      type="url"
                      value={this.form.logo_url}
                      placeholder="https://app.example.test/logo.svg"
                      maxlength="2048"
                      disabled={this.pending}
                      aria-invalid={this.invalidField === 'logo_url' ? 'true' : null}
                      oninput={(event: Event) => {
                        this.form.logo_url = (event.target as HTMLInputElement).value;
                        this.invalidField = null;
                      }}
                    />
                  </div>

                  <div class="form-field">
                    <span class="field-label">Primary color</span>
                    <input
                      class="field-control"
                      value={this.form.primary_color}
                      placeholder="#25a"
                      maxlength="7"
                      spellcheck="false"
                      disabled={this.pending}
                      aria-invalid={this.invalidField === 'primary_color' ? 'true' : null}
                      oninput={(event: Event) => {
                        this.form.primary_color = (event.target as HTMLInputElement).value;
                        this.invalidField = null;
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

                <div class="settings-actions">
                  <button
                    class="button"
                    type="button"
                    disabled={this.pending}
                    onclick={() => this.submit()}
                  >
                    {this.pending ? 'Saving' : 'Save changes'}
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    );
  },
};
