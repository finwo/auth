import m from 'mithril';
import { Login } from './screen/login';

const routes: m.RouteDefs = {
  '/realms/:realm/login': {
    render: (vnode) => m(Login, { realm: (vnode.attrs as any).realm }),
  },
  '/login': {
    render: () => m(Login, {}),
  },
  '/': {
    onmatch: () => m.route.set('/login'),
  },
};

m.route.prefix = '';
m.route(document.body, '/login', routes);
