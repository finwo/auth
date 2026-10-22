import m from 'mithril';

interface AppShellAttrs {
  topbar: m.Children;
  nav: m.Children;
}

export const AppShell: m.Component<AppShellAttrs> = {
  view({ attrs, children }) {
    return (
      <div class="app-shell">
        {attrs.topbar}
        <div class="app">
          <aside class="sidebar">{attrs.nav}</aside>
          <div class="main">
            <main class="content">{children}</main>
          </div>
        </div>
      </div>
    );
  },
};
