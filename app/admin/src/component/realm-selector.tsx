import m from 'mithril';
import type { AdminRealm } from '../util/api';

interface RealmSelectorAttrs {
  realms: AdminRealm[] | null;
  selected: AdminRealm | null;
  onchange: (slug: string) => void;
}

export const RealmSelector: m.Component<RealmSelectorAttrs> = {
  view({ attrs }) {
    const { realms, selected } = attrs;

    if (realms && realms.length > 1) {
      return (
        <label class="realm-select">
          <span>Realm</span>
          <select
            value={selected?.slug || ''}
            onchange={(event: Event) => {
              attrs.onchange((event.target as HTMLSelectElement).value);
            }}
          >
            {realms.map((realm) => (
              <option value={realm.slug}>{realm.display_name}</option>
            ))}
          </select>
        </label>
      );
    }

    if (selected) {
      return <span class="realm-current">{selected.display_name}</span>;
    }

    return null;
  },
};
