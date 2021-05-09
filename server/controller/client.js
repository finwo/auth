module.exports = [

  {
    method: 'get',
    path  : '/api/manifest.json',
    name  : 'manifest',
    async handler(req, res) {
      return new app.HttpOk(app.manifest);
    }
  },

  {
    method: 'get',
    path: '/api/client.js',
    async handler(req, res) {
      res.writeHead(200, {
        'content-type': 'application/javascript',
      });
      res.end(`;(factory => {
  const root  = ('object' === typeof module) ? module.exports : (new Function('return this;'))();
  root.api    = root.api || Object.create({});
  const fetch = root.fetch || require('node-fetch');
  factory(root.api, fetch);
})((api,fetch) => {
  const manifest = {
    baseuri: document.location.protocol + "//${req.headers.host}",
    routes : ${JSON.stringify(app.manifest)},
  };
  Object.assign(api, {
    token: null,
  }, {...api});
  api.__proto__.pathParams ||= (path, data) => {
    Object
      .keys(data||{})
      .sort((a,b)=>b.length-a.length)
      .forEach(key => {
        path = path
          .split(':'+key)
          .join(data[key])
      });
    return path;
  };
  manifest.routes.forEach(route => {
    const path = route.name.split('.');
    const last = path.pop();
    let   ref  = api.__proto__;
    for (const tok of path) {
      ref = ref[tok] ||= {};
    }
    ref[last] = async data => {
      const options  = {};
      options.method  = route.method.toUpperCase();
      options.headers = {};
      if (options.method !== 'GET') {
        options.headers['content-type'] = 'application/json';
        options.body                    = JSON.stringify(data);
      }
      if (api.token) {
        options.headers['authorization'] = 'Bearer ' + api.token;
      }
      return (await fetch(manifest.baseuri + api.pathParams(route.path,data), options)).json();
    };
  });
});
`);
    },
  },

];
