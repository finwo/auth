#!/usr/bin/env node
// Tier A static CSS verification for the shared framework and its consumers.
// Dependency-free plain Node. Run from anywhere:
//   node tools/css-check/check.mjs --scope repo
//   node tools/css-check/check.mjs --scope app --app admin
// Exit code 0 = green (warnings allowed while the transition allow-list is
// populated), 1 = red.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO = path.resolve(import.meta.dirname, '..', '..');

// ---------------------------------------------------------------------------
// transition allow-list: files that are being phased out by the migration.
// While any of these exist, the no-copy guard runs warn-only, and token
// violations inside them are warnings. Empty the list to make both hard.
// ---------------------------------------------------------------------------
const TRANSITION_ALLOW = [
  'mockup/plain/global.css',
  'mockup/plain/select-menu.css',
];

const FRAMEWORK_CSS = 'app/shared/style/global.css';
const COMPONENT_CSS_DIR = 'app/shared/component';
const MOCKUP_DIR = 'mockup/plain';

// files the framework contract governs: the shared framework, its consumer
// stylesheets, the mockup pages, and this harness
const MIGRATION_PREFIXES = ['app/', `${MOCKUP_DIR}/`, 'tools/'];
// every source tree checked for plain-ASCII and code-comment hygiene
const SCAN_ROOTS = ['app', 'mockup', 'tools'];
const CSS_EXT = ['.css'];
const CODE_EXT = ['.css', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.html'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

// selectors from the old naming that must not gain new homes in mockup page
// style blocks; the rename targets are defined by the framework instead.
const OLD_NAME_PATTERNS = [
  /\.(?:data-table(?:-primary|-sub|-status|-static|-wrap)?|table-panel|table-toolbar|table-search|table-actions|action-button|modal-overlay|form-field|checkbox-row|client-breadcrumb|auth-link|link-button|consent-account-link|realm-select|domain-status(?:-dot)?|provider-status|session-badge|client-badge|host-name|host-added|table-icon(?:-column)?)(?![\w-])/g,
  /\.[\w-]+-row-action(?![\w-])/g,
  /\.[\w-]+-stack(?![\w-])/g,
];

// register of surfaces whose source still carries non-ASCII characters:
// any byte above 0x7F outside this list fails the build, entries that are
// already pure ASCII are reported obsolete, and the register must stay empty
const PREEXISTING_NON_ASCII = [];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rel(file) {
  return path.relative(REPO, file).split(path.sep).join('/');
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function listFiles(exts) {
  const out = [];
  for (const root of SCAN_ROOTS) {
    const dir = path.join(REPO, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir, [])) {
      if (exts.includes(path.extname(file))) out.push(file);
    }
  }
  return out.sort();
}

function scoped(files) {
  const base = files.filter((f) => MIGRATION_PREFIXES.some((p) => rel(f).startsWith(p)));
  if (SCOPE === 'repo') return base;
  const prefix = `app/${APP_NAME}/`;
  return base.filter((f) => {
    const r = rel(f);
    return r.startsWith(prefix) || r.startsWith('app/shared/');
  });
}

function allowed(r) {
  return TRANSITION_ALLOW.includes(r);
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}

// Minimal block parser: yields { selector, body, chain } for every style
// rule, where chain is the list of enclosing at-rule preludes.
function parseRules(text) {
  const clean = stripComments(text);
  const rules = [];
  const stack = [];
  let buf = '';
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      i += 1;
      let depth = 1;
      const start = i;
      while (i < clean.length && depth > 0) {
        if (clean[i] === '{') depth += 1;
        else if (clean[i] === '}') depth -= 1;
        i += 1;
      }
      const body = clean.slice(start, i - 1);
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        rules.push(...parseRules(body).map((r) => ({ ...r, chain: [...stack, ...r.chain] })));
        stack.pop();
      } else {
        rules.push({ selector: prelude, body, chain: [...stack] });
      }
      continue;
    }
    if (ch === ';') {
      // an at-rule statement such as an @layer order declaration
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return rules;
}

