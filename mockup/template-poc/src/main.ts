import morphdom from 'morphdom';
import { TemplateAssets } from './runtime/assets';
import { TemplateCache, withLock } from './runtime/cache';
import { loadTemplateSet } from './runtime/layers';
import { TemplateRenderer } from './runtime/render';
import { bindActions } from './runtime/actions';
import { createRouter, currentRoute, navigate } from './runtime/router';
import type { LayerSource, LogFn, LogKind, TemplateManifest, TemplateSet } from './runtime/types';
import './debug.css';

type Theme = 'auto' | 'light' | 'dark';

const cache = new TemplateCache();
const app = document.querySelector<HTMLElement>('#app');
const layersElement = document.querySelector<HTMLElement>('#poc-layers');
const logElement = document.querySelector<HTMLElement>('#poc-log');
const statusElement = document.querySelector<HTMLElement>('#poc-status');
const themeKey = 'auth-template-poc:theme';

let manifest: TemplateManifest | null = null;
let templateSet: TemplateSet | null = null;
let renderer: TemplateRenderer | null = null;
let assets: TemplateAssets | null = null;
let selectedOverlays = new Set<string>();
let logs: string[] = [];
let loading = false;
let loadError: string | null = null;
let renderError: string | null = null;
let formError: string | null = null;
let notice: string | null = null;
let loadId = 0;
let loadTimer: number | null = null;
let revealed = false;
let theme = readTheme();

