import m from 'mithril';
import { PageHeader } from '@component/page-header';
import { Breadcrumb } from '../component/breadcrumb';
import { loadAdminGlobalUser } from '../util/auth';
import { appUrl, type AdminGlobalUserMembership, type AdminGlobalUserDetail } from '../util/api';
import { formatTime } from '@util/format';

interface GlobalUserAttrs {
  userId: string | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
}

function globalStatusLabel(user: AdminGlobalUserDetail['user']) {
  if (user.status !== 'active') return user.status === 'disabled' ? 'Disabled' : user.status;
  return 'Active';
}

export const GlobalUserPage: m.Component<GlobalUserAttrs> = {
  attrs: null as GlobalUserAttrs | null,
  loadedUser: null as string | null,
  loading: false,
  detail: null as AdminGlobalUserDetail | null,
  error: null as Error | null,

  oninit(this: any, vnode: m.Vnode<GlobalUserAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<GlobalUserAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { userId } = this.attrs;
    if (!userId || this.loadedUser === userId) return;
    this.loadedUser = userId;
    this.detail = null;
    this.error = null;
    this.load(userId);
  },

  async load(this: any, userId: string) {
    this.loading = true;
    this.error = null;
    m.redraw();

    try {
      const detail = await loadAdminGlobalUser(userId);
      if (this.loadedUser === userId) this.detail = detail;
    } catch (e: any) {
      if (this.loadedUser !== userId) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedUser === userId) this.loading = false;
      m.redraw();
    }
  },

  view(this: any) {
    const { realmsError, userId } = this.attrs;
    const detail = this.detail;
    const displayName = detail?.user.display_name || detail?.user.username || userId || 'User';

    return (
      <div>
        <Breadcrumb items={[{ label: 'Users', path: '/users/global' }, { label: displayName }]} />
        <PageHeader row title="User" subtitle="Global identity and realm memberships.">
          <a class="button-secondary" href={appUrl('/users/global')} onclick={(event: Event) => {
            event.preventDefault();
            m.route.set('/users/global');
          }}>
            All realms
          </a>
        </PageHeader>

        {realmsError ? (
          <div class="alert" role="alert">
            {realmsError.message}
          </div>
        ) : null}

        {this.error ? (
          <div class="alert" role="alert">
            <p>{this.error.message}</p>
            {userId ? (
              <button class="button-secondary" type="button" onclick={() => this.load(userId)}>
                Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {this.loading || !detail ? (
          <div class="panel" aria-busy="true">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton"></div>
            <div class="skeleton skeleton-short"></div>
          </div>
        ) : (
          <div class="client-stack">
            <section class="panel">
              <div class="panel-header">
                <h2>Account</h2>
              </div>
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
                  <dt>Home realm</dt>
                  <dd>{detail.user.home_realm_slug || 'None'}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{globalStatusLabel(detail.user)}</dd>
                </div>
                <div>
                  <dt>System admin</dt>
                  <dd>{detail.user.is_system_admin ? 'Yes' : 'No'}</dd>
                </div>
                <div>
                  <dt>Last login</dt>
                  <dd>{detail.user.last_login_at ? formatTime(detail.user.last_login_at) : 'Never'}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatTime(detail.user.created_at)}</dd>
                </div>
              </dl>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>Realm memberships</h2>
                  <p class="note">App access is managed in the realm where the user is a member.</p>
                </div>
              </div>
              {detail.memberships.length === 0 ? (
                <div class="empty">
                  <p>This user is not currently a member of any realm.</p>
                </div>
              ) : (
                <div class="data-table-wrap">
                  <table class="data-table data-table-static">
                    <thead>
                      <tr>
                        <th class="data-table-primary" scope="col">Realm</th>
                        <th scope="col">Relationship</th>
                        <th scope="col">Membership</th>
                        <th scope="col">Roles</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.memberships.map((membership: AdminGlobalUserMembership) => {
                        const href = `/users/${encodeURIComponent(membership.slug)}/${encodeURIComponent(detail.user.id)}`;
                        return (
                          <tr>
                            <td class="data-table-primary">
                              <strong>{membership.display_name}</strong>
                              <span class="data-table-sub">{membership.slug}</span>
                            </td>
                            <td data-label="Relationship">
                              {membership.relationship === 'home' ? 'Home' : 'Guest'}
                            </td>
                            <td data-label="Membership">
                              {membership.membership_status}
                              {membership.banned ? (
                                <span class="data-table-status">Banned</span>
                              ) : null}
                            </td>
                            <td data-label="Roles">
                              {membership.roles.length ? membership.roles.join(', ') : 'None'}
                            </td>
                            <td data-label="Action">
                              <a
                                class="button-secondary"
                                href={appUrl(href)}
                                onclick={(event: Event) => {
                                  event.preventDefault();
                                  m.route.set(href);
                                }}
                              >
                                Manage access
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    );
  },
};