function classTokens(selector) {
  const names = [];
  const re = /\.([A-Za-z][A-Za-z0-9_-]*)/g;
  // ignore attribute-selector contents to avoid false class hits
  const plain = selector.replace(/\[[^\]]*\]/g, '');
  let m;
  while ((m = re.exec(plain))) names.push(m[1]);
  return names;
}

function hasTableClass(selector) {
  return /(^|[^-\w.])\.table(?![\w-])/.test(selector.replace(/\[[^\]]*\]/g, ''));
}

function hasCellCompound(selector) {
  // a compound selector mentioning a td/th element, or a table part class
  return /(^|[\s>+~])t[hd](?![\w-])/.test(selector) || hasTableClass(selector);
}

function decls(body) {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const idx = d.indexOf(':');
      return { prop: d.slice(0, idx).trim(), value: d.slice(idx + 1).trim() };
    });
}

// comments and string literals only; regex literals are not inspected
function htmlExtract(text) {
  const found = [];
  found.push(...text.match(/<!--[\s\S]*?-->/g) || []);
  found.push(...text.match(/<script[\s\S]*?<\/script>/gi) || []);
  return found;
}

function jsExtract(text) {
  return text.match(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
  ) || [];
}

function cssExtract(text) {
  return [...(text.match(/\/\*[\s\S]*?\*\//g) || []), ...(text.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g) || [])];
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

const errors = [];
const warningGroups = new Map();

function addError(line) {
  errors.push(line);
}

function addWarning(key, detail) {
  if (!warningGroups.has(key)) warningGroups.set(key, { count: 0, examples: [] });
  const g = warningGroups.get(key);
  g.count += 1;
  if (detail && g.examples.length < 3 && !g.examples.includes(detail)) g.examples.push(detail);
}

function report(file, guard, msg, hard) {
  const line = `${rel(file)} [${guard}] ${msg}`;
  if (hard) addError(line);
  else addWarning(line, '');
}

const args = process.argv.slice(2);
function flagValue(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const SCOPE = flagValue('--scope', 'repo');
const APP_NAME = flagValue('--app', SCOPE === 'repo' ? null : 'admin');

function main() {
  const cssFiles = scoped(listFiles(CSS_EXT));
  const allCode = listFiles(CODE_EXT);
  const codeFiles =
    SCOPE === 'repo'
      ? allCode
      : allCode.filter((f) => {
          const r = rel(f);
          return r.startsWith(`app/${APP_NAME}/`) || r.startsWith('app/shared/');
        });

  // ---- guard 1: static alignment rules -----------------------------------
  for (const file of cssFiles) {
    const r = rel(file);
    const hard = !allowed(r);
    for (const rule of parseRules(fs.readFileSync(file, 'utf8'))) {
      if (!hasCellCompound(rule.selector)) continue;
      const mentionsTable = hasTableClass(rule.selector);
      for (const d of decls(rule.body)) {
        const prop = d.prop.toLowerCase();
        const value = d.value.toLowerCase();
        const badDisplay = prop === 'display' && /flex|grid|inline-flex|inline-grid/.test(value);
        if (badDisplay || prop === 'min-height') {
          if (mentionsTable) {
            report(file, 'align', `cell rule "${rule.selector}" declares ${d.prop}: ${d.value}`, hard);
          }
        }
        if (prop === 'vertical-align' && value.replace(/!important/, '').trim() !== 'middle') {
          if (mentionsTable || /(^|[\s>+~])t[hd](?![\w-])/.test(rule.selector)) {
            report(file, 'align', `table cell rule "${rule.selector}" sets vertical-align: ${d.value} (only middle allowed)`, hard);
          }
        }
      }
    }
  }

  // ---- framework class inventory (for the no-copy guard) ------------------
  const frameworkClasses = new Set();
  const frameworkFiles = [path.join(REPO, FRAMEWORK_CSS), path.join(REPO, COMPONENT_CSS_DIR)];
  const collectFrom = (file) => {
    for (const rule of parseRules(fs.readFileSync(file, 'utf8'))) {
      for (const name of classTokens(rule.selector)) {
        // CUBE state classes are shared vocabulary, not redefinable blocks
        if (/^(?:is|has)-/.test(name)) continue;
        frameworkClasses.add(name);
      }
    }
  };
  const collectDir = (dir) => {
    for (const f of walk(dir, [])) if (f.endsWith('.css')) collectFrom(f);
  };
  if (fs.existsSync(frameworkFiles[0])) collectFrom(frameworkFiles[0]);
  if (fs.existsSync(frameworkFiles[1])) collectDir(frameworkFiles[1]);

  // consumers = css files that are not the framework files themselves
  const frameworkSet = new Set([
    rel(path.join(REPO, FRAMEWORK_CSS)),
    ...listIn(path.join(REPO, COMPONENT_CSS_DIR)),
  ]);
  function listIn(dir) {
    if (!fs.existsSync(dir)) return [];
    return walk(dir, []).filter((f) => f.endsWith('.css')).map(rel);
  }
  const consumers = cssFiles.filter((f) => !frameworkSet.has(rel(f)));

  // no-copy guard runs warn-only repo-wide while the allow-list is populated
  const allowAlive = TRANSITION_ALLOW.some((f) => fs.existsSync(path.join(REPO, f)));
  const noCopyHard = !allowAlive;
  for (const f of TRANSITION_ALLOW) {
    if (fs.existsSync(path.join(REPO, f))) {
      addWarning(`${f} [no-copy] transition allow-list entry still present`, noCopyHard ? 'must be deleted' : 'warn-only until deleted');
    }
  }

  // ---- guard 2: no-copy ----------------------------------------------------
  for (const file of consumers) {
    const r = rel(file);
    const text = fs.readFileSync(file, 'utf8');
    const selectors = [];
    for (const block of extractStyleBlocks(text, file)) {
      selectors.push(...parseRules(block).map((x) => x.selector));
    }
    if (r.endsWith('.css')) {
      for (const rule of parseRules(text)) selectors.push(rule.selector);
    }
    const redefined = new Set();
    for (const selector of selectors) {
      for (const name of classTokens(selector)) {
        if (frameworkClasses.has(name)) redefined.add(`.${name}`);
      }
    }
    if (redefined.size) {
      report(file, 'no-copy', `redefines framework class(es): ${[...redefined].sort().join(', ')}`, noCopyHard);
    }
  }

  // mockup page style blocks must not carry old-name selectors
  if (SCOPE === 'repo') {
    const htmlFiles = listFiles(['.html']).filter((f) => rel(f).startsWith(`${MOCKUP_DIR}/`));
    for (const file of htmlFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const hits = new Set();
      for (const block of extractStyleBlocks(text, file)) {
        for (const re of OLD_NAME_PATTERNS) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(block))) hits.add(m[0]);
        }
      }
      if (hits.size) {
        report(file, 'no-copy', `page style block targets old class(es): ${[...hits].sort().join(', ')}`, noCopyHard);
      }
    }
  }

  // ---- guard 3: tokens -----------------------------------------------------
  for (const file of cssFiles) {
    const r = rel(file);
    const isFramework = r === FRAMEWORK_CSS;
    const hard = !allowed(r);
    const text = fs.readFileSync(file, 'utf8');
    const rules = parseRules(stripComments(text));
    const hexHits = [];
    const mixHits = [];
    const impHits = [];
    for (const rule of rules) {
      const layerNames = new Set(
        rule.chain
          .filter((c) => /^@layer\s+[A-Za-z]/.test(c) && !c.includes(','))
          .map((c) => c.replace('@layer', '').replace('{', '').trim()),
      );
      const inTokenLayer = isFramework && (layerNames.has('tokens') || layerNames.has('themes'));
      const isHiddenTail = isFramework && rule.chain.length === 0 && rule.selector.replace(/\s/g, '') === '[hidden]';
      const oneLine = rule.selector.replace(/\s+/g, ' ');
      for (const d of decls(rule.body)) {
        const prop = d.prop;
        const value = d.value.replace(/\s+/g, ' ');
        if (prop.startsWith('--')) {
          // custom property definitions are the token channel: literal colors
          // are allowed there until the consumer sheets move into the layers
        } else if (/(^|[\s,;(])#[0-9a-fA-F]{3,8}\b/.test(value)) {
          if (!inTokenLayer) hexHits.push(`${prop}: ${value} (${oneLine})`);
        }
        if (/color-mix\(/i.test(value) && !/color-mix\(\s*in\s+oklch/i.test(value)) {
          mixHits.push(`${prop}: ${value} (${oneLine})`);
        }
        if (/!important/i.test(value) && !isHiddenTail) {
          impHits.push(`${prop}: ${value} (${oneLine})`);
        }
      }
    }
    for (const hit of dedupe(hexHits)) report(file, 'token', `hex literal outside the token layers: ${hit}`, hard);
    for (const hit of dedupe(mixHits)) report(file, 'token', `color-mix must mix in oklch: ${hit}`, hard);
    for (const hit of dedupe(impHits)) report(file, 'token', `!important outside the unlayered [hidden] tail: ${hit}`, hard);
  }

  // ---- guard 4: layers -----------------------------------------------------
  // order-statement uniqueness is checked across every stylesheet in the repo
  const orderStatements = [];
  for (const file of listFiles(CSS_EXT)) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /@layer\s+[^{;]+;/g;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      orderStatements.push({ file, line, text: m[0] });
    }
  }
  if (SCOPE === 'repo') {
    if (orderStatements.length !== 1) {
      errors.push(`layer: expected exactly 1 @layer order statement repo-wide, found ${orderStatements.length}`);
    }
    const fw = path.join(REPO, FRAMEWORK_CSS);
    const fwLine = orderStatements.find((s) => s.file === fw);
    if (orderStatements.length === 1 && fwLine && fwLine.line !== 1) {
      errors.push(`layer: the @layer order statement must be the first line of ${FRAMEWORK_CSS}, found on line ${fwLine.line}`);
    }
  } else if (orderStatements.some((s) => rel(s.file) !== FRAMEWORK_CSS)) {
    for (const s of orderStatements) {
      if (rel(s.file) !== FRAMEWORK_CSS) {
        errors.push(`${rel(s.file)} [layer] duplicate @layer order statement: ${s.text}`);
      }
    }
  }
  for (const file of cssFiles) {
    const r = rel(file);
    if (allowed(r) || r === FRAMEWORK_CSS) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /@layer\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      const names = m[1].split(',').map((n) => n.trim());
      const isComponent = r.startsWith(`${COMPONENT_CSS_DIR}/`);
      const permitted = isComponent ? ['components'] : ['apps', 'mockups'];
      for (const n of names) {
        if (!permitted.includes(n)) {
          errors.push(`${r} [layer] consumer stylesheet uses @layer ${n} (permitted: ${permitted.join('/')})`);
        }
      }
    }
  }
  // consumers without a layer wrapper: warn until the app sheets are moved
  if (allowAlive) {
    for (const file of consumers) {
      const r = rel(file);
      if (allowed(r)) continue;
      if (!r.startsWith('app/') && !r.startsWith(`${MOCKUP_DIR}/`)) continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (!/@layer\s+[\w-]+\s*\{/.test(text)) {
        addWarning(`${r} [layer] consumer stylesheet is unlayered`, 'transition: app sheets move into @layer apps');
      }
    }
  }

  // ---- guard 5: source hygiene --------------------------------------------
  const nonAscii = (buf) => {
    const hits = [];
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] > 0x7f) hits.push({ i, b: buf[i] });
    }
    return hits;
  };
  for (const file of codeFiles) {
    const r = rel(file);
    const buf = fs.readFileSync(file);
    const hits = nonAscii(buf);
    if (hits.length) {
      const detail = `${hits.length} byte(s), first 0x${hits[0].b.toString(16)} at offset ${hits[0].i}`;
      if (PREEXISTING_NON_ASCII.includes(r)) {
        addWarning(`${r} [hygiene] preexisting non-ASCII characters in user copy`, `transition: fix when this surface migrates (${detail})`);
      } else {
        addError(`${r} [hygiene] non-ASCII: ${detail}`);
      }
    } else if (PREEXISTING_NON_ASCII.includes(r)) {
      addWarning(`${r} [hygiene] register entry obsolete`, 'file is pure ASCII now; remove it from the register');
    }
    const text = buf.toString('latin1');
    const ext = path.extname(file);
    let snippets = [];
    if (ext === '.css') snippets = cssExtract(text);
    else if (ext === '.html') snippets = htmlExtract(text);
    else snippets = jsExtract(text);
    for (const s of snippets) {
      if (/\.(md|rst)\b/i.test(s) || /\bsection\s+\d/i.test(s) || /CSS[-_]FRAMEWORK/i.test(s) ||
          /\b(?:see|per|according to|follow(?:s|ing)?)\s+the\s+spec(?:ification)?\b/i.test(s)) {
        errors.push(`${r} [hygiene] document or spec reference inside code: ${s.slice(0, 60)}`);
        break;
      }
    }
    // class-name tokens
    const bad = [];
    if (ext === '.css') {
      for (const rule of parseRules(text)) {
        for (const name of classTokens(rule.selector)) {
          if (name.includes('__') || name.includes('--')) bad.push(`.${name}`);
        }
      }
    } else {
      const attr = /class(?:Name)?\s*[:=]\s*["']([^"']+)["']/g;
      let m;
      while ((m = attr.exec(text))) {
        for (const tok of m[1].split(/\s+/)) {
          if (tok.includes('__') || tok.includes('--')) bad.push(tok);
        }
      }
      const cl = /classList\.(?:add|remove|toggle)\(\s*["']([^"']+)["']/g;
      while ((m = cl.exec(text))) {
        for (const tok of m[1].split(/\s+/)) {
          if (tok.includes('__') || tok.includes('--')) bad.push(tok);
        }
      }
    }
    if (bad.length) {
      errors.push(`${r} [hygiene] class names with double-underscore or double-hyphen: ${[...new Set(bad)].join(', ')}`);
    }
  }

  // ---- summary --------------------------------------------------------------
  console.log(`css-check: scope=${SCOPE === 'repo' ? 'repo' : `app/${APP_NAME}`} files(css)=${cssFiles.length} files(code)=${codeFiles.length}`);
  let warnCount = 0;
  for (const [key, g] of warningGroups) {
    warnCount += g.count;
    const extra = g.examples.length ? `: ${g.examples.join('; ')}` : '';
    console.log(`  warn: ${key}${g.count > 1 ? ` (x${g.count})` : ''}${extra}`);
  }
  for (const e of errors) console.log(`  FAIL: ${e}`);
  console.log(`css-check: ${errors.length} error(s), ${warnCount} warning(s)`);
  console.log(`css-check: no-copy guard runs ${noCopyHard ? 'HARD (allow-list empty)' : 'warn-only (transition allow-list active)'}`);
  process.exit(errors.length ? 1 : 0);
}

function dedupe(list) {
  return [...new Set(list)];
}

function extractStyleBlocks(text, file) {
  if (!file.endsWith('.html')) return [];
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks;
}

main();
