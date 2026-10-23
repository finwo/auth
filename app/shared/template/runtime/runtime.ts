import morphdom from 'morphdom';
import { TemplateAssets } from './assets';
import { TemplateCache, withLock } from './cache';
import { loadTemplateSet } from './layers';
import { TemplateRenderer } from './render';
import type {
  LogFn,
  LogKind,
  TemplateManifest,
  TemplateSet,
} from './types';

export interface TemplateRuntimeOptions {
  root: HTMLElement;
  manifestUrl: string;
  scope: string;
  log?: LogFn;
}

export class TemplateRuntime {
  private cache = new TemplateCache();
  private assets: TemplateAssets | null = null;
  private renderer: TemplateRenderer | null = null;
  private templates: TemplateSet | null = null;
  private root: HTMLElement;
  private manifestUrl: string;
  private scope: string;
  private log: LogFn;

  constructor(options: TemplateRuntimeOptions) {
    this.root = options.root;
    this.manifestUrl = options.manifestUrl;
    this.scope = options.scope;
    this.log = options.log || (() => {});
  }

  get storageMode() {
    return this.cache.storageMode;
  }

  get compositeDigest() {
    return this.templates?.compositeDigest || null;
  }

  private async manifest() {
    this.log('network', 'manifest: loading');
    const response = await fetch(this.manifestUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Template manifest request failed with ${response.status}`);
    }

    const value = (await response.json()) as TemplateManifest;
    if (!value || value.api !== 1 || !value.base) {
      throw new Error('Template manifest is invalid');
    }
    return value;
  }

  async install() {
    const manifest = await this.manifest();
    const sources = [manifest.base, ...(manifest.overlays || [])];

    const templates = await withLock(`auth-template-install:${this.scope}`, () =>
      loadTemplateSet(sources, this.cache, this.log)
    );

    const assets = new TemplateAssets(templates);
    const renderer = new TemplateRenderer(templates, assets);
    const previous = this.assets;

    this.templates = templates;
    this.assets = assets;
    this.renderer = renderer;
    previous?.dispose();

    this.cache.setActive(this.scope, {
      digest: templates.compositeDigest,
      layers: sources.map((layer) => ({ id: layer.id, digest: layer.digest })),
    });

    this.log('info', `active composite ${templates.compositeDigest.slice(0, 12)}`);
    if (this.cache.storageMode === 'memory') {
      this.log('info', 'OPFS unavailable; using the in-memory layer cache');
    }
  }

  render(page: string, data: Record<string, unknown>) {
    if (!this.renderer) throw new Error('Template runtime is not installed');

    const html = this.renderer.render(page, data);
    const next = document.createElement('div');
    next.innerHTML = html;
    morphdom(this.root, next, { childrenOnly: true });
  }

  async stylesReady() {
    if (this.assets) await this.assets.stylesReady();
  }

  logEvent(kind: LogKind, message: string) {
    this.log(kind, message);
  }

  dispose() {
    this.assets?.dispose();
    this.assets = null;
    this.renderer = null;
    this.templates = null;
  }
}
