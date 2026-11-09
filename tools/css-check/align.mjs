#!/usr/bin/env node
// Tier B table-alignment proof. Renders a page in system Google Chrome
// (headless, driven over CDP with built-in fetch + WebSocket, no npm deps),
// then measures the vertical center of each table cell's first inline content
// per row. In real-table mode the spread of centers within a row must stay
// under the threshold; in stacked mode every cell must be a single full-width
// column, where centering is trivially correct.
//
//   node tools/css-check/align.mjs
//   node tools/css-check/align.mjs --url http://127.0.0.1:8080/index.html
//
// Options: --url, --widths 390,1440, --themes auto,light,dark,
//          --threshold 0.5, --chrome <binary>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const REPO = path.resolve(import.meta.dirname, '..', '..');

function flagValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const CHROME = flagValue(
  '--chrome',
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
);
const TARGET_URL = flagValue(
  '--url',
  new URL('./fixtures/email-domains.html', import.meta.url).href,
);
const WIDTHS = flagValue('--widths', '390,1440').split(',').map(Number);
const THEMES = flagValue('--themes', 'auto,light,dark').split(',');
const THRESHOLD = Number(flagValue('--threshold', '0.5'));

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

// evaluated inside the page: applies the theme and measures every table.table
const MEASURE = (theme) => `
(function () {
  var theme = ${JSON.stringify(theme)};
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function baselineOf(cell) {
    // a zero-size inline-block with vertical-align baseline places its border
    // box top exactly on the line's baseline without affecting layout
    var probe = document.createElement('span');
    probe.style.display = 'inline-block';
    probe.style.width = '0px';
    probe.style.height = '0px';
    probe.style.verticalAlign = 'baseline';
    cell.appendChild(probe);
    var y = probe.getBoundingClientRect().top;
    cell.removeChild(probe);
    return y;
  }

  function contentHeight(cell) {
    var range = document.createRange();
    range.selectNodeContents(cell);
    var rects = range.getClientRects();
    var top = Infinity;
    var bottom = -Infinity;
    for (var q = 0; q < rects.length; q += 1) {
      if (rects[q].height === 0) continue;
      if (rects[q].top < top) top = rects[q].top;
      if (rects[q].bottom > bottom) bottom = rects[q].bottom;
    }
    return bottom === -Infinity ? 0 : bottom - top;
  }

  var result = { tables: 0, mode: 'none', rows: 0, maxSpread: 0, stackedOk: true, wrapped: 0 };
  var tables = document.querySelectorAll('table.table');
  result.tables = tables.length;
  // one-line invariant: a .status or .button-inline that wraps onto two line
  // fragments splits into multiple client rects; centering math cannot see it,
  // so flag every wrapped chip in table mode
  var firstCell = document.querySelector('table.table td');
  if (firstCell && window.getComputedStyle(firstCell).display === 'table-cell') {
    var chips = document.querySelectorAll('table.table .status, table.table .button-inline');
    for (var z = 0; z < chips.length; z += 1) {
      var chipRects = chips[z].getClientRects();
      var fragments = 0;
      for (var y = 0; y < chipRects.length; y += 1) {
        if (chipRects[y].height > 0) fragments += 1;
      }
      if (fragments > 1) result.wrapped += 1;
    }
  }
  for (var t = 0; t < tables.length; t += 1) {
    var rows = tables[t].querySelectorAll('tbody tr');
    for (var r = 0; r < rows.length; r += 1) {
      var cells = rows[r].querySelectorAll('td');
      if (!cells.length) continue;
      result.rows += 1;
      var display = window.getComputedStyle(cells[0]).display;
      if (display === 'table-cell') {
        result.mode = 'table';
        var centers = [];
        for (var c = 0; c < cells.length; c += 1) {
          if (!cells[c].getBoundingClientRect().height) continue;
          var lh = parseFloat(window.getComputedStyle(cells[c]).lineHeight) || 0;
          var h = contentHeight(cells[c]);
          // single-line cells must share one baseline; multi-line cells center
          // their content box on the row centerline instead
          if (lh > 0 && h <= lh * 1.5) {
            centers.push(baselineOf(cells[c]));
          } else {
            centers.push(cells[c].getBoundingClientRect().top + cells[c].getBoundingClientRect().height / 2);
          }
        }
        if (centers.length > 1) {
          var spread = Math.max.apply(null, centers) - Math.min.apply(null, centers);
          if (spread > result.maxSpread) result.maxSpread = spread;
        }
      } else {
        if (result.mode !== 'table') result.mode = 'stacked';
        var widest = 0;
        for (var k = 0; k < cells.length; k += 1) {
          var cs = window.getComputedStyle(cells[k]);
          if (cs.display !== 'block') result.stackedOk = false;
          var w = cells[k].getBoundingClientRect().width;
          if (w > widest) widest = w;
        }
        for (var j = 0; j < cells.length; j += 1) {
          if (cells[j].getBoundingClientRect().width < widest - 2) result.stackedOk = false;
        }
      }
    }
  }
  return JSON.stringify(result);
})()
`;

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`align: chrome binary not found: ${CHROME}`);
    process.exit(1);
  }
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
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log(`align: target ${TARGET_URL}`);
    console.log(`align: threshold ${THRESHOLD}px widths=${WIDTHS.join(',')} themes=${THEMES.join(',')}`);

    let failures = 0;
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
        await cdp.send('Page.navigate', { url: TARGET_URL });
        await loaded;
        await sleep(150);
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: MEASURE(theme),
          returnByValue: true,
        });
        if (evaluated.exceptionDetails) {
          throw new Error(`page evaluation failed at ${width}/${theme}`);
        }
        const m = JSON.parse(evaluated.result.value);

        let ok = m.tables > 0 && m.rows > 0;
        let detail = '';
        if (m.mode === 'table') {
          ok = ok && m.maxSpread < THRESHOLD && m.wrapped === 0;
          detail = `mode=table rows=${m.rows} max-center-spread=${m.maxSpread.toFixed(3)}px (limit ${THRESHOLD}px) wrapped-chips=${m.wrapped}`;
        } else if (m.mode === 'stacked') {
          ok = ok && m.stackedOk;
          detail = `mode=stacked rows=${m.rows} single-column=${m.stackedOk ? 'yes' : 'NO'}`;
        } else {
          ok = false;
          detail = 'no table.table rendered';
        }
        if (!ok) failures += 1;
        console.log(`  ${String(width).padStart(4)}px ${theme.padEnd(4)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`);
      }
    }

    if (failures) {
      console.log(`align: FAIL (${failures} combination(s) over threshold)`);
      exitCode = 1;
    } else {
      console.log('align: PASS (all widths x themes)');
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
