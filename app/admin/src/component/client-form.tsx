import m from 'mithril';
import { SelectMenu } from '@component/select-menu';
import {
  brandingFromInput,
  logoUrlError,
  normalizePreviewColor,
  validateBrandingFields,
  type BrandingField,
  type BrandingValidationError,
} from '@util/branding';
import type { AdminClient, AdminClientInput, AdminRole } from '../util/api';

export interface ClientFormValue {
  client_id: string;
  name: string;
  access_mode: AdminClient['access_mode'];
  enabled: boolean;
  scopes: string;
  required_roles: string[];
  redirect_uris: string;
  post_logout_redirect_uris: string;
  token_endpoint_auth_method: AdminClient['token_endpoint_auth_method'];
  require_pkce: boolean;
  consent_mode: AdminClient['consent_mode'];
  logo_url: string;
  primary_color: string;
}

export function defaultClientForm(): ClientFormValue {
  return {
    client_id: '',
    name: '',
    access_mode: 'members',
    enabled: true,
    scopes: 'openid profile email',
    required_roles: [],
    redirect_uris: '',
    post_logout_redirect_uris: '',
    token_endpoint_auth_method: 'none',
    require_pkce: true,
    consent_mode: 'remembered',
    logo_url: '',
    primary_color: '',
  };
}

export function parseUriLines(value: string): string[] {
  return [...new Set(value.split('\n').map((item) => item.trim()).filter(Boolean))];
}

export function clientFormValue(client: AdminClient): ClientFormValue {
  return {
    client_id: client.client_id,
    name: client.name,
    access_mode: client.access_mode,
    enabled: client.enabled,
    scopes: client.scopes,
    required_roles: [...client.required_roles],
    redirect_uris: client.redirect_uris.join('\n'),
    post_logout_redirect_uris: client.post_logout_redirect_uris.join('\n'),
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    require_pkce: client.require_pkce,
    consent_mode: client.consent_mode,
    logo_url: client.logo_url || '',
    primary_color: client.primary_color || '',
  };
}

export function toClientInput(value: ClientFormValue): AdminClientInput {
  const tokenEndpointAuthMethod = value.token_endpoint_auth_method;
  return {
    name: value.name.trim(),
    access_mode: value.access_mode,
    enabled: value.enabled,
    scopes: value.scopes.trim(),
    required_roles: [...value.required_roles],
    redirect_uris: parseUriLines(value.redirect_uris),
    post_logout_redirect_uris: parseUriLines(value.post_logout_redirect_uris),
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    require_pkce: tokenEndpointAuthMethod === 'none' ? true : value.require_pkce,
    consent_mode: value.consent_mode,
    ...brandingFromInput(value),
  };
}

export function validateClientBranding(value: ClientFormValue): BrandingValidationError | null {
  return validateBrandingFields(value);
}

interface ClientFormAttrs {
  value: ClientFormValue;
  roles: AdminRole[];
  editing: boolean;
  submitLabel: string;
  pending: boolean;
  error: Error | string | null;
  invalidField?: BrandingField | null;
  onclearerror?: () => void;
  onsubmit: () => void;
  oncancel?: () => void;
}

