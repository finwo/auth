import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { packTar } from 'modern-tar';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const templatesRoot = path.join(root, 'templates');
const outputRoot = path.join(root, 'dist');
const archivesRoot = path.join(outputRoot, 'templates');

const overlayLabels = {
  system: 'System base',
  'acme-brand': 'Acme brand',
  'acme-holiday': 'Acme holiday',
};

function walk(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, relative));
    } else if (entry.isFile()) {
      files.push({ relative, full });
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function buildLayer(id, dir) {
  const files = walk(dir);

  const entries = files.map((file) => {
    const data = fs.readFileSync(file.full);
    return {
      header: {
        name: file.relative,
        size: data.byteLength,
        mode: 0o644,
        mtime: new Date(0),
        type: 'file',
      },
      body: new Uint8Array(data),
    };
  });

  const tar = await packTar(entries);
  const archive = gzipSync(Buffer.from(tar), { level: 9, mtime: 0 });
  const hash = digest(archive);
  const name = `${hash}.tar.gz`;
  fs.writeFileSync(path.join(archivesRoot, name), archive);

  return {
    id,
    label: overlayLabels[id] || id,
    digest: hash,
    url: `templates/${name}`,
  };
}

async function main() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(archivesRoot, { recursive: true });

  const base = await buildLayer('system', path.join(templatesRoot, 'system'));

  const overlaysRoot = path.join(templatesRoot, 'overlays');
  const overlays = [];
  for (const name of fs.readdirSync(overlaysRoot).sort()) {
    const dir = path.join(overlaysRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const layer = await buildLayer(name, dir);
    overlays.push(layer);
  }

  const manifest = {
    api: 1,
    generated_at: new Date().toISOString(),
    base,
    overlays,
  };

  fs.writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  for (const layer of [base, ...overlays]) {
    console.log(`${layer.id.padEnd(14)} ${layer.digest}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
