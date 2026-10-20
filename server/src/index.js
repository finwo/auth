import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import morgan from 'morgan';
import scandir from '@finwo/scandir';
import serveStatic from 'serve-static';

import { app } from './app.js';
import { loadConfig } from './lib/config.js';
import { closeRealms, initRealms } from './lib/realm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'web', 'dist');

const cfg = loadConfig();
app.config = cfg;

async function loadModules(dir) {
  const files = [];
  scandir.sync(dir, (file) => files.push(file), ['js'], false);
  files.sort();
  const modules = [];
  for (const file of files) {
    modules.push(await import(pathToFileURL(file).href));
  }
  return modules;
}

for (const mod of await loadModules(path.join(here, 'lib', 'http'))) {
  Object.assign(app, mod);
}

app.use(morgan('tiny'));
app.use(cors());
app.use(bodyParser.json({ limit: '16kb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '16kb' }));

const routes = [];
for (const mod of await loadModules(path.join(here, 'controller'))) {
  const exported = mod.default ?? mod.route ?? mod;
  for (const route of Array.isArray(exported) ? exported : [exported]) {
    if (!route) continue;
    if (route.mount) {
      app.use(route.mount, route.handler);
      continue;
    }
    if (!route.method || !route.path) continue;
    if (route.name) {
      app.manifest.push({
        method: route.method,
        path: route.path,
        name: route.name,
      });
    }
    routes.push(route);
  }
}

routes.sort((A, B) => {
  const aparts = A.path.split('/');
  const bparts = B.path.split('/');
  for (let i = 0; i < Math.min(aparts.length, bparts.length); i += 1) {
    if (aparts[i].startsWith(':') && !bparts[i].startsWith(':')) return 1;
    if (!aparts[i].startsWith(':') && bparts[i].startsWith(':')) return -1;
  }
  return bparts.length - aparts.length;
});

for (const route of routes) {
  app[route.method](route.path, async (req, res, ...args) => {
    try {
      const result = await route.handler(req, res, ...args);
      if (result instanceof app.HttpResponse) result.send(res);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof app.HttpError) {
        e.toResponse().send(res);
        return;
      }
      console.error(e);
      new app.HttpError(500, 'internal_error', 'Internal server error').toResponse().send(res);
    }
  });
}

const serve = serveStatic(dist, {
  index: ['index.htm', 'index.html'],
});

let indexContent = null;
try {
  indexContent = fs.readFileSync(path.join(dist, 'index.html'));
} catch {
  indexContent = null;
}

await initRealms(cfg);

const server = http.createServer((req, res) => {
  app(req, res, (err) => {
    if (err) {
      const status = err.status || err.statusCode || 500;
      const code = err.type === 'entity.parse.failed' ? 'invalid_json' : 'internal_error';
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code, message: err.message || 'Request failed' } }));
      return;
    }

    serve(req, res, () => {
      if (!indexContent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('frontend build missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(indexContent);
    });
  });
});

server.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`Listening on ${cfg.server.host}:${cfg.server.port}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  await closeRealms();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).finally(() => process.exit(0));
  });
}
