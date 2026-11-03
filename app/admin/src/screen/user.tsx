import m from 'mithril';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import { SelectMenu } from '@component/select-menu';
import { RealmSelector } from '../component/realm-selector';
import {
  createAdminUserBan,
  deleteAdminUserBan,
  loadAdminClients,
  loadAdminRoles,
  loadAdminUserDetail,
  revokeAdminUserConsent,
  updateAdminRealmMembership,
  updateAdminRealmUserRoles,
} from '../util/auth';
import {
  appUrl,
  type AdminClient,
  type AdminRealm,
  type AdminRole,
  type AdminUserBan,
  type AdminUserConsent,
  type AdminUserDetail,
} from '../util/api';
import { formatTime } from '@util/format';

interface UserAttrs {
  realmSlug: string | null;
  userId: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
}

type UserAction = 'revoke' | 'unban';

interface UserConfirm {
  type: UserAction;
  clientId: string;
  label: string;
}

function detailKey(realmSlug: string | null, userId: string | null) {
  return `${realmSlug || ''}:${userId || ''}`;
}

function actionKey(action: UserConfirm) {
  return `${action.type}:${action.clientId}`;
}

function grantedLabel(consent: AdminUserConsent) {
  return consent.granted_via === 'trusted' ? 'Trusted client' : 'User consent';
}

function banLabel(ban: AdminUserBan) {
  return ban.client_id === '*' ? 'All apps' : ban.client_name || ban.client_id;
}

function roleLabel(role: AdminRole) {
  return role.name || role.slug;
}

function changedRoles(current: string[], selected: string[]) {
  return current.length !== selected.length || current.some((role) => !selected.includes(role));
}

function changedAdminRole(current: string[], selected: string[]) {
  return current.includes('realm-admin') !== selected.includes('realm-admin');
}

function membershipActionLabel(status: string | null) {
  return status === 'suspended' ? 'Reactivate member' : 'Suspend member';
}

function membershipStatusLabel(status: string | null) {
  if (!status) return 'Not a member';
  return status[0].toUpperCase() + status.slice(1);
}

function statusLabel(detail: AdminUserDetail) {
  if (detail.user.status !== 'active') {
    return detail.user.status === 'disabled' ? 'Disabled' : detail.user.status;
  }
  return 'Active';
}

