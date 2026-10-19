import { HttpError } from '../../lib/http/http-error.js';

export default {
  method: 'post',
  path: '/api/v1/login/password',
  name: 'login.password',
  async handler() {
    throw new HttpError(501, 'not_implemented', 'Password sign-in is not implemented');
  },
};
