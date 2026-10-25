import m from 'mithril';
import type { AdminRealm } from '../util/api';

interface RealmSelectorAttrs {
  realms: AdminRealm[] | null;
  selected: AdminRealm | null;
  onchange: (slug: string) => void;
  allRealms?: boolean;
  selectedAll?: boolean;
}

export const RealmSelector: m.Component<RealmSelectorAttrs> = {
  view({ attrs }) {
    const { realms, selected, allRealms = false, selectedAll = false } = attrs;

    if ((realms && realms.length > 1) || allRealms) {
      return (
        <label class="realm-select">
          <span>Realm</span>
          <select
            value={selectedAll ? 'global' : selected?.slug || ''}
            onchange={(event: Event) => {
              attrs.onchange((event.target as HTMLSelectElement).value);
            }}
          >
            {allRealms ? <option value="global">All realms</option> : null}
            {(realms || []).map((realm) => (
              <option value={realm.slug}>{realm.display_name}</option>
            ))}
          </select>
        </label>
      );
    }

    if (selected) {
      return <span class="realm-current">{selected.display_name}</span>;
    }

    if (selectedAll) {
      return <span class="realm-current">All realms</span>;
    }

    return null;
  },
};
