import m from 'mithril';
import { Login } from './screen/login';

import './assets/login.css';

const routes: m.RouteDefs = {
  '/oidc/:clientId/login': {
    render: (vnode) => m(Login, { clientId: (vnode.attrs as any).clientId }),
  },
  '/oidc/:clientId/consent': {
    render: (vnode) => m(Login, { clientId: (vnode.attrs as any).clientId }),
  },
  '/oidc/login': {
    render: () => m(Login, {}),
  },
  '/oidc/consent': {
    render: () => m(Login, {}),
  },
};

m.route.prefix = '';
m.route(document.body, '/oidc/login', routes);
