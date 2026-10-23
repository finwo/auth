const ROOT = 'auth-template-v1';
const ACTIVE_PREFIX = 'auth_template:active:';

export type StorageMode = 'opfs' | 'memory';

function validDigest(digest: string) {
  return /^[a-f0-9]{64}$/.test(digest);
}

function safeKey(value: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid cache key: ${value}`);
  }
  return value;
}

export class TemplateCache {
  private mode: StorageMode | null = null;
  private rootDirectory: FileSystemDirectoryHandle | null = null;
  private memoryLayers = new Map<string, Map<string, Uint8Array>>();
  private memoryComplete = new Set<string>();

  get storageMode() {
    return this.mode || 'unknown';
  }

  private async ensureMode() {
    if (this.mode) return;
    if (!navigator.storage?.getDirectory) {
      this.mode = 'memory';
      return;
    }

    try {
      const storage = await navigator.storage.getDirectory();
      this.rootDirectory = await storage.getDirectoryHandle(ROOT, { create: true });
      this.mode = 'opfs';
    } catch {
      this.mode = 'memory';
    }
  }

  private async root() {
    await this.ensureMode();
    if (this.mode !== 'opfs' || !this.rootDirectory) {
      throw new Error('OPFS is not available');
    }
    return this.rootDirectory;
  }

  private async layersRoot(create = true) {
    const root = await this.root();
    return root.getDirectoryHandle('layers', { create });
  }

  private async layerHandle(digest: string, create = false) {
    if (!validDigest(digest)) throw new Error(`Invalid layer digest: ${digest}`);
    const layers = await this.layersRoot(create);
    return layers.getDirectoryHandle(digest, { create });
  }

  async hasLayer(digest: string) {
    if (!validDigest(digest)) return false;
    await this.ensureMode();
    if (this.mode === 'memory') return this.memoryComplete.has(digest);

    try {
      const dir = await this.layerHandle(digest);
      await dir.getFileHandle('_complete');
      return true;
    } catch {
      return false;
    }
  }

  async prepareLayer(digest: string) {
    if (!validDigest(digest)) throw new Error(`Invalid layer digest: ${digest}`);
    await this.ensureMode();

    if (this.mode === 'memory') {
      this.memoryComplete.delete(digest);
      this.memoryLayers.set(digest, new Map());
      return;
    }

    const layers = await this.layersRoot(true);
    try {
      await layers.removeEntry(digest, { recursive: true });
    } catch {}
    await layers.getDirectoryHandle(digest, { create: true });
  }

  async writeFile(digest: string, path: string, data: Uint8Array) {
    if (!validDigest(digest)) throw new Error(`Invalid layer digest: ${digest}`);
    await this.ensureMode();

    if (this.mode === 'memory') {
      const layer = this.memoryLayers.get(digest);
      if (!layer) throw new Error(`Layer not prepared: ${digest}`);
      layer.set(path, data);
      return;
    }

    const parts = path.split('/');
    const filename = parts.pop();
    if (!filename) throw new Error(`Invalid file path: ${path}`);

    let dir = await this.layerHandle(digest);
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const file = await dir.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async finishLayer(digest: string, metadata: Record<string, unknown> = {}) {
    await this.ensureMode();
    if (this.mode === 'memory') {
      this.memoryComplete.add(digest);
      return;
    }

    const dir = await this.layerHandle(digest);
    const file = await dir.getFileHandle('_complete', { create: true });
    const writable = await file.createWritable();
    await writable.write(
      new TextEncoder().encode(
        JSON.stringify({ digest, completed_at: new Date().toISOString(), ...metadata })
      )
    );
    await writable.close();
  }

  async removeLayer(digest: string) {
    if (!validDigest(digest)) return;
    await this.ensureMode();
    if (this.mode === 'memory') {
      this.memoryLayers.delete(digest);
      this.memoryComplete.delete(digest);
      return;
    }

    try {
      const layers = await this.layersRoot(true);
      await layers.removeEntry(digest, { recursive: true });
    } catch {}
  }

  async readLayer(digest: string) {
    await this.ensureMode();
    if (this.mode === 'memory') {
      const layer = this.memoryLayers.get(digest);
      if (!layer) throw new Error(`Layer not found: ${digest}`);
      return new Map(layer);
    }

    const files = new Map<string, Uint8Array>();
    const dir = await this.layerHandle(digest);

    const walk = async (handle: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, child] of handle.entries()) {
        if (!prefix && name === '_complete') continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') {
          await walk(child as FileSystemDirectoryHandle, path);
        } else {
          const file = await (child as FileSystemFileHandle).getFile();
          files.set(path, new Uint8Array(await file.arrayBuffer()));
        }
      }
    };

    await walk(dir, '');
    return files;
  }

  getActive(scope: string) {
    try {
      const content = localStorage.getItem(`${ACTIVE_PREFIX}${safeKey(scope)}`);
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  setActive(scope: string, value: unknown) {
    try {
      localStorage.setItem(`${ACTIVE_PREFIX}${safeKey(scope)}`, JSON.stringify(value));
    } catch {}
  }

  clearActive(scope: string) {
    try {
      localStorage.removeItem(`${ACTIVE_PREFIX}${safeKey(scope)}`);
    } catch {}
  }
}

export async function withLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) return callback();
  return navigator.locks.request(name, callback);
}
