import m from 'mithril';
import { Icon, type IconNode } from '@component/icon';

export interface NavItem {
  href: string;
  label: string;
  icon: IconNode;
  active?: boolean;
  onclick?: (event: Event) => void;
}

interface NavAttrs {
  label: string;
  ariaLabel: string;
  items: NavItem[];
}

export const Nav: m.Component<NavAttrs> = {
  view({ attrs }) {
    return (
      <nav class="nav" aria-label={attrs.ariaLabel}>
        <p class="nav-label">{attrs.label}</p>
        {attrs.items.map((item) => (
          <a
            class={`nav-item${item.active ? ' is-active' : ''}`}
            href={item.href}
            aria-current={item.active ? 'page' : undefined}
            onclick={item.onclick}
          >
            {Icon(item.icon)}
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    );
  },
};
