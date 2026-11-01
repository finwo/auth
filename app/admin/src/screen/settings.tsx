import m from 'mithril';
import { PageHeader } from '@component/page-header';
import { RealmSelector } from '../component/realm-selector';
import { loadAdminRealmSettings, updateAdminRealmSettings } from '../util/auth';
import type { AdminRealm, AdminRealmSettings } from '../util/api';

interface SettingsAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
  onRealmsChanged: () => Promise<void>;
}

interface SettingsFormValue {
  display_name: string;
  allow_session_duration_choice: boolean;
}

function formFromSettings(settings: AdminRealmSettings): SettingsFormValue {
  return {
    display_name: settings.display_name,
    allow_session_duration_choice: settings.allow_session_duration_choice,
  };
}

function validateForm(value: SettingsFormValue): string | null {
  const displayName = value.display_name.trim();

  if (!displayName) {
    return 'Display name is required.';
  }
  if (/[\r\n]/.test(value.display_name)) {
    return 'Display name must be a single line.';
  }
  if (displayName.length > 100) {
    return 'Display name must be 100 characters or fewer.';
  }

  return null;
}

export const SettingsPage: m.Component<SettingsAttrs> = {
  attrs: null as SettingsAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  settings: null as AdminRealmSettings | null,
  form: { display_name: '', allow_session_duration_choice: true } as SettingsFormValue,
  error: null as Error | null,
  formError: null as Error | string | null,
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
    this.form = { display_name: '', allow_session_duration_choice: true };
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
      this.formError = validationError;
      this.notice = null;
      m.redraw();
      return;
    }

    this.pending = true;
    this.formError = null;
    this.notice = null;
    m.redraw();

    try {
      const settings = await updateAdminRealmSettings(realmSlug, {
        display_name: this.form.display_name.trim(),
        allow_session_duration_choice: this.form.allow_session_duration_choice,
      });

      if (this.loadedRealm !== realmSlug) return;

      this.settings = settings;
      this.form = formFromSettings(settings);
      this.notice = 'Realm settings saved.';
      await this.attrs.onRealmsChanged();
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.formError = e as Error;
    } finally {
      this.pending = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError, realmSlug } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === realmSlug) || realms?.[0] || null;

    return (
      <div>
        <PageHeader row title="Realm settings" subtitle="Realm name and login behavior.">
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              m.route.set(`/settings/${encodeURIComponent(slug)}`);
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
        ) : this.loading || this.redirecting ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : this.settings ? (
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
                  aria-invalid={Boolean(this.formError)}
                  oninput={(event: Event) => {
                    this.form.display_name = (event.target as HTMLInputElement).value;
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

              <div class="settings-actions">
                <button class="button" type="submit" disabled={this.pending}>
                  {this.pending ? 'Saving' : 'Save changes'}
                </button>
              </div>
            </form>
          </section>
        ) : null}
      </div>
    );
  },
};
