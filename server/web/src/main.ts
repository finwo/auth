import m from 'mithril';
import { Admin } from './screen/admin';
import { Login } from './screen/login';

const routes: m.RouteDefs = {
  '/oidc/:realm/:clientId/login': {
    render: (vnode) =>
      m(Login, {
        realm: (vnode.attrs as any).realm,
        clientId: (vnode.attrs as any).clientId,
      }),
  },
  '/oidc/:clientId/login': {
    render: (vnode) => m(Login, { clientId: (vnode.attrs as any).clientId }),
  },
  '/oidc/login': {
    render: () => m(Login, {}),
  },
  '/realms/:realm/admin': {
    render: (vnode) => m(Admin, { realm: (vnode.attrs as any).realm }),
  },
  '/admin': {
    render: () => m(Admin, {}),
  },
  '/': {
    onmatch: () => m.route.set('/oidc/login'),
  },
};

m.route.prefix = '';
m.route(document.body, '/oidc/login', routes);
