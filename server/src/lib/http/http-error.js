import { HttpResponse } from './http-response.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toResponse() {
    return new HttpResponse(this.status, {
      error: {
        code: this.code,
        message: this.message,
      },
    });
  }
}
