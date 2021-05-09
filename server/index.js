const bodyParser  = require('body-parser');
const cors        = require('cors');
const fs          = require('fs');
const http        = require('http');
const morgan      = require('morgan');
const scandir     = require('@finwo/scandir');
const Sequelize   = require('sequelize');
const serveStatic = require('serve-static');

// Initialize app
const Router     = require('router');
global.app       = new Router();
app.manifest     = [];
app.history      = [];
app.config       = require('rc')('fauth', require('./config'));

// Pre-compile regexes
app.regex = {
  email: /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
};

// Initialize common responses
scandir.sync(`${__dirname}/lib/http`, response => Object.assign(app,response), ['js'], true);

// Initialize database
app.db = new Sequelize(app.config.db);
scandir.sync(`${__dirname}/model`, factory => factory(app.db), ['js'], true);
app.db.sync({ alter: true });

// Load middleware
app.use(morgan('tiny'));
app.use(cors());
app.use(bodyParser.json());

// Fetch all routes
const routes = [];
scandir.sync(`${__dirname}/controller`, function logRoute(route) {
  if (Array.isArray(route)) return route.map(logRoute);
  if (route.name) {
    app.manifest.push({
      method: route.method,
      path  : route.path,
      name  : route.name,
    });
  }
  routes.push(route);
}, ['js'], true);

// Order routes by specificness (matters in our router)
routes.sort((A, B) => {
  const aparts = A.path.split('/');
  const bparts = B.path.split('/');
  for(let i=0; i<Math.min(aparts.length,bparts.length); i++) {
    if (
      (aparts[i].substr(0,1) === ':') &&
      (bparts[i].substr(0,1) !== ':')
    ) {
      return 1;
    }
    if (
      (aparts[i].substr(0,1) !== ':') &&
      (bparts[i].substr(0,1) === ':')
    ) {
      return -1;
    }
  }
  return bparts.length - aparts.length;
});

// Register all routes
for(const route of routes) {
  app[route.method](route.path, async (req, res, ...args) => {
    const result = await route.handler(req, res, ...args);
    if (result instanceof app.HttpResponse) result.send(req, res);
  });
}

// Setup static router
const serve = serveStatic('public', {
  index: [
    'index.htm',
    'index.html',
  ],
});

// Setup server & start listening
http.createServer((req, res) => {
  const indexContent = fs.readFileSync(`${__dirname}/public/index.html`);
  app(req, res, () => {
    serve(req, res, () => {
      res.setHeader('content-type', 'text/html');
      res.end(indexContent);
    });
  });
}).listen(parseInt(app.config.port), err => {
  if (err) throw err;
  console.log(`Listening on :${app.config.port}`);
});
