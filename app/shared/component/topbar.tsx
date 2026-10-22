import { Hexagon } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';

interface TopbarAttrs {
  href: string;
  brandName?: string;
  label?: string;
  onclick?: (event: Event) => void;
}

export const Topbar: m.Component<TopbarAttrs> = {
  view({ attrs, children }) {
    return (
      <header class="topbar">
        <a
          class="brand"
          href={attrs.href}
          aria-label={attrs.label || attrs.brandName || 'Auth'}
          onclick={attrs.onclick}
        >
          {Icon(Hexagon, { class: 'brand-icon' })}
          <span class="brand-name">{attrs.brandName || 'Auth'}</span>
        </a>
        {children}
      </header>
    );
  },
};
