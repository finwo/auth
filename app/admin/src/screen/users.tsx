import { Users } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';
import { Modal } from '@component/modal';
import { PageHeader } from '@component/page-header';
import { RealmSelector } from '../component/realm-selector';
import {
  addAdminRealmMember,
  loadAdminGlobalUsers,
  loadAdminUsers,
  lookupAdminRealmUser,
} from '../util/auth';
import {
  appUrl,
  type AdminGlobalUser,
  type AdminRealm,
  type AdminRealmUser,
  type AdminUserLookup,
} from '../util/api';

interface UsersAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
  isSystemAdmin: boolean;
  isGlobal: boolean;
}

type AnyUser = AdminRealmUser | AdminGlobalUser;

function matchesSearch(user: AnyUser, term: string) {
  if (!term) return true;
  const values = [user.display_name, user.username, user.email || ''];
  if ('relationship' in user) values.push(user.relationship);
  if ('roles' in user) values.push(user.roles.join(' '));
  if ('home_realm_slug' in user) values.push(user.home_realm_slug || '');
  return values.join(' ').toLowerCase().includes(term);
}

function relationshipLabel(user: AdminRealmUser) {
  return user.relationship === 'home' ? 'Home' : 'Guest';
}

function realmStatus(user: AdminRealmUser) {
  if (user.status !== 'active') return user.status === 'disabled' ? 'Disabled' : user.status;
  if (user.membership_status && user.membership_status !== 'active') {
    return user.membership_status[0].toUpperCase() + user.membership_status.slice(1);
  }
  if (user.banned) return 'Banned';
  return 'Active';
}

function globalStatusLabel(user: AdminGlobalUser) {
  if (user.status !== 'active') return user.status === 'disabled' ? 'Disabled' : user.status;
  return 'Active';
}

function userHref(isGlobal: boolean, realmSlug: string | null, userId: string) {
  const encodedUser = encodeURIComponent(userId);
  if (isGlobal) return `/users/global/${encodedUser}`;
  return `/users/${encodeURIComponent(realmSlug || '')}/${encodedUser}`;
}

function lookupReason(result: AdminUserLookup) {
  if (result.reason === 'user_disabled') return 'This global account is disabled.';
  if (result.relationship === 'home') return 'This user is already a home-realm member.';
  if (result.relationship === 'guest') return 'This user is already a guest member.';
  if (result.reason) return 'This user cannot be added to the realm.';
  return 'No membership in this realm.';
}

