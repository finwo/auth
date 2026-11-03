import m from 'mithril';
import { SelectMenu, type SelectMenuOption } from '@component/select-menu';
import type { AdminRealm } from '../util/api';

interface SettingsTargetSelectorAttrs {
  realms: AdminRealm[] | null;
  selectedSystem: boolean;
  selectedRealm: AdminRealm | null;
  onchange: (target: string) => void;
}

export const SettingsTargetSelector: m.Component<SettingsTargetSelectorAttrs> = {
  view({ attrs }) {
    const { realms, selectedSystem, selectedRealm } = attrs;

    if (!realms || realms.length === 0) {
      if (selectedSystem) {
        return <span class="realm-current">System branding</span>;
      }
      if (selectedRealm) {
        return <span class="realm-current">{selectedRealm.display_name}</span>;
      }
      return null;
    }

    const options: SelectMenuOption[] = [
      { value: 'system', label: 'System branding' },
      ...realms.map((realm) => ({ value: realm.slug, label: realm.display_name })),
    ];

    return (
      <div class="realm-select">
        <span>Settings</span>
        <SelectMenu
          autoWidth
          ariaLabel="Settings"
          value={selectedSystem ? 'system' : selectedRealm?.slug || ''}
          options={options}
          onchange={attrs.onchange}
        />
      </div>
    );
  },
};
