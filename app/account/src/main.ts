import m from 'mithril';
import { Account, AccountCallback } from './screen/account';
import { getBasePath } from './util/api';

import '@style/global.css';
import './assets/account.css';

const routes: m.RouteDefs = {
  '/': {
    render: () => m(Account, {}),
  },
  '/security': {
    render: () => m(Account, {}),
  },
  '/apps': {
    render: () => m(Account, {}),
  },
  '/callback': {
    render: () => m(AccountCallback, {}),
  },
};

m.route.prefix = getBasePath();
m.route(document.body, '/', routes);
