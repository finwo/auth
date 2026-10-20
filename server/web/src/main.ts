import m from 'mithril';
import { Admin } from './screen/admin';
import { Login } from './screen/login';

const routes: m.RouteDefs = {
  '/realms/:realm/login': {
    render: (vnode) => m(Login, { realm: (vnode.attrs as any).realm }),
  },
  '/realms/:realm/admin': {
    render: (vnode) => m(Admin, { realm: (vnode.attrs as any).realm }),
  },
  '/login': {
    render: () => m(Login, {}),
  },
  '/admin': {
    render: () => m(Admin, {}),
  },
  '/': {
    onmatch: () => m.route.set('/login'),
  },
};

m.route.prefix = '';
m.route(document.body, '/login', routes);
