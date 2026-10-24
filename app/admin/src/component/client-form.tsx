import m from 'mithril';
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
  };
}

interface ClientFormAttrs {
  value: ClientFormValue;
  roles: AdminRole[];
  editing: boolean;
  submitLabel: string;
  pending: boolean;
  error: Error | string | null;
  onsubmit: () => void;
  oncancel?: () => void;
}

export const ClientForm: m.Component<ClientFormAttrs> = {
  view({ attrs }) {
    const value = attrs.value;
    const requirePkce = value.token_endpoint_auth_method === 'none' || value.require_pkce;

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
            <span class="field-label">Access mode</span>
            <select
              class="field-control"
              value={value.access_mode}
              onchange={(event: Event) => {
                value.access_mode = (event.target as HTMLSelectElement)
                  .value as ClientFormValue['access_mode'];
              }}
            >
              <option value="internal">Internal: home-realm members</option>
              <option value="members">Members: active realm members</option>
              <option value="public">Public: any authenticated user</option>
            </select>
          </div>

          <div class="form-field">
            <span class="field-label">Consent</span>
            <select
              class="field-control"
              value={value.consent_mode}
              onchange={(event: Event) => {
                value.consent_mode = (event.target as HTMLSelectElement)
                  .value as ClientFormValue['consent_mode'];
              }}
            >
              <option value="remembered">Remembered: prompt once</option>
              <option value="trusted">Trusted: skip for home realm</option>
            </select>
          </div>

          <div class="form-field">
            <span class="field-label">Token authentication</span>
            <select
              class="field-control"
              value={value.token_endpoint_auth_method}
              onchange={(event: Event) => {
                const method = (event.target as HTMLSelectElement)
                  .value as ClientFormValue['token_endpoint_auth_method'];
                value.token_endpoint_auth_method = method;
                if (method === 'none') value.require_pkce = true;
              }}
            >
              <option value="none">Public client: PKCE</option>
              <option value="client_secret_basic">Confidential: client secret</option>
            </select>
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
