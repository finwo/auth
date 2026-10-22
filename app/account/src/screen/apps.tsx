import m from 'mithril';
import { PageHeader } from '@component/page-header';

export const AppsPage: m.Component = {
  view() {
    return (
      <div>
        <PageHeader
          title="Apps"
          subtitle="Applications with access to this account."
        />

        <div class="apps-stack">
          <section class="panel">
            <h2>Authorized apps</h2>
            <p class="note">App permission management arrives in a later slice.</p>
          </section>
        </div>
      </div>
    );
  },
};
