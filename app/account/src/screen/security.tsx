import { FileKey, KeyRound, Monitor, ShieldCheck, Smartphone } from 'lucide';
import m from 'mithril';
import { Icon, type IconNode } from '@component/icon';
import { PageHeader } from '@component/page-header';

function PanelHeading(icon: IconNode, title: string) {
  return (
    <div class="panel-heading">
      {Icon(icon)}
      <h2>{title}</h2>
    </div>
  );
}

export const SecurityPage: m.Component = {
  view() {
    return (
      <div>
        <PageHeader
          title="Security"
          subtitle="Manage how you sign in and where this account is active."
        />

        <div class="security-stack">
          <section class="panel">
            {PanelHeading(KeyRound, 'Password')}
            <p class="note">Password management arrives in a later slice.</p>
          </section>

          <section class="panel">
            {PanelHeading(Smartphone, 'OTP app')}
            <p class="note">Authenticator apps are not available yet.</p>
          </section>

          <section class="panel">
            {PanelHeading(ShieldCheck, 'Security keys')}
            <p class="note">Security keys and YubiKeys are not available yet.</p>
          </section>

          <section class="panel">
            {PanelHeading(FileKey, 'Recovery codes')}
            <p class="note">Recovery codes are not available yet.</p>
          </section>

          <section class="panel">
            {PanelHeading(Monitor, 'Sessions')}
            <div class="surface-row">
              {Icon(Monitor)}
              <span>
                <strong>Current session</strong>
                <span>account · This device · Active</span>
              </span>
              <span class="status">Read-only</span>
            </div>
            <p class="note">Session revocation arrives in a later slice.</p>
          </section>
        </div>
      </div>
    );
  },
};
