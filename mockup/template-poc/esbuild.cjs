#!/usr/bin/env node

const fs = require('node:fs');
const esbuild = require('esbuild');

const outdir = `${__dirname}/dist`;

esbuild
  .build({
    entryPoints: [`${__dirname}/src/main.ts`],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome108', 'firefox113', 'safari16.4'],
    sourcemap: true,
    minify: false,
    loader: {
      '.svg': 'dataurl',
    },
  })
  .then(() => {
    fs.copyFileSync(`${__dirname}/index.html`, `${outdir}/index.html`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
