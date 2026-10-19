import { HttpResponse } from './http-response.js';

export class HttpOk extends HttpResponse {
  constructor(body, headers = {}) {
    super(200, body, headers);
  }
}
