#!/usr/bin/env node

const fs = require('node:fs');
const esbuild = require('esbuild');

const entryPoints = {
  main: __dirname + '/src/main.ts',
};

const config = {
  format: 'iife',
  platform: 'browser',
  target: ['chrome108', 'firefox113', 'safari16.4'],
  mainFields: ['browser', 'module', 'main'],
  bundle: true,
  outdir: __dirname + '/dist',
  entryPoints: [...Object.values(entryPoints)],
  minify: false,
  alias: {
    '@util': __dirname + '/../shared/util',
    '@style': __dirname + '/../shared/style',
    '@api': __dirname + '/../shared/api',
    '@component': __dirname + '/../shared/component',
    '@template': __dirname + '/../shared/lib/template',
  },
  nodePaths: [__dirname + '/node_modules'],
  loader: {
    '.eot': 'dataurl',
    '.html': 'text',
    '.wasm': 'dataurl',
    '.png': 'dataurl',
    '.svg': 'dataurl',
    '.ttf': 'dataurl',
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
  },
};

const buildList = [];
const styles = [];

esbuild
  .build(config)
  .then(async () => {
    for (const name of Object.keys(entryPoints)) {
      buildList.push(`${name}.js`);
      try {
        fs.statSync(config.outdir + `/${name}.css`);
        styles.push(`${name}.css`);
      } catch (e) {
        // Intentionally empty
      }
    }

    fs.writeFileSync(
      config.outdir + `/index.html`,
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sign in</title>
    <script>
      (() => {
        try {
          const theme = localStorage.getItem('auth_theme');
          if (theme === 'light' || theme === 'dark') {
            document.documentElement.dataset.theme = theme;
          }
        } catch {}
      })();
    </script>
    ${styles.map((name) => `<style>/* ${name} */ ${fs.readFileSync(`${config.outdir}/${name}`, 'utf8')}</style>`).join('\n    ')}
  </head>
  <body>
    <div id="app">
      <main class="auth-page boot-page">
        <section class="auth-card boot-card">
          <h1>Sign in</h1>
          <p class="auth-note">Loading sign-in options.</p>
        </section>
      </main>
    </div>
    <noscript>
      <style>body { visibility: visible; }</style>
      <p class="boot-noscript">JavaScript is required to sign in.</p>
    </noscript>
    ${buildList.map((name) => `<script>/* ${name} */ ${fs.readFileSync(`${config.outdir}/${name}`, 'utf8')}</script>`).join('\n    ')}
  </body>
</html>
`
    );
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
