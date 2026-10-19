import m from 'mithril';
import { Chrome } from './component/layout';
import {Home} from './screen/home';
import {LoginPreTenant} from './screen/login-pre-tenant';

function wrap(screen: m.Component, needsUser = false): m.RouteResolver {
  return {
    // onmatch: () => (needsUser && !session.user ? auth.signIn() : undefined),
    render: () => m(Chrome, m(screen)),
  };
}

const routes: m.RouteDefs = {
  '/'     : wrap(Home)
  '/login': wrap(LoginPreTenant)
};

m.route.prefix = '#!';
m.route(document.body, '/', routes);

console.log('hi');
