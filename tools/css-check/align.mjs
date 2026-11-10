#!/usr/bin/env node
// Table alignment gate: zero-size inline-block baseline probes, zero spread.
//
//   node tools/css-check/align.mjs
//   node tools/css-check/align.mjs --fixture tools/css-check/fixtures/negative-misaligned.html
//   node tools/css-check/align.mjs --url http://127.0.0.1:8080/index.html
//
// Options: --url, --fixture <file> (repeatable), --widths 1440,390,
//          --themes auto,light,dark, --chrome <binary>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');

function flagValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function flagAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

const CHROME = flagValue(
  '--chrome',
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
);
const WIDTHS = flagValue('--widths', '1440,390').split(',').map(Number);
const THEMES = flagValue('--themes', 'auto,light,dark').split(',');

function targetList() {
  const url = flagValue('--url', null);
  if (url) return [{ label: url, url, negative: false }];
  const fixtures = flagAll('--fixture');
  if (fixtures.length) {
    return fixtures.map((f) => {
      const full = path.resolve(f);
      return {
        label: path.basename(full),
        url: new URL(`file://${full}`).href,
        negative: path.basename(full).startsWith('negative-'),
      };
    });
  }
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => ({
      label: f,
      url: new URL(`file://${path.join(FIXTURE_DIR, f)}`).href,
      negative: f.startsWith('negative-'),
    }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPort(userDir, timeoutMs = 25000) {
  const file = path.join(userDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text.split('\n')[0].trim();
    }
    await sleep(100);
  }
  throw new Error('chrome did not write DevToolsActivePort');
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const eventWaiters = [];
  let nextId = 1;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.method})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
        const w = eventWaiters[i];
        if (w.method === msg.method) {
          eventWaiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    }
  });

  return new Promise((resolveInit, rejectInit) => {
    ws.addEventListener('error', () => rejectInit(new Error(`cdp websocket failed: ${wsUrl}`)));
    ws.addEventListener('open', () => {
      resolveInit({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        },
        waitEvent(method, timeoutMs = 20000) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
            eventWaiters.push({
              method,
              resolve: (msg) => {
                clearTimeout(timer);
                resolve(msg);
              },
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });
  });
}

function measurementExpression(theme) {
  return `
(function () {
  if (${JSON.stringify(theme)} === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
  }
  var Q = 64; // browser layout precision: multiples of 1/64 of a CSS pixel
  function q(v) { return Math.round(v * Q); }

  var out = {
    tables: 0, rows: 0, multiCells: 0, mode: 'none',
    maxSpreadGrid: 0, captions: 0, fail: []
  };

  function hasBlockChild(cell) {
    var kids = cell.children;
    for (var i = 0; i < kids.length; i += 1) {
      var d = window.getComputedStyle(kids[i]).display;
      if (d !== 'inline' && d !== 'inline-block' && d !== 'none') return true;
    }
    return false;
  }

  function lineBands(cell) {
    var range = document.createRange();
    range.selectNodeContents(cell);
    var rects = range.getClientRects();
    var sorted = [];
    for (var i = 0; i < rects.length; i += 1) {
      if (rects[i].height > 0) sorted.push(rects[i]);
    }
    sorted.sort(function (a, b) { return a.top - b.top; });
    var bands = 0;
    var bottom = -Infinity;
    for (var j = 0; j < sorted.length; j += 1) {
      if (sorted[j].top > bottom) { bands += 1; bottom = sorted[j].bottom; }
      else if (sorted[j].bottom > bottom) bottom = sorted[j].bottom;
    }
    return bands;
  }

  function probeBaseline(cell, where) {
    var probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;';
    cell.appendChild(probe);
    var rect = probe.getBoundingClientRect();
    cell.removeChild(probe);
    if (rect.width !== 0 || rect.height !== 0 || !isFinite(rect.bottom)) {
      out.fail.push(where + ': probe is not a zero-size inline-block');
      return null;
    }
    return rect.bottom;
  }

  var tables = document.querySelectorAll('table.table');
  out.tables = tables.length;
  if (!tables.length) {
    out.fail.push('no table.table found on the page');
    return JSON.stringify(out);
  }
  var tableMode = window.matchMedia('(min-width: 40em)').matches;
  out.mode = tableMode ? 'table' : 'card';

  for (var t = 0; t < tables.length; t += 1) {
    var table = tables[t];
    var at = 'table ' + (t + 1);
    var rows = table.querySelectorAll('tbody tr');
    if (!rows.length) {
      out.fail.push(at + ': no tbody rows (degenerate table)');
      continue;
    }

    if (tableMode) {
      var thead = table.querySelector('thead');
      if (!thead || window.getComputedStyle(thead).display === 'none') {
        out.fail.push(at + ': thead is not rendered in table mode');
      }
      for (var r = 0; r < rows.length; r += 1) {
        var cells = rows[r].querySelectorAll('td');
        var baselines = [];
        var where = at + ' row ' + (r + 1);
        for (var c = 0; c < cells.length; c += 1) {
          var cell = cells[c];
          var cs = window.getComputedStyle(cell);
          if (cs.display === 'none') continue;
          if (cs.display !== 'table-cell') {
            out.fail.push(where + ' cell ' + (c + 1) + ': display is "' + cs.display + '", expected table-cell');
          }
          var caption = window.getComputedStyle(cell, '::before').content;
          if (cell.hasAttribute('data-label') && caption && caption !== 'none' && caption !== 'normal') {
            out.fail.push(where + ' cell ' + (c + 1) + ': data-label caption still renders in table mode');
          }
          if (hasBlockChild(cell) || lineBands(cell) > 1) {
            out.multiCells += 1;
            continue;
          }
          var base = probeBaseline(cell, where + ' cell ' + (c + 1));
          if (base !== null) baselines.push(base);
        }
        out.rows += 1;
        if (baselines.length < 2) {
          out.fail.push(where + ': fewer than 2 measurable single-line cells (degenerate row)');
          continue;
        }
        var lo = Math.min.apply(null, baselines);
        var hi = Math.max.apply(null, baselines);
        var glo = q(lo);
        var ghi = q(hi);
        if (ghi - glo !== 0) {
          out.fail.push(where + ': baseline spread = ' + (ghi - glo) + '/64 across ' + baselines.length + ' single-line cells');
        }
        if (ghi - glo > out.maxSpreadGrid) {
          out.maxSpreadGrid = ghi - glo;
        }
      }
    } else {
      var thead2 = table.querySelector('thead');
      if (thead2 && window.getComputedStyle(thead2).display !== 'none') {
        out.fail.push(at + ': thead is visible in card mode');
      }
      for (var r2 = 0; r2 < rows.length; r2 += 1) {
        var cells2 = rows[r2].querySelectorAll('td');
        if (!cells2.length) {
          out.fail.push(at + ' row ' + (r2 + 1) + ': no cells to stack');
          continue;
        }
        out.rows += 1;
        var trDisplay = window.getComputedStyle(rows[r2]).display;
        if (trDisplay !== 'block') {
          out.fail.push(at + ' row ' + (r2 + 1) + ': tr display is "' + trDisplay + '", expected block');
        }
        var widths = [];
        var lastTop = -Infinity;
        for (var c2 = 0; c2 < cells2.length; c2 += 1) {
          var cell2 = cells2[c2];
          var cs2 = window.getComputedStyle(cell2);
          if (cs2.display !== 'block') {
            out.fail.push(at + ' row ' + (r2 + 1) + ' cell ' + (c2 + 1) + ': display is "' + cs2.display + '", expected block');
          }
          var rect2 = cell2.getBoundingClientRect();
          widths.push(q(rect2.width));
          if (rect2.top < lastTop) {
            out.fail.push(at + ' row ' + (r2 + 1) + ' cell ' + (c2 + 1) + ': not stacked below its sibling');
          }
          lastTop = rect2.top;
          var label = cell2.getAttribute('data-label');
          if (label !== null) {
            var before = window.getComputedStyle(cell2, '::before');
            if (before.display === 'none' || before.content !== JSON.stringify(label)) {
              out.fail.push(at + ' row ' + (r2 + 1) + ' cell ' + (c2 + 1) + ': data-label caption "' + label + '" does not render (content ' + before.content + ')');
            } else {
              out.captions += 1;
            }
          }
        }
        for (var k = 1; k < widths.length; k += 1) {
          if (widths[k] !== widths[0]) {
            out.fail.push(at + ' row ' + (r2 + 1) + ': cells are not one full-width column');
            break;
          }
        }
      }
    }
  }
  return JSON.stringify(out);
})()
`;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`align: chrome binary not found: ${CHROME}`);
    process.exit(1);
  }
  const targets = targetList();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-check-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let exitCode = 1;
  try {
    const port = await waitForPort(userDir);
    const cdpTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = cdpTargets.find((x) => x.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log(`align: probe gate (zero-size inline-block baseline, zero spread) widths=${WIDTHS.join(',')} themes=${THEMES.join(',')}`);

    let failures = 0;
    for (const target of targets) {
      for (const width of WIDTHS) {
        for (const theme of THEMES) {
          const scheme = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'no-preference';
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: width < 500,
          });
          await cdp.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: scheme }],
          });
          const loaded = cdp.waitEvent('Page.loadEventFired');
          await cdp.send('Page.navigate', { url: target.url });
          await loaded;
          await sleep(150);
          const evaluated = await cdp.send('Runtime.evaluate', {
            expression: measurementExpression(theme),
            returnByValue: true,
          });
          if (evaluated.exceptionDetails) {
            throw new Error(`page evaluation failed for ${target.label} at ${width}/${theme}`);
          }
          const m = JSON.parse(evaluated.result.value);
          const gateRed = m.fail.length > 0 || m.tables === 0 || m.rows === 0;

          const head = `${target.label}  ${String(width).padStart(4)} ${theme.padEnd(4)}`;
          const stats =
            m.mode === 'table'
              ? `mode=table tables=${m.tables} rows=${m.rows} multi-cells=${m.multiCells} max-baseline-spread=${m.maxSpreadGrid}/64`
              : `mode=card tables=${m.tables} rows=${m.rows} captions=${m.captions}`;

          if (target.negative && m.mode === 'table') {
            if (gateRed) {
              console.log(`  ${head}  RED-AS-EXPECTED  ${stats}`);
              for (const f of m.fail.slice(0, 3)) console.log(`      gate caught: ${f}`);
            } else {
              failures += 1;
              console.log(`  ${head}  FAIL  ${stats}`);
              console.log('      negative-control PASSED: the baseline gate is not measuring probes');
            }
          } else if (gateRed) {
            failures += 1;
            console.log(`  ${head}  FAIL  ${stats}`);
            for (const f of m.fail.slice(0, 5)) console.log(`      ${f}`);
          } else {
            console.log(`  ${head}  PASS  ${stats}`);
          }
        }
      }
    }

    if (failures) {
      console.log(`align: FAIL (${failures} failing combination(s))`);
      exitCode = 1;
    } else {
      console.log('align: PASS (all fixtures x widths x themes)');
      exitCode = 0;
    }
    cdp.close();
  } catch (err) {
    console.error(`align: ${err && err.message ? err.message : err}`);
    exitCode = 1;
  } finally {
    chrome.kill('SIGKILL');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      chrome.once('exit', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    try {
      fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // leftover temp profile is disposable
    }
  }
  process.exit(exitCode);
}

main();
