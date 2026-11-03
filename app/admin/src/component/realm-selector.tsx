import m from 'mithril';
import { SelectMenu, type SelectMenuOption } from '@component/select-menu';
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
      const options: SelectMenuOption[] = [
        ...(allRealms ? [{ value: 'global', label: 'All realms' }] : []),
        ...(realms || []).map((realm) => ({ value: realm.slug, label: realm.display_name })),
      ];

      return (
        <div class="realm-select">
          <span>Realm</span>
          <SelectMenu
            autoWidth
            ariaLabel="Realm"
            value={selectedAll ? 'global' : selected?.slug || ''}
            options={options}
            onchange={attrs.onchange}
          />
        </div>
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
