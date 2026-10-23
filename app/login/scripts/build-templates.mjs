import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { CircleAlert, CircleUserRound, Check } from 'lucide';
import { packTar } from 'modern-tar';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const repoRoot = path.resolve(appRoot, '../..');
const templatesRoot = path.join(appRoot, 'templates', 'system');
const outputRoot = path.join(appRoot, 'dist', 'templates');
const sharedAssets = path.join(repoRoot, 'app', 'shared', 'style', 'assets');

const icons = {
  alert: CircleAlert,
  check: Check,
  user: CircleUserRound,
};

function walk(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, relative));
    } else if (entry.isFile()) {
      files.push({ relative, data: fs.readFileSync(full) });
    }
  }
  return files;
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function iconSvg(nodes) {
  const body = nodes
    .map(([tag, attrs]) => {
      const values = Object.entries(attrs)
        .map(([name, value]) => `${name}="${escapeXml(value)}"`)
        .join(' ');
      return `<${tag} ${values}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
}

async function buildLayer(files) {
  const sorted = [...files].sort((left, right) => left.relative.localeCompare(right.relative));
  const entries = sorted.map((file) => ({
    header: {
      name: file.relative,
      size: file.data.byteLength,
      mode: 0o644,
      mtime: new Date(0),
      type: 'file',
    },
    body: new Uint8Array(file.data),
  }));

  const tar = await packTar(entries);
  const archive = gzipSync(Buffer.from(tar), { level: 9, mtime: 0 });
  const hash = digest(archive);
  const name = `${hash}.tar.gz`;
  fs.writeFileSync(path.join(outputRoot, name), archive);

  return {
    id: 'system',
    label: 'System base',
    digest: hash,
    url: `/app/templates/${name}`,
  };
}

async function main() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const files = new Map();
  for (const file of walk(templatesRoot)) {
    files.set(file.relative, file.data);
  }

  for (const [name, nodes] of Object.entries(icons)) {
    files.set(`asset/${name}.svg`, Buffer.from(iconSvg(nodes)));
  }

  for (const name of ['hex-grid-light.svg', 'hex-grid-dark.svg']) {
    files.set(`asset/${name}`, fs.readFileSync(path.join(sharedAssets, name)));
  }

  const base = await buildLayer(
    [...files.entries()].map(([relative, data]) => ({ relative, data }))
  );
  const manifest = {
    api: 1,
    generated_at: new Date().toISOString(),
    base,
    overlays: [],
  };

  fs.writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  console.log(`${base.id.padEnd(14)} ${base.digest}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
