import DOMPurify from 'dompurify';
import { extensionOf, resolvePath, templateReference } from './paths';
import type { TemplateSet } from './types';

const MIME = new Map([
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);

const EXTERNAL = /^(?:https?:)?\/\//i;
const DATA = /^data:/i;
const BLOB = /^blob:/i;

function mimeFor(path: string) {
  return MIME.get(extensionOf(path)) || 'application/octet-stream';
}

export class TemplateAssets {
  private objectUrls = new Map<string, string>();
  private styleUrls = new Map<string, string>();
  private styleLinks = new Map<string, HTMLLinkElement>();
  private styleReady = new Map<string, Promise<void>>();
  private cssStack = new Set<string>();

  constructor(private templates: TemplateSet) {}

  private file(path: string) {
    const file = this.templates.files.get(path);
    if (!file) throw new Error(`Missing template asset: ${path}`);
    return file;
  }

  private objectUrl(path: string) {
    const cached = this.objectUrls.get(path);
    if (cached) return cached;

    const file = this.file(path);
    const url = URL.createObjectURL(new Blob([file.data], { type: mimeFor(path) }));
    this.objectUrls.set(path, url);
    return url;
  }

  private rewriteReference(reference: string, baseFile: string) {
    const value = reference.trim();
    if (!value) throw new Error(`Empty asset reference in ${baseFile}`);
    if (DATA.test(value) || BLOB.test(value) || value.startsWith('#')) return value;
    if (EXTERNAL.test(value)) {
      throw new Error(`External template asset is not allowed: ${value}`);
    }

    const templatePath = templateReference(value);
    const path = templatePath || resolvePath(baseFile, value);
    return this.objectUrl(path);
  }

  rewriteCss(css: string, baseFile: string) {
    let output = css
      .replace(/expression\s*\(/gi, '')
      .replace(/behavior\s*:/gi, '')
      .replace(/-moz-binding\s*:/gi, '');

    output = output.replace(
      /@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?\s*;/gi,
      (_match, _quote, reference) => {
        const templatePath = templateReference(reference);
        const path = templatePath || resolvePath(baseFile, reference);
        return `@import url("${this.cssUrl(path)}");`;
      }
    );

    return output.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (_match, _quote, reference) =>
        `url("${this.rewriteReference(reference, baseFile)}")`
    );
  }

  private cssUrl(path: string) {
    const cached = this.styleUrls.get(path);
    if (cached) return cached;
    if (this.cssStack.has(path)) throw new Error(`Circular CSS import: ${path}`);

    this.cssStack.add(path);
    try {
      const text = new TextDecoder().decode(this.file(path).data);
      const css = this.rewriteCss(text, path);
      const url = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
      this.styleUrls.set(path, url);
      this.objectUrls.set(`css:${path}`, url);
      return url;
    } finally {
      this.cssStack.delete(path);
    }
  }

  private addStylesheet(path: string, element: Element) {
    if (this.styleLinks.has(path)) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.cssUrl(path);
    link.dataset.templatePocStyle = path;
    const media = element.getAttribute('media');
    if (media) link.media = media;

    const ready = new Promise<void>((resolve) => {
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => resolve(), { once: true });
    });

    document.head.append(link);
    this.styleLinks.set(path, link);
    this.styleReady.set(path, ready);
  }

  async stylesReady() {
    await Promise.all(this.styleReady.values());
  }

  private rewriteAttribute(element: Element, name: string) {
    const value = element.getAttribute(name);
    if (!value) return;

    try {
      element.setAttribute(name, this.rewriteReference(value, 'inline.hbs'));
    } catch (error) {
      element.removeAttribute(name);
      if (element.tagName === 'IMG' || element.tagName === 'SOURCE') {
        element.remove();
      }
      throw error;
    }
  }

  private rewriteSrcset(element: Element) {
    const value = element.getAttribute('srcset');
    if (!value) return;

    const candidates = value
      .split(',')
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .map((candidate) => {
        const [reference, ...descriptor] = candidate.split(/\s+/);
        const url = this.rewriteReference(reference, 'inline.hbs');
        return [url, ...descriptor].join(' ');
      });

    if (candidates.length > 0) element.setAttribute('srcset', candidates.join(', '));
  }

  private prepareHeadStyles(fragment: DocumentFragment) {
    for (const link of [...fragment.querySelectorAll('link')]) {
      const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const href = link.getAttribute('href') || '';
      const path = templateReference(href);

      if (!rel.includes('stylesheet') || !path) {
        link.remove();
        continue;
      }

      this.addStylesheet(path, link);
      link.remove();
    }
  }

  private rewriteElement(element: Element, page: string) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      element.remove();
      return;
    }

    if (tag === 'style') {
      element.textContent = this.rewriteCss(element.textContent || '', page);
    }

    const style = element.getAttribute('style');
    if (style) element.setAttribute('style', this.rewriteCss(style, page));

    for (const name of ['src', 'poster']) {
      if (element.hasAttribute(name)) this.rewriteAttribute(element, name);
    }
    if (element.hasAttribute('srcset')) this.rewriteSrcset(element);

    if (tag === 'a') {
      const href = element.getAttribute('href') || '';
      if (/^javascript:/i.test(href)) element.removeAttribute('href');
    }
  }

  rewriteHtml(input: string, page: string) {
    const raw = document.createElement('template');
    raw.innerHTML = input;
    this.prepareHeadStyles(raw.content);

    const clean = DOMPurify.sanitize(raw.innerHTML, {
      ALLOW_DATA_ATTR: true,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
    });

    const container = document.createElement('div');
    container.innerHTML = clean;

    for (const element of [...container.querySelectorAll('*')]) {
      this.rewriteElement(element, page);
    }

    return container.innerHTML;
  }

  dispose() {
    for (const link of this.styleLinks.values()) link.remove();
    this.styleLinks.clear();
    this.styleUrls.clear();
    this.styleReady.clear();
    this.cssStack.clear();

    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }
}
