import m from 'mithril';
import { applyTheme, getTheme } from '@util/theme';
import { Admin, AdminCallback } from './screen/admin';
import { getBasePath } from './util/api';

import '@style/global.css';
import './assets/admin.css';

const routes: m.RouteDefs = {
  '/': {
    render: () => m(Admin, {}),
  },
  '/realms': {
    render: () => m(Admin, {}),
  },
  '/sessions': {
    render: () => m(Admin, {}),
  },
  '/sessions/:realm': {
    render: () => m(Admin, {}),
  },
  '/clients': {
    render: () => m(Admin, {}),
  },
  '/clients/:realm': {
    render: () => m(Admin, {}),
  },
  '/clients/:realm/edit/:client': {
    render: () => m(Admin, {}),
  },
  '/users': {
    render: () => m(Admin, {}),
  },
  '/users/global': {
    render: () => m(Admin, {}),
  },
  '/users/global/:userId': {
    render: () => m(Admin, {}),
  },
  '/users/:realm': {
    render: () => m(Admin, {}),
  },
  '/users/:realm/:userId': {
    render: () => m(Admin, {}),
  },
  '/settings': {
    render: () => m(Admin, {}),
  },
  '/settings/:realm': {
    render: () => m(Admin, {}),
  },
  '/hosts': {
    render: () => m(Admin, {}),
  },
  '/hosts/:realm': {
    render: () => m(Admin, {}),
  },
  '/email-domains': {
    render: () => m(Admin, {}),
  },
  '/email-domains/:realm': {
    render: () => m(Admin, {}),
  },
  '/system-settings': {
    render: () => m(Admin, {}),
  },
  '/callback': {
    render: () => m(AdminCallback, {}),
  },
};

applyTheme(getTheme());
m.route.prefix = getBasePath();
m.route(document.body, '/', routes);
