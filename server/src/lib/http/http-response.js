export class HttpResponse {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  send(res) {
    if (this.body === undefined) {
      res.writeHead(this.status, this.headers);
      res.end();
      return;
    }

    const isText = typeof this.body === 'string';
    res.writeHead(this.status, {
      'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      ...this.headers,
    });
    res.end(isText ? this.body : JSON.stringify(this.body));
  }
}
