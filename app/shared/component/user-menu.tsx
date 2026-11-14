import { CircleUserRound, LogOut, Settings, Sun } from 'lucide';
import m from 'mithril';
import { themeLabel, type Theme } from '@util/theme';
import { Icon } from '@component/icon';
import './user-menu.css';

export interface AccountActionsAttrs {
  accountHref?: string;
  theme: Theme;
  onCycleTheme: () => void;
  onSignOut: () => void;
}

export interface UserMenuAttrs extends AccountActionsAttrs {
  name: string;
  meta: string;
}

export const AccountActions: m.Component<AccountActionsAttrs> = {
  view({ attrs }) {
    return (
      <div class="menu-list">
        {attrs.accountHref ? (
          <a class="menu-item" href={attrs.accountHref}>
            {Icon(Settings)}
            <span>Account settings</span>
          </a>
        ) : null}
        <button
          class="menu-item"
          type="button"
          aria-label={`Theme: ${themeLabel(attrs.theme)}`}
          onclick={attrs.onCycleTheme}
        >
          {Icon(Sun)}
          <span>Theme</span>
          <span class="menu-value">{themeLabel(attrs.theme)}</span>
        </button>
        <a
          class="menu-item"
          href="#"
          onclick={(event: Event) => {
            event.preventDefault();
            attrs.onSignOut();
          }}
        >
          {Icon(LogOut)}
          <span>Sign out</span>
        </a>
      </div>
    );
  },
};

export const UserMenu: m.Component<UserMenuAttrs> = {
  view({ attrs }) {
    return (
      <details
        class="menu user-menu"
        oncreate={({ dom }: any) => {
          const close = (event: Event) => {
            if (dom.open && !dom.contains(event.target as Node)) dom.open = false;
          };
          dom.closeOnOutsideClick = close;
          document.addEventListener('click', close);
        }}
        onremove={({ dom }: any) => {
          document.removeEventListener('click', dom.closeOnOutsideClick);
        }}
      >
        <summary class="menu-trigger" aria-label="Account menu">{Icon(CircleUserRound)}</summary>
        <div class="menu-panel">
          <div class="menu-heading">
            <span class="menu-heading-title">{attrs.name}</span>
            <span class="menu-heading-meta">{attrs.meta}</span>
          </div>
          <AccountActions
            accountHref={attrs.accountHref}
            theme={attrs.theme}
            onCycleTheme={attrs.onCycleTheme}
            onSignOut={attrs.onSignOut}
          />
        </div>
      </details>
    );
  },
};
