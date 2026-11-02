import m from 'mithril';
import { Nav, type NavItem } from '@component/nav';
import { AccountActions, type UserMenuAttrs } from '@component/user-menu';

export interface MobileNavToggleAttrs {
  expanded: boolean;
  onToggle: () => void;
}

export const MobileNavToggle: m.Component<MobileNavToggleAttrs> = {
  view({ attrs }) {
    const label = attrs.expanded ? 'Close navigation' : 'Open navigation';

    return (
      <button
        id="mobile-nav-toggle"
        class={`mobile-nav-toggle${attrs.expanded ? ' is-open' : ''}`}
        type="button"
        aria-controls="mobile-navigation"
        aria-expanded={attrs.expanded ? 'true' : 'false'}
        aria-label={label}
        onclick={attrs.onToggle}
      >
        <span class="mobile-nav-toggle-bars" aria-hidden="true"></span>
      </button>
    );
  },
};

export const MobileNavAccount: m.Component<UserMenuAttrs> = {
  view({ attrs }) {
    return (
      <section class="mobile-nav-account" aria-label="Account">
        <div class="user-summary">
          <span class="user-name">{attrs.name}</span>
          <span class="user-meta">{attrs.meta}</span>
        </div>
        <AccountActions
          accountHref={attrs.accountHref}
          theme={attrs.theme}
          onCycleTheme={attrs.onCycleTheme}
          onSignOut={attrs.onSignOut}
        />
      </section>
    );
  },
};

export interface MobileNavAttrs {
  label: string;
  ariaLabel: string;
  items: NavItem[];
  accountPanel?: m.Children;
  open: boolean;
  onClose: () => void;
}

export const MobileNav: m.Component<MobileNavAttrs> = {
  oncreate(this: any, vnode: m.Vnode<MobileNavAttrs>) {
    this.attrs = vnode.attrs;
    this.open = Boolean(vnode.attrs.open);
    this.applyState(this.open);
    this.onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.open) {
        this.attrs.onClose();
        m.redraw();
      }
    };
    window.addEventListener('keydown', this.onKeydown);
  },

  onupdate(this: any, vnode: m.Vnode<MobileNavAttrs>) {
    this.attrs = vnode.attrs;
    const open = Boolean(vnode.attrs.open);
    if (open === this.open) return;

    if (open) {
      this.focusBefore = document.activeElement;
    }

    this.applyState(open);

    if (!open) {
      (this.focusBefore as HTMLElement | null)?.focus?.();
      this.focusBefore = null;
    }
  },

  onremove(this: any) {
    window.removeEventListener('keydown', this.onKeydown);
    this.applyState(false);
  },

  applyState(this: any, open: boolean) {
    this.open = open;
    document.documentElement.classList.toggle('mobile-nav-open', open);

    const main = document.querySelector('.main') as HTMLElement | null;
    if (main) (main as any).inert = open;
  },

  view({ attrs }) {
    const items = attrs.items.map((item) => ({
      ...item,
      onclick: (event: Event) => {
        attrs.onClose();
        item.onclick?.(event);
      },
    }));

    return (
      <div
        id="mobile-navigation"
        class={`mobile-nav${attrs.open ? ' is-open' : ''}`}
        aria-hidden={attrs.open ? null : 'true'}
        onclick={(event: MouseEvent) => {
          const target = event.target as Element | null;
          if (!target?.closest('.nav-item')) {
            if (!target?.closest('.user-menu-item, button, a')) attrs.onClose();
          }
        }}
      >
        <Nav label={attrs.label} ariaLabel={attrs.ariaLabel} items={items} />
        {attrs.accountPanel ? (
          <>
            <div class="mobile-nav-divider" aria-hidden="true"></div>
            {attrs.accountPanel}
          </>
        ) : null}
      </div>
    );
  },
};
