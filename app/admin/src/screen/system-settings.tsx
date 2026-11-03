import m from 'mithril';
import { PageHeader } from '@component/page-header';
import { SettingsTargetSelector } from '../component/settings-target-selector';
import {
  brandingFromInput,
  brandingValidationErrorField,
  logoUrlError,
  normalizePreviewColor,
  validateBrandingFields,
} from '@util/branding';
import { loadAdminSystemSettings, updateAdminSystemSettings } from '../util/auth';
import type { AdminRealm, AdminSystemSettings } from '../util/api';

interface SystemSettingsAttrs {
  realms: AdminRealm[] | null;
  onAuthExpired: () => void;
}

interface SystemSettingsFormValue {
  logo_url: string;
  primary_color: string;
}

interface SystemSettingsValidation {
  message: string;
  field: 'logo_url' | 'primary_color';
}

function formFromSettings(settings: AdminSystemSettings): SystemSettingsFormValue {
  return {
    logo_url: settings.logo_url || '',
    primary_color: settings.primary_color || '',
  };
}

function fieldFromError(message: string | null | undefined): SystemSettingsValidation['field'] | null {
  return brandingValidationErrorField(message);
}

export const SystemSettingsPage: m.Component<SystemSettingsAttrs> = {
  attrs: null as SystemSettingsAttrs | null,
  loading: false,
  loaded: false,
  settings: null as AdminSystemSettings | null,
  form: {
    logo_url: '',
    primary_color: '',
  } as SystemSettingsFormValue,
  error: null as Error | null,
  formError: null as Error | string | null,
  invalidField: null as SystemSettingsValidation['field'] | null,
  notice: null as string | null,
  pending: false,

  oninit(this: any, vnode: m.Vnode<SystemSettingsAttrs>) {
    this.attrs = vnode.attrs;
    this.load();
  },

  async load(this: any) {
    this.loading = true;
    this.loaded = false;
    this.error = null;
    this.formError = null;
    this.notice = null;
    this.settings = null;
    this.invalidField = null;
    this.form = {
      logo_url: '',
      primary_color: '',
    };
    m.redraw();

    try {
      const settings = await loadAdminSystemSettings();
      this.settings = settings;
      this.form = formFromSettings(settings);
      this.loaded = true;
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs?.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.loading = false;
      m.redraw();
    }
  },

  async submit(this: any) {
    const validationError = validateBrandingFields(this.form);
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
      const settings = await updateAdminSystemSettings(brandingFromInput(this.form));
      this.settings = settings;
      this.form = formFromSettings(settings);
      this.notice = 'System branding saved.';
    } catch (e: any) {
      if (e?.status === 401 || (e?.status === 400 && e?.code !== 'invalid_request')) {
        this.attrs?.onAuthExpired();
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
    const realms = this.attrs?.realms || null;
    const previewLogo = logoUrlError(this.form.logo_url) ? '' : this.form.logo_url.trim();
    const previewColor = normalizePreviewColor(this.form.primary_color);

    return (
      <div>
        <PageHeader
          row
          title="System branding"
          subtitle="Global logo and primary color for the identity provider."
        >
          <SettingsTargetSelector
            realms={realms}
            selectedSystem
            selectedRealm={null}
            onchange={(target: string) => {
              if (target === 'system') return;
              m.route.set(`/settings/${encodeURIComponent(target)}`);
            }}
          />
        </PageHeader>

        {this.error ? (
          <div class="alert" role="alert">
            <p>{this.error.message}</p>
            <button class="button-secondary" type="button" onclick={() => this.load()}>
              Try again
            </button>
          </div>
        ) : null}

        {this.notice ? (
          <div class="notice" role="status">
            {this.notice}
          </div>
        ) : null}

        {this.loading ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : this.loaded ? (
          <section class="panel">
            <h2>Global branding</h2>
            <p class="note">
              Used as the system fallback. Realm branding overrides these values, and client
              branding overrides realm branding.
            </p>
            <div class="settings-form">
              {this.formError ? (
                <div class="alert" role="alert">
                  {typeof this.formError === 'string' ? this.formError : this.formError.message}
                </div>
              ) : null}

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
        ) : null}
      </div>
    );
  },
};
