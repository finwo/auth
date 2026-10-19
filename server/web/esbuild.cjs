#!/usr/bin/env node

// require('dotenv').config();
const cpy     = require('cpy').default;
const fs      = require('node:fs');
const esbuild = require('esbuild');
// const { nodeModulesPolyfillPlugin } = require('esbuild-plugins-node-modules-polyfill');

// const __dirname = dirname(fileURLToPath(import.meta.url));

const entryPoints = {
  'main': __dirname + '/src/main.ts',
};

const config = {
  format: 'iife', // immediately invoked function expression
  platform: 'browser',
  target: ['chrome108','firefox107'],
  mainFields: ['browser','module','main'],
  bundle: true,
  outdir: __dirname + '/dist',
  entryPoints: [
    ...Object.values(entryPoints),
    // __dirname+'/src/service-worker.ts',
  ],
  minify: false,
  // define,

  jsxFactory     : 'm',
  jsxFragment    : '"["',

  loader: {
    '.eot'  : 'dataurl',
    '.html' : 'text',
    '.wasm' : 'dataurl',
    '.png'  : 'dataurl',
    '.svg'  : 'dataurl',
    '.ttf'  : 'dataurl',
    '.woff' : 'dataurl',
    '.woff2': 'dataurl',
  },

  // Kept for when a Buffer is needed.
  // plugins: [
  //   nodeModulesPolyfillPlugin({
  //     globals: {
  //       Buffer: true
  //     }
  //   })
  // ],

};

const buildList = [];
const styles    = ['assets/global.css'];

esbuild
  .build(config)
  .then(async () => {

    try { fs.mkdirSync('./dist/assets'); } catch { /* empty */ }
    // Already rendered at every size by util/icon.js, so only copied here.
    await cpy(__dirname + '/src/assets/**/*', __dirname + '/dist/assets');
    for(const name of Object.keys(entryPoints)) {
      buildList.push(`${name}.js`);
      try {
        fs.statSync(config.outdir + `/${name}.css`);
        styles.push(`${name}.css`);
      } catch(e) {
        // Intentionally empty
      }
    }

    fs.writeFileSync(config.outdir + `/index.html`, `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0">
    <title>auth</title>
    ${styles.map(name => `<link rel="stylesheet" href="/${name}"/>`).join('\n    ')}
  </head>
  <body>
    ${buildList.map(name => `<script src="/${name}" defer></script>`).join('\n    ')}
  </body>
</html>
`);

    // const files = await new Promise(done => {
    //   exec(`find ${config.outdir} -type f`, (err,stdout, stderr) => {
    //     done(stdout
    //       .split('\n')
    //       .map(file => file.slice(config.outdir.length))
    //       .filter(file => file)
    //     );
    //   });
    // });
    // let sw = fs.readFileSync(`${config.outdir}/service-worker.js`, 'utf-8')
    //   .split('"--FILES--"').join(JSON.stringify(['/',...files]));
    // fs.writeFileSync(`${config.outdir}/service-worker.js`, sw);
  })
  // Without this a failed build still exits 0, and the image ships empty.
  .catch(e => { console.error(e); process.exit(1); });