function readTheme(): Theme {
  const value = localStorage.getItem(themeKey);
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function applyTheme() {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  localStorage.setItem(themeKey, theme);
}

function cycleTheme() {
  const values: Theme[] = ['auto', 'light', 'dark'];
  theme = values[(values.indexOf(theme) + 1) % values.length];
  applyTheme();
  render();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function addLog(kind: LogKind, message: string) {
  const timestamp = new Date().toLocaleTimeString();
  logs.push(`[${timestamp}] ${kind.padEnd(7)} ${message}`);
  if (logs.length > 80) logs = logs.slice(-80);
}

const log: LogFn = (kind, message) => {
  addLog(kind, message);
  syncDebug();
};

function layerSources() {
  if (!manifest) return [];
  const overlays = manifest.overlays.filter((layer) => selectedOverlays.has(layer.id));
  return [manifest.base, ...overlays];
}

function navItems(active: string) {
  return [
    { label: 'Overview', route: '/account/overview', icon: 'overview', active: active === 'overview' },
    { label: 'Security', route: '/account/security', icon: 'security', active: active === 'security' },
    { label: 'Apps', route: '/account/apps', icon: 'apps', active: active === 'apps' },
  ];
}

function accountData(page: string) {
  return {
    appName: 'Auth',
    user: {
      name: 'Demo User',
      username: 'demo',
      email: 'demo@example.com',
    },
    nav: navItems(page),
    theme: { value: theme },
    notice,
    page: {
      title: page === 'security' ? 'Security' : page === 'apps' ? 'Apps' : 'Overview',
      subtitle:
        page === 'security'
          ? 'Manage how you sign in and where this account is active.'
          : page === 'apps'
            ? 'Applications with access to this account.'
            : 'Identity and access settings for this account.',
    },
    identity: {
      name: 'Demo User',
      username: 'demo',
      email: 'demo@example.com',
      account: 'Acme',
    },
    access: {
      client: 'account',
      realm: 'Acme',
      scope: 'openid profile email',
      session: 'Active',
    },
    security: {
      source: 'Realm overlay example',
    },
    apps: {
      source: 'Realm overlay example',
    },
  };
}

function loginData() {
  return {
    realm: { name: 'Acme' },
    title: 'Sign in',
    notice,
    error: formError,
    login: {
      identifier: '',
      pending: loading,
    },
    theme: { value: theme },
  };
}

function pageForRoute(route: string) {
  if (route === '/login') return { app: 'login', page: 'identifier', data: loginData() };
  if (route === '/account/security') {
    return { app: 'account', page: 'security', data: accountData('security') };
  }
  if (route === '/account/apps') {
    return { app: 'account', page: 'apps', data: accountData('apps') };
  }
  return { app: 'account', page: 'overview', data: accountData('overview') };
}

function fallbackHtml(message: string) {
  return `
    <div class="poc-fallback">
      <div>
        <p class="poc-fallback-kicker">Template runtime</p>
        <h1>Template unavailable</h1>
        <p>${escapeHtml(message)}</p>
        <button class="poc-fallback-button" type="button" data-reload-templates>Try again</button>
      </div>
    </div>
  `;
}

function render() {
  if (!app) return;

  if (!renderer || !templateSet) {
    app.innerHTML = fallbackHtml(loadError || renderError || 'Loading template');
    syncDebug();
    return;
  }

  const { app: appName, page, data } = pageForRoute(currentRoute());
  const menuOpen = document.querySelector<HTMLDetailsElement>('.user-menu')?.open || false;

  try {
    const html = renderer.render(`${appName}/${page}`, data);
    const wrapper = document.createElement('div');
    wrapper.id = 'app';
    wrapper.innerHTML = html;
    morphdom(app, wrapper);

    const menu = document.querySelector<HTMLDetailsElement>('.user-menu');
    if (menu && menuOpen) menu.open = true;

    renderError = null;
  } catch (caught) {
    renderError = caught instanceof Error ? caught.message : String(caught);
    addLog('error', renderError);
    app.innerHTML = fallbackHtml(renderError);
  }

  syncDebug();
}

function setLoading(value: boolean) {
  loading = value;
  syncDebug();
}

async function reveal() {
  if (revealed) return;
  if (assets) await assets.stylesReady();
  document.documentElement.dataset.templateReady = '';
  revealed = true;
}

function scheduleLoad() {
  if (loadTimer !== null) window.clearTimeout(loadTimer);
  loadTimer = window.setTimeout(() => {
    loadTimer = null;
    loadTemplates();
  }, 0);
}

async function loadTemplates() {
  if (!manifest) return;
  const requestId = ++loadId;
  const sources = layerSources();

  setLoading(true);
  loadError = null;
  renderError = null;
  logs = [];
  render();

  try {
    const set = await withLock('auth-template-poc-install', () =>
      loadTemplateSet(sources, cache, log)
    );
    if (requestId !== loadId) return;

    const previousAssets = assets;
    const nextAssets = new TemplateAssets(set);
    const nextRenderer = new TemplateRenderer(set, nextAssets);

    assets = nextAssets;
    renderer = nextRenderer;
    templateSet = set;
    render();
    await nextAssets.stylesReady();
    previousAssets?.dispose();

    cache.setActive('demo', {
      digest: set.compositeDigest,
      layers: sources.map((layer) => ({ id: layer.id, digest: layer.digest })),
    });
    addLog('info', `active composite ${set.compositeDigest.slice(0, 12)}`);
    if (cache.storageMode === 'memory') {
      addLog('info', 'OPFS unavailable; using the in-memory layer cache');
    }
  } catch (caught) {
    if (requestId !== loadId) return;
    loadError = caught instanceof Error ? caught.message : String(caught);
    addLog('error', loadError);
  } finally {
    if (requestId === loadId) {
      setLoading(false);
      render();
      await reveal();
    }
  }
}

function sourceMarkup(layer: LayerSource, selected: boolean, selectable: boolean) {
  const checkbox = selectable
    ? `<input type="checkbox" data-overlay="${escapeHtml(layer.id)}" ${
        selected ? 'checked' : ''
      }>`
    : '<span class="poc-chip">base</span>';

  return `
    <div class="poc-layer">
      ${checkbox}
      <div class="poc-layer-body">
        <strong>${escapeHtml(layer.label)}</strong>
        <span>${escapeHtml(layer.id)} - ${escapeHtml(layer.digest.slice(0, 12))}</span>
      </div>
    </div>
  `;
}

function syncDebug() {
  if (statusElement) {
    statusElement.textContent = loading
      ? 'Installing template...'
      : loadError || renderError
        ? 'Template error'
        : templateSet
          ? `Active - ${templateSet.compositeDigest.slice(0, 12)}`
          : 'Idle';
    statusElement.dataset.state =
      loading ? 'loading' : loadError || renderError ? 'error' : 'ready';
  }

  if (layersElement && manifest) {
    layersElement.innerHTML = [
      sourceMarkup(manifest.base, true, false),
      ...manifest.overlays.map((layer) =>
        sourceMarkup(layer, selectedOverlays.has(layer.id), true)
      ),
    ].join('');
  }

  if (logElement) {
    logElement.textContent = logs.join('\n') || 'No runtime events yet.';
    logElement.scrollTop = logElement.scrollHeight;
  }
}

async function initialize() {
  applyTheme();
  bindActions(
    document.body,
    {
      'cycle-theme': () => cycleTheme(),
      'sign-out': () => {
        notice = 'Signed out (demo).';
        navigate('/login');
      },
    },
    {
      identifier: (_form, data) => {
        const identifier = String(data.get('identifier') || '').trim();
        if (!identifier) {
          formError = 'Enter an email address or username.';
          render();
          return;
        }
        notice = `Continuing as ${identifier} (demo).`;
        formError = null;
        navigate('/account/overview');
      },
    },
    navigate
  );

  document.addEventListener('click', (event) => {
    const menu = document.querySelector<HTMLDetailsElement>('.user-menu');
    if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
  });

  document.addEventListener('click', async (event) => {
    const target = event.target as Element | null;
    const page = target?.closest<HTMLElement>('[data-demo-page]');
    if (page) navigate(page.dataset.demoPage || '');

    if (target?.closest('[data-reload-templates]')) loadTemplates();

    if (target?.closest('[data-clear-opfs]')) {
      await cache.clearAll();
      logs = [];
      addLog('info', 'OPFS cache cleared');
      await loadTemplates();
    }

    if (target?.closest('[data-clear-meta]')) {
      cache.clearActive('demo');
      localStorage.removeItem(themeKey);
      theme = 'auto';
      applyTheme();
      addLog('info', 'localStorage metadata cleared');
      syncDebug();
    }
  });

  document.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches('[data-overlay]')) return;
    const id = input.dataset.overlay || '';
    if (input.checked) selectedOverlays.add(id);
    else selectedOverlays.delete(id);
    scheduleLoad();
  });

  createRouter(() => {
    render();
  });

  try {
    const response = await fetch('./manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Manifest request failed with ${response.status}`);
    manifest = (await response.json()) as TemplateManifest;
    addLog('info', `manifest api ${manifest.api}`);
    syncDebug();
    await loadTemplates();
  } catch (caught) {
    loadError = caught instanceof Error ? caught.message : String(caught);
    addLog('error', loadError);
    setLoading(false);
    render();
    await reveal();
  }
}

initialize();
