import m from 'mithril';
import { PageHeader } from '@component/page-header';
import { Breadcrumb } from '../component/breadcrumb';
import { type UserInfo } from '../util/api';
import { getAdminTokens } from '../util/auth';

interface OverviewAttrs {
  user: UserInfo;
}

function roleLabel(user: UserInfo) {
  return user.is_system_admin ? 'System administrator' : 'Realm administrator';
}

export const OverviewPage: m.Component<OverviewAttrs> = {
  view({ attrs }) {
    const { user } = attrs;
    const tokens = getAdminTokens();

    return (
      <div>
        <Breadcrumb items={[{ label: 'Overview' }]} />
        <PageHeader title="Overview" subtitle="Provider summary and administration." />

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

        </div>
      </div>
    );
  },
};
