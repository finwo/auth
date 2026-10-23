import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const appsRoot = path.join(repoRoot, 'app');
const requireFromLogin = createRequire(path.join(appsRoot, 'login', 'package.json'));
const { packTar } = await import(pathToFileURL(requireFromLogin.resolve('modern-tar')).href);
const {
  Activity,
  Check,
  CircleAlert,
  CircleUserRound,
  Hexagon,
  Layers,
  LayoutGrid,
  LogOut,
  Package,
  Settings,
  Sun,
} = await import(pathToFileURL(requireFromLogin.resolve('lucide')).href);

const sharedTemplatesRoot = path.join(appsRoot, 'shared', 'template');
const outputRoot = path.join(repoRoot, 'dist', 'templates');

const icons = {
  activity: Activity,
  alert: CircleAlert,
  check: Check,
  hexagon: Hexagon,
  layers: Layers,
  logout: LogOut,
  overview: LayoutGrid,
  package: Package,
  settings: Settings,
  sun: Sun,
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

  const roots = [
    sharedTemplatesRoot,
    ...fs
      .readdirSync(appsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(appsRoot, entry.name, 'templates'))
      .filter((root) => fs.existsSync(root)),
  ];

  const files = new Map();
  for (const root of roots) {
    for (const file of walk(root)) {
      if (files.has(file.relative)) {
        throw new Error(`duplicate system template file: ${file.relative}`);
      }
      files.set(file.relative, file.data);
    }
  }

  for (const [name, nodes] of Object.entries(icons)) {
    const asset = `asset/${name}.svg`;
    if (files.has(asset)) {
      throw new Error(`duplicate system template asset: ${asset}`);
    }
    files.set(asset, Buffer.from(iconSvg(nodes)));
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