export const UserPage: m.Component<UserAttrs> = {
  attrs: null as UserAttrs | null,
  loadedKey: null as string | null,
  loading: false,
  redirecting: false,
  detail: null as AdminUserDetail | null,
  clients: [] as AdminClient[],
  roles: [] as AdminRole[],
  selectedRoles: [] as string[],
  error: null as Error | null,
  notice: null as string | null,
  confirm: null as UserConfirm | null,
  pendingAction: false,
  membershipConfirm: false,
  membershipPending: false,
  roleConfirm: false,
  rolePending: false,
  banOpen: false,
  banClientId: '*',
  banPending: false,

  oninit(this: any, vnode: m.Vnode<UserAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<UserAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug, userId } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.detail = null;
      this.loading = false;
      this.error = null;
      return;
    }

    const selected = realmSlug && realms.some((realm) => realm.slug === realmSlug);
    if (!selected) {
      if (!this.redirecting) {
        this.redirecting = true;
        m.route.set(`/users/${encodeURIComponent(realms[0].slug)}`, null, { replace: true });
      }
      return;
    }

    this.redirecting = false;
    const key = detailKey(realmSlug, userId);
    if (key === this.loadedKey) return;

    this.loadedKey = key;
    this.detail = null;
    this.clients = [];
    this.roles = [];
    this.selectedRoles = [];
    this.error = null;
    this.notice = null;
    this.confirm = null;
    this.pendingAction = false;
    this.membershipConfirm = false;
    this.membershipPending = false;
    this.roleConfirm = false;
    this.rolePending = false;
    this.banOpen = false;
    this.banClientId = '*';
    this.banPending = false;
    if (realmSlug && userId) this.load(realmSlug, userId);
  },

  async load(this: any, realmSlug: string, userId: string) {
    this.loading = true;
    this.error = null;
    this.notice = null;
    m.redraw();

    try {
      const [detail, clients, roles] = await Promise.all([
        loadAdminUserDetail(realmSlug, userId),
        loadAdminClients(realmSlug),
        loadAdminRoles(realmSlug),
      ]);
      if (this.loadedKey === detailKey(realmSlug, userId)) {
        this.detail = detail;
        this.clients = clients;
        this.roles = roles;
        this.selectedRoles = [...detail.user.roles];
      }
    } catch (e: any) {
      if (this.loadedKey !== detailKey(realmSlug, userId)) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedKey === detailKey(realmSlug, userId)) this.loading = false;
      m.redraw();
    }
  },

  cancelAction(this: any) {
    this.confirm = null;
    this.banOpen = false;
    m.redraw();
  },

  async submitAction(this: any) {
    const { realmSlug, userId } = this.attrs;
    if (!realmSlug || !userId || !this.confirm) return;

    const action = this.confirm;
    this.pendingAction = true;
    this.error = null;
    this.notice = null;

    try {
      if (action.type === 'revoke') {
        await revokeAdminUserConsent(realmSlug, userId, action.clientId);
        this.notice = 'Consent revoked. The app must request access again.';
      } else {
        await deleteAdminUserBan(realmSlug, userId, action.clientId);
        this.notice = 'App ban removed.';
      }
      this.confirm = null;
      await this.load(realmSlug, userId);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.pendingAction = false;
      m.redraw();
    }
  },

  async submitBan(this: any) {
    const { realmSlug, userId } = this.attrs;
    if (!realmSlug || !userId) return;

    this.banPending = true;
    this.error = null;
    this.notice = null;

    try {
      await createAdminUserBan(realmSlug, userId, this.banClientId);
      this.banOpen = false;
      this.notice = 'App ban created.';
      await this.load(realmSlug, userId);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.banPending = false;
      m.redraw();
    }
  },

  cancelAccessActions(this: any) {
    this.membershipConfirm = false;
    this.roleConfirm = false;
    if (this.detail) this.selectedRoles = [...this.detail.user.roles];
    m.redraw();
  },

  applyMembershipUpdate(this: any, response: any) {
    this.detail = response;
    this.selectedRoles = [...response.user.roles];
    this.membershipConfirm = false;
    this.notice =
      response.user.membership_status === 'suspended'
        ? 'Membership suspended. Existing realm access was revoked.'
        : 'Membership reactivated. Previously revoked authorizations were not restored.';
  },

  async submitMembership(this: any) {
    const { realmSlug, userId } = this.attrs;
    if (!realmSlug || !userId || !this.detail) return;

    const status = this.detail.user.membership_status === 'suspended' ? 'active' : 'suspended';
    this.membershipPending = true;
    this.error = null;
    this.notice = null;

    try {
      const response = await updateAdminRealmMembership(realmSlug, userId, status);
      this.applyMembershipUpdate(response);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.membershipPending = false;
      m.redraw();
    }
  },

  async submitRoles(this: any) {
    const { realmSlug, userId } = this.attrs;
    if (!realmSlug || !userId || !this.detail) return;

    this.rolePending = true;
    this.error = null;
    this.notice = null;

    try {
      const response = await updateAdminRealmUserRoles(
        realmSlug,
        userId,
        [...this.selectedRoles].sort()
      );
      this.detail = response;
      this.selectedRoles = [...response.user.roles];
      this.roleConfirm = false;
      this.notice = 'Realm roles updated.';
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.rolePending = false;
      m.redraw();
    }
  },

  requestRoleSave(this: any) {
    if (!this.detail) return;
    if (changedAdminRole(this.detail.user.roles, this.selectedRoles)) {
      this.roleConfirm = true;
    } else {
      this.submitRoles();
    }
  },

  view(this: any) {
    const { realms, realmsError, realmSlug, userId } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === realmSlug) || realms?.[0] || null;
    const detail = this.detail;
    const usersHref = `/users/${encodeURIComponent(realmSlug || '')}`;
    const displayName = detail?.user.display_name || detail?.user.username || userId || 'User';

    return (
      <div>
        <PageHeader row title="User" subtitle="Account, consent and app restrictions.">
          <RealmSelector
            realms={realms}
            selected={selected}
            onchange={(slug: string) => {
              m.route.set(`/users/${encodeURIComponent(slug)}`);
            }}
          />
        </PageHeader>

        <div class="client-breadcrumb">
          <a
            href={appUrl(usersHref)}
            onclick={(event: Event) => {
              event.preventDefault();
              m.route.set(usersHref);
            }}
          >
            Users
          </a>
          <span aria-hidden="true">/</span>
          <span>{displayName}</span>
        </div>

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
                if (realmSlug && userId) this.load(realmSlug, userId);
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
        ) : this.loading || this.redirecting ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : detail ? (
          <div class="client-stack">
            <section class="panel">
              <h2>Account</h2>
              <dl class="details">
                <div>
                  <dt>Display name</dt>
                  <dd>{detail.user.display_name || detail.user.username}</dd>
                </div>
                <div>
                  <dt>Username</dt>
                  <dd>{detail.user.username}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{detail.user.email || 'No verified email'}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{statusLabel(detail)}</dd>
                </div>
                <div>
                  <dt>System admin</dt>
                  <dd>{detail.user.is_system_admin ? 'Yes' : 'No'}</dd>
                </div>
                <div>
                  <dt>Last login</dt>
                  <dd>{detail.user.last_login_at ? formatTime(detail.user.last_login_at) : 'Never'}</dd>
                </div>
              </dl>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>Realm access</h2>
                  <p class="note">Manage membership and roles in this realm.</p>
                </div>
                {detail.permissions.can_suspend_membership ||
                detail.permissions.can_reactivate_membership ? (
                  <button
                    class={
                      detail.permissions.can_suspend_membership ? 'button-danger' : 'button-secondary'
                    }
                    type="button"
                    disabled={this.membershipPending}
                    onclick={() => {
                      if (detail.permissions.can_reactivate_membership) {
                        this.submitMembership();
                      } else {
                        this.membershipConfirm = true;
                        m.redraw();
                      }
                    }}
                  >
                    {this.membershipPending
                      ? 'Applying'
                      : membershipActionLabel(detail.user.membership_status)}
                  </button>
                ) : null}
              </div>
              <dl class="details">
                <div>
                  <dt>Relationship</dt>
                  <dd>{detail.user.relationship === 'home' ? 'Home realm' : 'Guest'}</dd>
                </div>
                <div>
                  <dt>Membership</dt>
                  <dd>{membershipStatusLabel(detail.user.membership_status)}</dd>
                </div>
              </dl>
              {detail.permissions.last_active_realm_admin ? (
                <div class="notice">
                  This is the only active realm administrator. System admins can still remove
                  this access.
                </div>
              ) : null}
              <fieldset class="role-field">
                <legend>Realm roles</legend>
                {this.roles.length === 0 ? (
                  <p class="note">No realm roles are available.</p>
                ) : (
                  <div class="checkbox-list">
                    {this.roles.map((role: AdminRole) => {
                      const checked = this.selectedRoles.includes(role.slug);
                      const protectedRole =
                        !detail.permissions.can_edit_roles ||
                        (detail.permissions.last_active_realm_admin &&
                          !detail.permissions.can_remove_last_realm_admin &&
                          role.slug === 'realm-admin' &&
                          detail.user.roles.includes(role.slug));
                      return (
                        <label class="checkbox-row">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={protectedRole}
                            onchange={(event: Event) => {
                              const selected = new Set(this.selectedRoles);
                              if ((event.target as HTMLInputElement).checked) {
                                selected.add(role.slug);
                              } else {
                                selected.delete(role.slug);
                              }
                              this.selectedRoles = [...selected].sort();
                              m.redraw();
                            }}
                          />
                          <span>{roleLabel(role)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              {detail.permissions.can_edit_roles ? (
                <div class="modal-actions">
                  <button
                    class="button"
                    type="button"
                    disabled={
                      this.rolePending ||
                      !changedRoles(detail.user.roles, this.selectedRoles)
                    }
                    onclick={() => this.requestRoleSave()}
                  >
                    {this.rolePending ? 'Saving roles' : 'Save roles'}
                  </button>
                </div>
              ) : null}
            </section>

            <section class="panel">
              <div class="panel-header">
                <h2>Application consents</h2>
              </div>
              {detail.consents.length === 0 ? (
                <div class="empty">
                  <p>No consents have been recorded for this realm.</p>
                </div>
              ) : (
                <div class="data-table-wrap">
                  <table class="data-table data-table-static">
                    <thead>
                      <tr>
                        <th class="data-table-primary" scope="col">Application</th>
                        <th scope="col">Scopes</th>
                        <th scope="col">Granted</th>
                        <th scope="col">Status</th>
                        <th scope="col">Updated</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.consents.map((consent: AdminUserConsent) => (
                        <tr>
                          <td class="data-table-primary">
                            <strong>{consent.client_name || 'Unknown client'}</strong>
                            <span class="data-table-sub">{consent.client_id}</span>
                          </td>
                          <td data-label="Scopes">
                            {consent.scopes.length ? consent.scopes.join(', ') : 'None'}
                          </td>
                          <td data-label="Granted">
                            {grantedLabel(consent)}
                            {consent.client_consent_mode ? (
                              <span class="data-table-sub">
                                {consent.client_consent_mode}
                              </span>
                            ) : null}
                          </td>
                          <td data-label="Status">
                            {consent.active ? 'Active' : 'Revoked'}
                            {!consent.active ? (
                              <span class="data-table-status">Revoked</span>
                            ) : null}
                          </td>
                          <td data-label="Updated">{formatTime(consent.updated_at)}</td>
                          <td data-label="Action">
                            {consent.active ? (
                              <button
                                class="button-secondary"
                                type="button"
                                disabled={Boolean(this.pendingAction)}
                                onclick={() => {
                                  this.confirm = {
                                    type: 'revoke',
                                    clientId: consent.client_id,
                                    label: consent.client_name || consent.client_id,
                                  };
                                  m.redraw();
                                }}
                              >
                                Revoke
                              </button>
                            ) : (
                              'None'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>Application bans</h2>
                  <p class="note">Bans persist independently of consent.</p>
                </div>
                <button
                  class="button-danger"
                  id="open-ban-dialog"
                  type="button"
                  onclick={() => {
                    this.banClientId = '*';
                    this.banOpen = true;
                    this.error = null;
                    m.redraw();
                  }}
                >
                  Ban from app
                </button>
              </div>
              {detail.bans.length === 0 ? (
                <div class="empty">
                  <p>This user is not banned from any app.</p>
                </div>
              ) : (
                <div class="data-table-wrap">
                  <table class="data-table data-table-static">
                    <thead>
                      <tr>
                        <th class="data-table-primary" scope="col">Application</th>
                        <th scope="col">Banned by</th>
                        <th scope="col">Created</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.bans.map((ban: AdminUserBan) => (
                        <tr>
                          <td class="data-table-primary">
                            <strong>{banLabel(ban)}</strong>
                            {ban.client_id !== '*' ? (
                              <span class="data-table-sub">{ban.client_id}</span>
                            ) : null}
                          </td>
                          <td data-label="Banned by">
                            {ban.created_by_username || 'Unknown'}
                          </td>
                          <td data-label="Created">{formatTime(ban.created_at)}</td>
                          <td data-label="Action">
                            <button
                              class="button-secondary"
                              type="button"
                              disabled={Boolean(this.pendingAction)}
                              onclick={() => {
                                this.confirm = {
                                  type: 'unban',
                                  clientId: ban.client_id,
                                  label: banLabel(ban),
                                };
                                m.redraw();
                              }}
                            >
                              Unban
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        ) : (
          <div class="empty">
            <p>This user is not a member of the selected realm.</p>
          </div>
        )}

        {this.confirm && detail ? (
          <Modal
            title={this.confirm.type === 'revoke' ? 'Revoke consent' : 'Remove app ban'}
            onClose={() => this.cancelAction()}
          >
            {this.confirm.type === 'revoke' ? (
              <p class="modal-note">
                Revoke {this.confirm.label} for {displayName}? The app must request access again.
              </p>
            ) : (
              <p class="modal-note">
                Remove the {this.confirm.label} ban for {displayName}? Revoked consents are not
                restored automatically.
              </p>
            )}
            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.pendingAction}
                onclick={() => this.cancelAction()}
              >
                Cancel
              </button>
              <button
                class={this.confirm.type === 'revoke' ? 'button' : 'button-danger'}
                type="button"
                disabled={this.pendingAction}
                onclick={() => this.submitAction()}
              >
                {this.pendingAction
                  ? this.confirm.type === 'revoke' ? 'Revoking' : 'Removing'
                  : this.confirm.type === 'revoke' ? 'Revoke consent' : 'Remove ban'}
              </button>
            </div>
          </Modal>
        ) : null}

        {this.banOpen && detail ? (
          <Modal title="Ban from app" onClose={() => this.cancelAction()}>
            <div class="form-field">
              <span class="field-label" id="ban-application-label">Application</span>
              <SelectMenu
                labelledBy="ban-application-label"
                value={this.banClientId}
                disabled={this.banPending}
                options={[
                  { value: '*', label: 'All apps' },
                  ...this.clients.map((client: AdminClient) => ({
                    value: client.client_id,
                    label: client.name,
                  })),
                ]}
                onchange={(clientId) => {
                  this.banClientId = clientId;
                }}
              />
            </div>
            <p class="modal-note">
              Banning {displayName} revokes matching consents and refresh tokens. The ban remains
              in force after later sign-in attempts.
            </p>
            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.banPending}
                onclick={() => this.cancelAction()}
              >
                Cancel
              </button>
              <button
                class="button-danger"
                type="button"
                disabled={this.banPending}
                onclick={() => this.submitBan()}
              >
                {this.banPending ? 'Creating ban' : 'Ban user'}
              </button>
            </div>
          </Modal>
        ) : null}

        {this.membershipConfirm && detail ? (
          <Modal title="Suspend membership" onClose={() => this.cancelAccessActions()}>
            <p class="modal-note">
              Suspending {displayName} revokes realm consents, refresh tokens and session
              bindings. Reactivating the membership does not restore those authorizations.
            </p>
            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.membershipPending}
                onclick={() => this.cancelAccessActions()}
              >
                Cancel
              </button>
              <button
                class="button-danger"
                type="button"
                disabled={this.membershipPending}
                onclick={() => this.submitMembership()}
              >
                {this.membershipPending ? 'Suspending' : 'Suspend member'}
              </button>
            </div>
          </Modal>
        ) : null}

        {this.roleConfirm && detail ? (
          <Modal title="Update realm roles" onClose={() => this.cancelAccessActions()}>
            <p class="modal-note">
              Realm-admin access is re-read from the realm database on each request. Changing
              this role can immediately alter who can administer {selected?.display_name}.
            </p>
            <div class="modal-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={this.rolePending}
                onclick={() => this.cancelAccessActions()}
              >
                Cancel
              </button>
              <button
                class="button"
                type="button"
                disabled={this.rolePending}
                onclick={() => this.submitRoles()}
              >
                {this.rolePending ? 'Saving roles' : 'Save roles'}
              </button>
            </div>
          </Modal>
        ) : null}
      </div>
    );
  },
};
