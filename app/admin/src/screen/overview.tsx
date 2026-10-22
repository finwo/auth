import m from 'mithril';
import { PageHeader } from '@component/page-header';
import { appUrl, type AdminRealm, type UserInfo } from '../util/api';
import { getAdminTokens } from '../util/auth';

interface OverviewAttrs {
  user: UserInfo;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
}

function roleLabel(user: UserInfo) {
  return user.is_system_admin ? 'System administrator' : 'Realm administrator';
}

export const OverviewPage: m.Component<OverviewAttrs> = {
  view({ attrs }) {
    const { user, realms, realmsError } = attrs;
    const tokens = getAdminTokens();

    return (
      <div>
        <PageHeader
          title="Overview"
          subtitle="Provider summary and administration."
        />

        <div class="grid">
          <section class="panel">
            <h2>Account</h2>
            <dl class="details">
              <div>
                <dt>User</dt>
                <dd>{user.name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{user.email || 'Not set'}</dd>
              </div>
              <div>
                <dt>Username</dt>
                <dd>{user.preferred_username}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{roleLabel(user)}</dd>
              </div>
            </dl>
          </section>

          <section class="panel">
            <h2>Access</h2>
            <dl class="details">
              <div>
                <dt>Client</dt>
                <dd>admin</dd>
              </div>
              <div>
                <dt>Refresh</dt>
                <dd>Automatic</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{tokens?.scope || 'openid'}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>Active</dd>
              </div>
            </dl>
          </section>

          <section class="panel panel-wide">
            <h2>Administration</h2>
            {realmsError ? (
              <p class="note" role="alert">
                {realmsError.message}
              </p>
            ) : realms === null ? (
              <p class="note">Loading realms.</p>
            ) : realms.length === 0 ? (
              <p class="note">No realms are available for this account.</p>
            ) : (
              <ul class="realm-list">
                {realms.map((realm) => (
                  <li>
                    <a
                      class="realm-link"
                      href={appUrl(`/sessions/${encodeURIComponent(realm.slug)}`)}
                      onclick={(event: Event) => {
                        event.preventDefault();
                        m.route.set(`/sessions/${encodeURIComponent(realm.slug)}`);
                      }}
                    >
                      <span class="realm-name">{realm.display_name}</span>
                      <span class="realm-slug">{realm.slug}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    );
  },
};