export const ClientForm: m.Component<ClientFormAttrs> = {
  view({ attrs }) {
    const value = attrs.value;
    const requirePkce = value.token_endpoint_auth_method === 'none' || value.require_pkce;
    const previewLogo = logoUrlError(value.logo_url) ? '' : value.logo_url.trim();
    const previewColor = normalizePreviewColor(value.primary_color);
    const clearError = () => attrs.onclearerror?.();

    return (
      <form
        class="client-form"
        onsubmit={(event: Event) => {
          event.preventDefault();
          attrs.onsubmit();
        }}
      >
        {attrs.error ? (
          <div class="alert" role="alert">
            {typeof attrs.error === 'string' ? attrs.error : attrs.error.message}
          </div>
        ) : null}

        <div class="field-grid">
          <div class="form-field">
            <span class="field-label">Client ID</span>
            <input
              class="field-control"
              value={value.client_id}
              disabled={attrs.editing}
              placeholder="my-app"
              oninput={(event: Event) => {
                value.client_id = (event.target as HTMLInputElement).value;
              }}
            />
          </div>

          <div class="form-field">
            <span class="field-label">Name</span>
            <input
              class="field-control"
              value={value.name}
              oninput={(event: Event) => {
                value.name = (event.target as HTMLInputElement).value;
              }}
            />
          </div>

          <div class="form-field">
            <span class="field-label" id="client-access-mode-label">Access mode</span>
            <SelectMenu
              labelledBy="client-access-mode-label"
              value={value.access_mode}
              disabled={attrs.pending}
              options={[
                { value: 'internal', label: 'Internal: home-realm members' },
                { value: 'members', label: 'Members: active realm members' },
                { value: 'public', label: 'Public: any authenticated user' },
              ]}
              onchange={(option) => {
                value.access_mode = option as ClientFormValue['access_mode'];
              }}
            />
          </div>

          <div class="form-field">
            <span class="field-label" id="client-consent-mode-label">Consent</span>
            <SelectMenu
              labelledBy="client-consent-mode-label"
              value={value.consent_mode}
              disabled={attrs.pending}
              options={[
                { value: 'remembered', label: 'Remembered: prompt once' },
                { value: 'trusted', label: 'Trusted: skip for home realm' },
              ]}
              onchange={(option) => {
                value.consent_mode = option as ClientFormValue['consent_mode'];
              }}
            />
          </div>

          <div class="form-field">
            <span class="field-label" id="client-token-auth-label">Token authentication</span>
            <SelectMenu
              labelledBy="client-token-auth-label"
              value={value.token_endpoint_auth_method}
              disabled={attrs.pending}
              options={[
                { value: 'none', label: 'Public client: PKCE' },
                { value: 'client_secret_basic', label: 'Confidential: client secret' },
              ]}
              onchange={(option) => {
                const method = option as ClientFormValue['token_endpoint_auth_method'];
                value.token_endpoint_auth_method = method;
                if (method === 'none') value.require_pkce = true;
              }}
            />
          </div>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={value.enabled}
              onchange={(event: Event) => {
                value.enabled = (event.target as HTMLInputElement).checked;
              }}
            />
            <span>Enabled</span>
          </label>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={requirePkce}
              disabled={value.token_endpoint_auth_method === 'none'}
              onchange={(event: Event) => {
                value.require_pkce = (event.target as HTMLInputElement).checked;
              }}
            />
            <span>Require PKCE</span>
          </label>
        </div>

        <div class="form-field">
          <span class="field-label">Scopes</span>
          <input
            class="field-control"
            value={value.scopes}
            oninput={(event: Event) => {
              value.scopes = (event.target as HTMLInputElement).value;
            }}
          />
        </div>

        <div class="form-field">
          <span class="field-label">Redirect URIs</span>
          <textarea
            class="field-control field-textarea"
            value={value.redirect_uris}
            placeholder="https://app.example.test/callback"
            oninput={(event: Event) => {
              value.redirect_uris = (event.target as HTMLTextAreaElement).value;
            }}
          />
        </div>

        <div class="form-field">
          <span class="field-label">Post-logout redirect URIs</span>
          <textarea
            class="field-control field-textarea"
            value={value.post_logout_redirect_uris}
            placeholder="https://app.example.test/"
            oninput={(event: Event) => {
              value.post_logout_redirect_uris = (event.target as HTMLTextAreaElement).value;
            }}
          />
        </div>

        <fieldset class="branding-field">
          <legend>Branding</legend>
          <p class="note">Optional client overrides. Empty values use this realm's branding.</p>
          <div class="field-grid">
            <div class="form-field">
              <span class="field-label">Logo URL</span>
              <input
                class="field-control"
                type="url"
                value={value.logo_url}
                placeholder="https://app.example.test/logo.svg"
                maxlength="2048"
                disabled={attrs.pending}
                aria-invalid={attrs.invalidField === 'logo_url' ? 'true' : null}
                oninput={(event: Event) => {
                  value.logo_url = (event.target as HTMLInputElement).value;
                  clearError();
                }}
              />
            </div>

            <div class="form-field">
              <span class="field-label">Primary color</span>
              <input
                class="field-control"
                value={value.primary_color}
                placeholder="#25a"
                maxlength="7"
                spellcheck="false"
                disabled={attrs.pending}
                aria-invalid={attrs.invalidField === 'primary_color' ? 'true' : null}
                oninput={(event: Event) => {
                  value.primary_color = (event.target as HTMLInputElement).value;
                  clearError();
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
        </fieldset>

        <fieldset class="role-field">
          <legend>Required roles</legend>
          {attrs.roles.length === 0 ? (
            <p class="note">No realm roles are available.</p>
          ) : (
            <div class="checkbox-list">
              {attrs.roles.map((role) => {
                const checked = value.required_roles.includes(role.slug);
                return (
                  <label class="checkbox-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onchange={(event: Event) => {
                        const index = value.required_roles.indexOf(role.slug);
                        const selected = (event.target as HTMLInputElement).checked;
                        if (selected && index === -1) {
                          value.required_roles.push(role.slug);
                        }
                        if (!selected && index !== -1) {
                          value.required_roles.splice(index, 1);
                        }
                      }}
                    />
                    <span>{role.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        <div class="client-actions">
          <button class="button" type="submit" disabled={attrs.pending}>
            {attrs.pending ? 'Saving' : attrs.submitLabel}
          </button>
          {attrs.oncancel ? (
            <button
              class="button-secondary"
              type="button"
              disabled={attrs.pending}
              onclick={attrs.oncancel}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    );
  },
};
