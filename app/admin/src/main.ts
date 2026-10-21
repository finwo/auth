import m from 'mithril';
import { Admin, AdminCallback } from './screen/admin';
import { getBasePath } from './util/api';

import './assets/admin.css';

const routes: m.RouteDefs = {
  '/': {
    render: () => m(Admin, {}),
  },
  '/callback': {
    render: () => m(AdminCallback, {}),
  },
};

m.route.prefix = getBasePath();
m.route(document.body, '/', routes);