export const UsersPage: m.Component<UsersAttrs> = {
  attrs: null as UsersAttrs | null,
  loadedScope: null as string | null,
  loading: false,
  redirecting: false,
  users: null as AnyUser[] | null,
  search: '',
  error: null as Error | null,
  addOpen: false,
  addIdentifier: '',
  addResult: null as AdminUserLookup | null,
  addPending: false,
  addError: null as Error | null,

  oninit(this: any, vnode: m.Vnode<UsersAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<UsersAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug, isSystemAdmin, isGlobal } = this.attrs;
    if (!realms) return;

    if (realms.length === 0 && !isGlobal) {
      this.users = [];
      this.loading = false;
      this.error = null;
      return;
    }

    if (isGlobal && !isSystemAdmin) {
      if (realms.length > 0) {
        m.route.set(`/users/${encodeURIComponent(realms[0].slug)}`, null, { replace: true });
      }
      return;
    }

    const scope = isGlobal ? 'global' : realmSlug;
    if (!isGlobal && !(realmSlug && realms.some((realm) => realm.slug === realmSlug))) {
      if (!this.redirecting && realms.length > 0) {
        this.redirecting = true;
        m.route.set(`/users/${encodeURIComponent(realms[0].slug)}`, null, { replace: true });
      }
      return;
    }

    this.redirecting = false;
    if (this.loadedScope !== scope) {
      this.search = '';
      this.error = null;
      this.resetAdd();
      this.load(scope);
    }
  },

  resetAdd(this: any) {
    this.addOpen = false;
    this.addIdentifier = '';
    this.addResult = null;
    this.addPending = false;
    this.addError = null;
  },

  async load(this: any, scope: string) {
    this.loadedScope = scope;
    this.loading = true;
    this.error = null;
    this.users = null;
    m.redraw();

    try {
      const users = scope === 'global' ? await loadAdminGlobalUsers() : await loadAdminUsers(scope);
      if (this.loadedScope === scope) this.users = users;
    } catch (e: any) {
      if (this.loadedScope !== scope) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedScope === scope) this.loading = false;
      m.redraw();
    }
  },

  async searchAdd(this: any) {
    const realmSlug = this.attrs?.realmSlug;
    const identifier = this.addIdentifier.trim();
    if (!realmSlug || !identifier) {
      this.addError = new Error('Enter an exact email or username');
      m.redraw();
      return;
    }

    this.addPending = true;
    this.addError = null;
    this.addResult = null;
    m.redraw();

    try {
      const result = await lookupAdminRealmUser(realmSlug, identifier);
      if (this.attrs?.realmSlug === realmSlug) this.addResult = result;
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs?.onAuthExpired();
        return;
      }
      this.addError = e as Error;
    } finally {
      this.addPending = false;
      m.redraw();
    }
  },

  async submitAdd(this: any) {
    const realmSlug = this.attrs?.realmSlug;
    const result = this.addResult;
    if (!realmSlug || !result?.can_add) return;

    this.addPending = true;
    this.addError = null;
    m.redraw();

    try {
      await addAdminRealmMember(realmSlug, result.id);
      this.resetAdd();
      m.route.set(userHref(false, realmSlug, result.id));
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs?.onAuthExpired();
        return;
      }
      this.addError = e as Error;
      if (e?.status === 409) {
        this.addResult = null;
      }
    } finally {
      this.addPending = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError, isSystemAdmin, isGlobal, realmSlug } = this.attrs;
    const selected = isGlobal
      ? null
      : realms?.find((realm) => realm.slug === realmSlug) || realms?.[0] || null;
    const term = this.search.trim().toLowerCase();
    const visibleUsers = (this.users || []).filter((user: AnyUser) => matchesSearch(user, term));

    return (
      <div>
        <PageHeader
          row
          title="Users"
          subtitle={isGlobal ? 'All global user identities.' : 'Home and guest members in this realm.'}
        >
          <RealmSelector
            realms={realms}
            selected={selected}
            allRealms={isSystemAdmin}
            selectedAll={isGlobal}
            onchange={(slug: string) => {
              this.search = '';
              this.error = null;
              m.route.set(slug === 'global' ? '/users/global' : `/users/${encodeURIComponent(slug)}`);
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
            <button class="button-secondary" type="button" onclick={() => this.load(this.loadedScope)}>
              Try again
            </button>
          </div>
        ) : null}

        {!realms ? (
          <div class="loading">Loading realms</div>
        ) : !isGlobal && realms.length === 0 ? (
          <div class="empty">
            <p>No realms are available for this account.</p>
          </div>
        ) : (
          <div class="table-panel">
            <div class="table-toolbar">
              <div class="table-search">
                <input
                  type="search"
                  value={this.search}
                  aria-label="Search users"
                  placeholder="Search users"
                  oninput={(event: Event) => {
                    this.search = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              {!isGlobal ? (
                <div class="table-actions">
                  <button
                    class="button"
                    type="button"
                    onclick={() => {
                      this.resetAdd();
                      this.addOpen = true;
                      m.redraw();
                    }}
                  >
                    Add user
                  </button>
                </div>
              ) : null}
            </div>

            {this.loading || this.redirecting || !this.users ? (
              <div class="panel" aria-busy="true">
                <div class="skeleton skeleton-title"></div>
                <div class="skeleton"></div>
                <div class="skeleton skeleton-short"></div>
                <div class="skeleton"></div>
                <div class="skeleton skeleton-short"></div>
              </div>
            ) : this.users.length === 0 ? (
              <div class="empty">
                <p>{isGlobal ? 'No users exist yet.' : 'No users are members of this realm.'}</p>
              </div>
            ) : (
              <div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th class="table-icon-column" scope="col">
                        <span class="sr-only">User</span>
                      </th>
                      <th class="data-table-primary" scope="col">User</th>
                      <th scope="col">{isGlobal ? 'Home realm' : 'Membership'}</th>
                      {isGlobal ? <th scope="col">Realms</th> : null}
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.map((user: AnyUser) => {
                      const href = userHref(isGlobal, realmSlug, user.id);
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
                              {Icon(Users)}
                            </span>
                          </td>
                          <td class="data-table-primary">
                            <a
                              class="user-title"
                              href={appUrl(href)}
                              onclick={(event: MouseEvent) => {
                                event.preventDefault();
                                event.stopPropagation();
                                m.route.set(href);
                              }}
                            >
                              <strong>{user.display_name || user.username}</strong>
                            </a>
                            <span class="data-table-sub">{user.email || user.username}</span>
                            {user.email ? <span class="data-table-sub">{user.username}</span> : null}
                          </td>
                          {isGlobal ? (
                            <td data-label="Home realm">
                              {(user as AdminGlobalUser).home_realm_slug || 'None'}
                              {(user as AdminGlobalUser).is_system_admin ? (
                                <span class="data-table-status">System admin</span>
                              ) : null}
                            </td>
                          ) : (
                            <td data-label="Membership">
                              {relationshipLabel(user as AdminRealmUser)}
                              {(user as AdminRealmUser).roles.includes('realm-admin') ? (
                                <span class="data-table-status">Realm admin</span>
                              ) : null}
                              {(user as AdminRealmUser).is_system_admin ? (
                                <span class="data-table-status">System admin</span>
                              ) : null}
                            </td>
                          )}
                          {isGlobal ? (
                            <td data-label="Realms">{(user as AdminGlobalUser).membership_count}</td>
                          ) : null}
                          <td data-label="Status">
                            {isGlobal
                              ? globalStatusLabel(user as AdminGlobalUser)
                              : realmStatus(user as AdminRealmUser)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {visibleUsers.length === 0 ? (
                  <div class="empty">
                    <p>No users match this search.</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {this.addOpen && realmSlug ? (
          <Modal title="Add user" onClose={() => this.resetAdd()}>
            <form
              onsubmit={(event: Event) => {
                event.preventDefault();
                this.searchAdd();
              }}
            >
              <div class="form-field">
                <label class="field-label" for="add-user-identifier">
                  Email or username
                </label>
                <input
                  id="add-user-identifier"
                  class="field-control"
                  value={this.addIdentifier}
                  data-modal-autofocus
                  oninput={(event: Event) => {
                    this.addIdentifier = (event.target as HTMLInputElement).value;
                  }}
                />
              </div>
              <div class="modal-actions">
                <button
                  class="button-secondary"
                  type="button"
                  disabled={this.addPending}
                  onclick={() => this.resetAdd()}
                >
                  Cancel
                </button>
                <button class="button" type="submit" disabled={this.addPending}>
                  {this.addPending ? 'Searching' : 'Search'}
                </button>
              </div>
            </form>

            {this.addError ? (
              <div class="alert" role="alert">
                {this.addError.message}
              </div>
            ) : null}

            {this.addResult ? (
              <div>
                <div class="notice">
                  <strong>{this.addResult.display_name || this.addResult.username}</strong>
                  {this.addResult.email ? (
                    <span class="data-table-sub">{this.addResult.email}</span>
                  ) : null}
                  <span class="data-table-sub">{this.addResult.username}</span>
                  <span class="data-table-sub">{lookupReason(this.addResult)}</span>
                </div>
                <div class="modal-actions">
                  {this.addResult.can_add ? (
                    <button
                      class="button"
                      type="button"
                      disabled={this.addPending}
                      onclick={() => this.submitAdd()}
                    >
                      {this.addPending ? 'Adding user' : 'Add user'}
                    </button>
                  ) : (
                    <button
                      class="button-secondary"
                      type="button"
                      onclick={() =>
                        m.route.set(userHref(false, realmSlug, this.addResult.id))
                      }
                    >
                      Open user
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </Modal>
        ) : null}
      </div>
    );
  },
};
