import m from 'mithril';
import { Admin, AdminCallback } from './screen/admin';
import { getBasePath } from './util/api';
import { applyTheme, getTheme } from './util/theme';

import './assets/admin.css';

const routes: m.RouteDefs = {
  '/': {
    render: () => m(Admin, {}),
  },
  '/sessions': {
    render: () => m(Admin, {}),
  },
  '/sessions/:realm': {
    render: () => m(Admin, {}),
  },
  '/callback': {
    render: () => m(AdminCallback, {}),
  },
};

applyTheme(getTheme());
m.route.prefix = getBasePath();
m.route(document.body, '/', routes);
