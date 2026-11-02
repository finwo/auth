import m from 'mithril';
import { Nav, type NavItem } from '@component/nav';
import { MobileNav } from '@component/mobile-nav';

interface AppShellAttrs {
  topbar: m.Children;
  navLabel: string;
  navAriaLabel: string;
  navItems: NavItem[];
  accountPanel?: m.Children;
  mobileNavOpen: boolean;
  onMobileNavClose: () => void;
}

export const AppShell: m.Component<AppShellAttrs> = {
  view({ attrs, children }) {
    return (
      <div class="app-shell">
        {attrs.topbar}
        <div class="app">
          <aside class="sidebar">
            <Nav
              label={attrs.navLabel}
              ariaLabel={attrs.navAriaLabel}
              items={attrs.navItems}
            />
          </aside>
          <div class="main">
            <main class="content">{children}</main>
          </div>
        </div>
        <MobileNav
          label={attrs.navLabel}
          ariaLabel={attrs.navAriaLabel}
          items={attrs.navItems}
          accountPanel={attrs.accountPanel}
          open={attrs.mobileNavOpen}
          onClose={attrs.onMobileNavClose}
        />
      </div>
    );
  },
};
