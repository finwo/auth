import { TemplateRuntime, type TemplateLayer } from '@template';
import { bindActions } from '@template/runtime/actions';
import { formatBytes, formatTime, scopeLabel } from '@util/format';
import { applyTheme, cycleTheme, getTheme, themeLabel, type Theme } from '@util/theme';
import {
  appUrl,
  getAdminConfig,
  getAuthUrl,
  getBasePath,
  type AdminPackage,
  type AdminRealm,
  type AdminSession,
  type AdminTemplateLayer,
  type UserInfo,
} from './util/api';
import {
  adminSignOut,
  clearAdminTokens,
  completeAdminLogin,
  deleteAdminPackage,
  deleteAdminTemplate,
  getAdminTokens,
  loadAdminPackages,
  loadAdminRealmTemplates,
  loadAdminRealms,
  loadAdminSessions,
  loadAdminSystemTemplates,
  loadAdminTemplates,
  loadAdminUser,
  replaceAdminRealmTemplates,
  replaceAdminSystemTemplates,
  revokeAdminSessionRealm,
  startAdminLogin,
  terminateAdminSession,
  uploadAdminPackage,
  uploadAdminTemplate,
} from './util/auth';

import './assets/boot.css';

type RouteKind = 'overview' | 'sessions' | 'templates' | 'packages' | 'callback';
type SessionAction = 'realm' | 'terminate';

interface RouteInfo {
  kind: RouteKind;
  realm: string | null;
}

function readPath() {
  const base = getBasePath();
  let path = window.location.pathname;
  if (base && (path === base || path.startsWith(`${base}/`))) {
    path = path.slice(base.length);
  }
  path = path.replace(/\/+$/, '');
  return path || '/';
}

function decodeRealm(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseRoute(path: string): RouteInfo {
  if (path === '/callback') return { kind: 'callback', realm: null };
  if (path === '/sessions') return { kind: 'sessions', realm: null };
  if (path.startsWith('/sessions/')) {
    return {
      kind: 'sessions',
      realm: decodeRealm(path.slice('/sessions/'.length)),
    };
  }
  if (path === '/templates') return { kind: 'templates', realm: null };
  if (path.startsWith('/templates/')) {
    return {
      kind: 'templates',
      realm: decodeRealm(path.slice('/templates/'.length)),
    };
  }
  if (path === '/packages') return { kind: 'packages', realm: null };
  return { kind: 'overview', realm: null };
}

function sessionKey(action: SessionAction, session: AdminSession) {
  return `${action}:${session.public_id}`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

class AdminApp {
  private root: HTMLElement;
  private runtime: TemplateRuntime;
  private templateLayers: TemplateLayer[];
  private path: string;
  private user: UserInfo | null = null;
  private realms: AdminRealm[] | null = null;
  private realmsError: Error | null = null;
  private error: Error | null = null;
  private notice: string | null = null;
  private authUrl = window.location.origin;
  private theme: Theme = getTheme();
  private redirected = false;

  private sessionsLoadedRealm: string | null = null;
  private sessions: AdminSession[] | null = null;
  private sessionsLoading = false;
  private sessionsError: Error | null = null;
  private sessionsNotice: string | null = null;
  private sessionConfirmKey: string | null = null;
  private sessionPendingKey: string | null = null;

  private templatesLoadedScope = '';
  private templates: AdminPackage[] | null = null;
  private templatesLoading = false;
  private templatesError: Error | null = null;
  private templatesNotice: string | null = null;
  private templateSavedIds: string[] = [];
  private templateDraftIds: string[] = [];
  private templateSaving = false;
  private templateDeleting = false;
  private templateConfirmId: string | null = null;
  private templateUploadPending = false;

  private packages: AdminPackage[] | null = null;
  private packagesLoading = false;
  private packagesError: Error | null = null;
  private packagesNotice: string | null = null;
  private packagesPending = false;
  private packagesConfirmId: string | null = null;

  constructor(root: HTMLElement, runtime: TemplateRuntime, templateLayers: TemplateLayer[]) {
    this.root = root;
    this.runtime = runtime;
    this.templateLayers = templateLayers;
    this.path = readPath();
  }

  async start() {
    applyTheme(this.theme);
    try {
      await this.runtime.install(this.templateLayers);

      if (this.path === '/callback') {
        await completeAdminLogin(window.location.search.replace(/^\?/, ''));
        this.replacePath('/');
      }

      await this.load();
      await this.runtime.stylesReady();
      document.documentElement.dataset.templateReady = '';
    } catch (error) {
      console.error(error);
      this.showFatal(error);
    }
  }

  private async load() {
    try {
      this.authUrl = await getAuthUrl();
    } catch {
      this.authUrl = window.location.origin;
    }

    if (!getAdminTokens()) {
      await this.login();
      return;
    }

    try {
      this.user = await loadAdminUser();
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 400) {
        await this.login();
        return;
      }
      this.error = error;
    }

    if (this.user) {
      try {
        this.realms = await loadAdminRealms();
        this.realmsError = null;
      } catch (error: any) {
        if (error?.status === 401 || error?.status === 400) {
          await this.login();
          return;
        }
        this.realms = [];
        this.realmsError = error;
      }
    }

    await this.ensureRoute(parseRoute(this.path));
    this.render();
  }

  private async login() {
    try {
      await startAdminLogin();
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(messageOf(error));
      this.showFatal(this.error);
    }
  }

  private async authExpired() {
    clearAdminTokens();
    await this.login();
  }

  private replacePath(path: string) {
    this.path = path;
    window.history.replaceState(null, '', appUrl(path));
  }

  navigate(path: string, replace = false) {
    this.path = path;
    const method = replace ? 'replaceState' : 'pushState';
    window.history[method](null, '', appUrl(path));
    this.error = null;
    this.notice = null;
    void this.route();
  }

  private async route() {
    this.error = null;
    this.notice = null;
    this.render();
    await this.ensureRoute(parseRoute(this.path));
    this.render();
  }

  private async ensureRoute(info: RouteInfo) {
    if (!this.user) return;

    const adminOnly = info.kind === 'templates' || info.kind === 'packages';
    if (adminOnly && !this.user.is_system_admin) {
      this.replacePath('/');
      return;
    }

    if (info.kind === 'sessions') {
      await this.ensureSessions(info.realm);
      return;
    }
    if (info.kind === 'templates') {
      await this.ensureTemplates(info.realm);
      return;
    }
    if (info.kind === 'packages') {
      if (this.packages === null && !this.packagesLoading) await this.loadPackages();
    }
  }

  private async ensureSessions(realm: string | null) {
    if (!this.realms) return;
    if (this.realms.length === 0) {
      this.sessions = [];
      this.sessionsLoading = false;
      return;
    }

    const selected = realm && this.realms.some((item) => item.slug === realm);
    if (!selected) {
      if (this.redirected) return;
      this.redirected = true;
      const target = `/sessions/${encodeURIComponent(this.realms[0].slug)}`;
      this.replacePath(target);
      this.redirected = false;
      await this.ensureSessions(this.realms[0].slug);
      return;
    }

    if (this.sessionsLoadedRealm !== realm) await this.loadSessions(realm);
  }

  private async ensureTemplates(realm: string | null) {
    if (realm) {
      if (!this.realms) return;
      if (this.realms.length === 0) {
        this.templates = [];
        this.templateSavedIds = [];
        this.templateDraftIds = [];
        this.templatesLoading = false;
        return;
      }

      const selected = this.realms.some((item) => item.slug === realm);
      if (!selected) {
        if (this.redirected) return;
        this.redirected = true;
        const target = `/templates/${encodeURIComponent(this.realms[0].slug)}`;
        this.replacePath(target);
        this.redirected = false;
        await this.ensureTemplates(this.realms[0].slug);
        return;
      }
    }

    const scope = realm || 'system';
    if (this.templatesLoadedScope !== scope) await this.loadTemplates(realm);
    if (this.templates === null && !this.templatesLoading) await this.loadTemplatePackages();
  }

  private async loadSessions(realm: string) {
    this.sessionsLoadedRealm = realm;
    this.sessionsLoading = true;
    this.sessionsError = null;
    this.sessions = null;
    this.sessionConfirmKey = null;
    this.render();

    try {
      this.sessions = await loadAdminSessions(realm);
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.sessionsError = error;
    } finally {
      this.sessionsLoading = false;
      this.render();
    }
  }

  private async loadTemplates(realm: string | null) {
    this.templatesLoadedScope = realm || 'system';
    this.templatesLoading = true;
    this.templatesError = null;
    this.templates = null;
    this.templateConfirmId = null;
    this.render();

    try {
      const [templates, templateLayers] = await Promise.all([
        loadAdminTemplates(),
        realm ? loadAdminRealmTemplates(realm) : loadAdminSystemTemplates(),
      ]);
      this.templates = templates;
      this.templateSavedIds = templateLayers.map((layer) => layer.id);
      this.templateDraftIds = [...this.templateSavedIds];
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.templatesError = error;
    } finally {
      this.templatesLoading = false;
      this.render();
    }
  }

  private async loadTemplatePackages() {
    this.templatesLoading = true;
    this.render();
    try {
      this.templates = await loadAdminTemplates();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.templatesError = error;
    } finally {
      this.templatesLoading = false;
      this.render();
    }
  }

  private async loadPackages() {
    this.packagesLoading = true;
    this.packagesError = null;
    this.render();

    try {
      this.packages = await loadAdminPackages();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.packagesError = error;
    } finally {
      this.packagesLoading = false;
      this.render();
    }
  }

  private async refreshTemplates() {
    try {
      this.templates = await loadAdminTemplates();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.templatesError = error;
    }
    this.render();
  }

  private cycleTheme() {
    this.theme = cycleTheme();
    this.render();
  }

  async signOut() {
    try {
      await adminSignOut();
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(messageOf(error));
      this.render();
    }
  }

  private confirmSession(action: SessionAction, session: AdminSession) {
    this.sessionConfirmKey = sessionKey(action, session);
    this.render();
  }

  private cancelSessionConfirm() {
    this.sessionConfirmKey = null;
    this.render();
  }

  private async actSession(action: SessionAction, session: AdminSession) {
    const realm = parseRoute(this.path).realm;
    if (!realm || this.sessionPendingKey) return;

    this.sessionPendingKey = sessionKey(action, session);
    this.sessionsError = null;
    this.sessionsNotice = null;
    this.render();

    try {
      if (action === 'realm') {
        await revokeAdminSessionRealm(realm, session.public_id);
        this.sessionsNotice =
          'Realm access revoked. The next authorization for this realm requires re-verification.';
      } else {
        await terminateAdminSession(realm, session.public_id);
        this.sessionsNotice = 'Session terminated.';
      }
      this.sessionConfirmKey = null;
      await this.loadSessions(realm);
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.sessionsError = error;
    } finally {
      this.sessionPendingKey = null;
      this.render();
    }
  }

  private async uploadTemplate(form: HTMLFormElement, data: FormData) {
    if (this.templateUploadPending) return;
    const file = data.get('file');
    if (!(file instanceof File) || !file.name) {
      this.templatesError = new Error('Choose a template file.');
      this.render();
      return;
    }

    this.templateUploadPending = true;
    this.templatesError = null;
    this.templatesNotice = null;
    this.render();

    try {
      const uploaded = await uploadAdminTemplate({
        file,
        name: String(data.get('name') || ''),
        version: String(data.get('version') || ''),
        authorName: String(data.get('author_name') || ''),
        authorEmail: String(data.get('author_email') || ''),
      });
      if (!this.templateDraftIds.includes(uploaded.id)) {
        this.templateDraftIds.push(uploaded.id);
      }
      this.templatesNotice = `Uploaded ${uploaded.name} ${uploaded.version}.`;
      form.reset();
      await this.refreshTemplates();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.templatesError = error;
    } finally {
      this.templateUploadPending = false;
      this.render();
    }
  }

  private addTemplate(id: string) {
    if (!this.templateDraftIds.includes(id)) this.templateDraftIds.push(id);
    this.render();
  }

  private removeTemplate(id: string) {
    this.templateDraftIds = this.templateDraftIds.filter((value) => value !== id);
    this.render();
  }

  private moveTemplate(id: string, offset: number) {
    const index = this.templateDraftIds.indexOf(id);
    const next = index + offset;
    if (index === -1 || next < 0 || next >= this.templateDraftIds.length) return;
    const copy = [...this.templateDraftIds];
    copy[index] = copy[next];
    copy[next] = id;
    this.templateDraftIds = copy;
    this.render();
  }

  private clearTemplates() {
    this.templateDraftIds = [];
    this.render();
  }

  private async saveTemplates() {
    const realm = parseRoute(this.path).realm;
    if (this.templateSaving) return;

    this.templateSaving = true;
    this.templatesError = null;
    this.templatesNotice = null;
    this.render();

    try {
      const templateLayers = realm
        ? await replaceAdminRealmTemplates(realm, this.templateDraftIds)
        : await replaceAdminSystemTemplates(this.templateDraftIds);
      this.templateSavedIds = templateLayers.map((layer) => layer.id);
      this.templateDraftIds = [...this.templateSavedIds];
      this.templatesNotice = 'Template assignment saved.';
      await this.refreshTemplates();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.templatesError = error;
    } finally {
      this.templateSaving = false;
      this.render();
    }
  }

  private async deleteTemplate(item: AdminPackage) {
    this.templateDeleting = true;
    this.templatesError = null;
    this.templatesNotice = null;
    this.render();

    try {
      await deleteAdminTemplate(item.id);
      this.templateDraftIds = this.templateDraftIds.filter((id) => id !== item.id);
      this.templateSavedIds = this.templateSavedIds.filter((id) => id !== item.id);
      this.templateConfirmId = null;
      this.templatesNotice = `Deleted ${item.name} ${item.version}.`;
      await this.refreshTemplates();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.templatesError = error;
    } finally {
      this.templateDeleting = false;
      this.render();
    }
  }

  private async uploadPackage(form: HTMLFormElement, data: FormData) {
    if (this.packagesPending) return;
    const file = data.get('file');
    if (!(file instanceof File) || !file.name) {
      this.packagesError = new Error('Choose a package file.');
      this.render();
      return;
    }

    this.packagesPending = true;
    this.packagesError = null;
    this.packagesNotice = null;
    this.render();

    try {
      const uploaded = await uploadAdminPackage(file);
      this.packagesNotice = `Uploaded ${uploaded.name} ${uploaded.version}.`;
      form.reset();
      await this.loadPackages();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.packagesError = error;
    } finally {
      this.packagesPending = false;
      this.render();
    }
  }

  private async deletePackage(item: AdminPackage) {
    this.packagesPending = true;
    this.packagesError = null;
    this.packagesNotice = null;
    this.render();

    try {
      await deleteAdminPackage(item.id);
      this.packagesConfirmId = null;
      this.packagesNotice = `Deleted ${item.name} ${item.version}.`;
      await this.loadPackages();
    } catch (error: any) {
      if (error?.status === 401) {
        await this.authExpired();
        return;
      }
      this.packagesError = error;
    } finally {
      this.packagesPending = false;
      this.render();
    }
  }

  private navItems(kind: RouteKind) {
    const firstRealm = this.realms?.[0]?.slug;
    const sessionsRoute = firstRealm
      ? `/sessions/${encodeURIComponent(firstRealm)}`
      : '/sessions';
    const templatesRoute = '/templates';
    const items = [
      {
        key: 'overview',
        icon: 'overview',
        label: 'Overview',
        route: '/',
        href: appUrl('/'),
        active: kind === 'overview',
      },
      {
        key: 'sessions',
        icon: 'activity',
        label: 'Sessions',
        route: sessionsRoute,
        href: appUrl(sessionsRoute),
        active: kind === 'sessions',
      },
    ];

    if (this.user?.is_system_admin) {
      items.push(
        {
          key: 'templates',
          icon: 'layers',
          label: 'Templates',
          route: templatesRoute,
          href: appUrl(templatesRoute),
          active: kind === 'templates',
        },
        {
          key: 'packages',
          icon: 'package',
          label: 'Packages',
          route: '/packages',
          href: appUrl('/packages'),
          active: kind === 'packages',
        }
      );
    }

    return items;
  }

  private baseData(kind: RouteKind) {
    const tokens = getAdminTokens();
    return {
      user: this.user,
      userName: this.user?.name || 'Administrator',
      userMeta: this.user?.email || this.user?.preferred_username || 'Identity provider',
      authUrl: this.authUrl,
      accountHref: `${this.authUrl}/app/account`,
      homeHref: appUrl('/'),
      theme: this.theme,
      themeLabel: themeLabel(this.theme),
      isSystemAdmin: Boolean(this.user?.is_system_admin),
      navItems: this.navItems(kind),
      tokenScope: tokens?.scope || 'openid',
    };
  }

  private overviewData() {
    return {
      ...this.baseData('overview'),
      realms:
        this.realms?.map((realm) => ({
          slug: realm.slug,
          displayName: realm.display_name,
          sessionsHref: appUrl(`/sessions/${encodeURIComponent(realm.slug)}`),
          sessionsRoute: `/sessions/${encodeURIComponent(realm.slug)}`,
        })) || null,
      realmsError: this.realmsError?.message || null,
      error: this.error?.message || null,
      roleLabel: this.user?.is_system_admin ? 'System administrator' : 'Realm administrator',
      email: this.user?.email || 'Not set',
      username: this.user?.preferred_username || '',
    };
  }

  private sessionsData() {
    const info = parseRoute(this.path);
    const selected =
      this.realms?.find((realm) => realm.slug === info.realm) || this.realms?.[0] || null;
    const pending = Boolean(this.sessionPendingKey);

    return {
      ...this.baseData('sessions'),
      realms: this.realms,
      realmOptions:
        this.realms?.map((realm) => ({
          slug: realm.slug,
          displayName: realm.display_name,
          selected: realm.slug === selected?.slug,
        })) || [],
      selected,
      realmsError: this.realmsError?.message || null,
      loading: this.sessionsLoading,
      error: this.sessionsError?.message || this.error?.message || null,
      notice: this.sessionsNotice,
      sessions:
        this.sessions?.map((session) => {
          const realmKey = sessionKey('realm', session);
          const terminateKey = sessionKey('terminate', session);
          return {
            publicId: session.public_id,
            name: session.user.display_name || session.user.username,
            username: session.user.username,
            status: session.user.status !== 'active' ? session.user.status : '',
            revoked: Boolean(session.revoked_at),
            revokedLabel: session.revoked_at
              ? `Realm access revoked ${formatTime(session.revoked_at)}`
              : '',
            scope: scopeLabel(session.scope.type),
            host: session.scope.host || 'Canonical',
            client: session.scope.client_id || 'None',
            lastSeen: formatTime(session.last_seen_at),
            expires: formatTime(session.expires_at),
            address: session.ip || 'Unknown',
            userAgent: session.user_agent || '',
            canTerminate: session.can_terminate,
            confirmRealm: this.sessionConfirmKey === realmKey,
            confirmTerminate: this.sessionConfirmKey === terminateKey,
            revokePending: this.sessionPendingKey === realmKey,
            terminatePending: this.sessionPendingKey === terminateKey,
            pending,
          };
        }) || [],
    };
  }

  private templatesData() {
    const info = parseRoute(this.path);
    const selected = info.realm
      ? this.realms?.find((realm) => realm.slug === info.realm) || null
      : null;
    const dirty =
      this.templateSavedIds.length !== this.templateDraftIds.length ||
      this.templateDraftIds.some((id, index) => id !== this.templateSavedIds[index]);

    const templateMap = new Map((this.templates || []).map((item) => [item.id, item]));
    const layers = this.templateDraftIds.map((id, index) => {
      const item = templateMap.get(id);
      return {
        id,
        position: index + 1,
        label: item ? item.template?.label || `${item.name} ${item.version}` : 'Unknown template',
        author: item?.author_name || 'Unavailable',
        first: index === 0,
        last: index === this.templateDraftIds.length - 1,
      };
    });

    return {
      ...this.baseData('templates'),
      realms: this.realms,
      realmOptions: [
        {
          slug: '',
          displayName: 'System (all hosts)',
          selected: !selected,
        },
        ...(this.realms?.map((realm) => ({
          slug: realm.slug,
          displayName: realm.display_name,
          selected: realm.slug === selected?.slug,
        })) || []),
      ],
      selected,
      scopeLabel: selected?.display_name || 'System',
      realmsError: this.realmsError?.message || null,
      loading: this.templatesLoading,
      error: this.templatesError?.message || this.error?.message || null,
      notice: this.templatesNotice,
      uploadPending: this.templateUploadPending,
      dirty,
      saving: this.templateSaving,
      deleting: this.templateDeleting,
      layers,
      hasLayers: layers.length > 0,
      templates:
        this.templates?.map((item) => ({
          id: item.id,
          label: item.template?.label || `${item.name} ${item.version}`,
          author: item.author_name,
          authorEmail: item.author_email,
          meta: `${formatBytes(item.byte_size)} · ${item.file_count} file${
            item.file_count === 1 ? '' : 's'
          }${item.author_email ? ` · ${item.author_email}` : ''}`,
          usage:
            item.template_count > 0
              ? `Used in ${item.template_count} scope${item.template_count === 1 ? '' : 's'}`
              : 'Not assigned',
          usageCount: item.template_count,
          inUse: item.template_count > 0,
          broken: !item.template,
          assigned: this.templateDraftIds.includes(item.id),
          confirm: this.templateConfirmId === item.id,
        })) || [],
      hasTemplates: Boolean(this.templates && this.templates.length > 0),
    };
  }

  private packagesData() {
    return {
      ...this.baseData('packages'),
      loading: this.packagesLoading,
      error: this.packagesError?.message || this.error?.message || null,
      notice: this.packagesNotice,
      pending: this.packagesPending,
      packages:
        this.packages?.map((item) => ({
          id: item.id,
          label: `${item.name} ${item.version}`,
          type: item.type,
          author: item.author_name,
          authorEmail: item.author_email,
          template: Boolean(item.template),
          size: formatBytes(item.byte_size),
          files: item.file_count,
          created: formatTime(item.created_at),
          usage:
            item.template_count > 0
              ? `Used in ${item.template_count} scope${item.template_count === 1 ? '' : 's'}`
              : 'Not assigned',
          inUse: item.template_count > 0,
          confirm: this.packagesConfirmId === item.id,
        })) || [],
      hasPackages: Boolean(this.packages && this.packages.length > 0),
    };
  }

  private updateTitle(kind: RouteKind) {
    const title =
      kind === 'sessions'
        ? 'Sessions · Administration'
        : kind === 'templates'
          ? 'Templates · Administration'
          : kind === 'packages'
            ? 'Packages · Administration'
            : kind === 'callback'
              ? 'Completing sign-in · Administration'
              : 'Administration';
    document.title = title;
  }

  private showFatal(error: unknown) {
    const page = document.createElement('main');
    page.className = 'boot-page';
    const card = document.createElement('section');
    card.className = 'boot-card';
    const title = document.createElement('h1');
    title.textContent = 'Administration unavailable';
    const message = document.createElement('p');
    message.textContent = messageOf(error);
    const retry = document.createElement('button');
    retry.className = 'boot-retry';
    retry.type = 'button';
    retry.dataset.action = 'retry';
    retry.textContent = 'Try again';
    card.append(title, message, retry);
    page.append(card);
    this.root.replaceChildren(page);
    document.documentElement.dataset.templateReady = '';
  }

  private render() {
    if (!this.user) {
      if (this.error) this.showFatal(this.error);
      return;
    }

    const info = parseRoute(this.path);
    this.updateTitle(info.kind);

    if ((info.kind === 'templates' || info.kind === 'packages') && !this.user.is_system_admin) {
      this.replacePath('/');
      this.runtime.render('admin/overview', this.overviewData());
      return;
    }

    if (info.kind === 'sessions') {
      this.runtime.render('admin/sessions', this.sessionsData());
      return;
    }
    if (info.kind === 'templates') {
      this.runtime.render('admin/templates', this.templatesData());
      return;
    }
    if (info.kind === 'packages') {
      this.runtime.render('admin/packages', this.packagesData());
      return;
    }

    this.runtime.render('admin/overview', this.overviewData());
  }

  bind() {
    bindActions(
      this.root,
      {
        'cycle-theme': () => this.cycleTheme(),
        'sign-out': () => {
          void this.signOut();
        },
        'confirm-revoke-realm': (element) => {
          const session = this.findSession(element.dataset.session || '');
          if (session) this.confirmSession('realm', session);
        },
        'confirm-terminate-session': (element) => {
          const session = this.findSession(element.dataset.session || '');
          if (session) this.confirmSession('terminate', session);
        },
        'revoke-realm': (element) => {
          const session = this.findSession(element.dataset.session || '');
          if (session) void this.actSession('realm', session);
        },
        'terminate-session': (element) => {
          const session = this.findSession(element.dataset.session || '');
          if (session) void this.actSession('terminate', session);
        },
        'cancel-session': () => this.cancelSessionConfirm(),
        'add-template': (element) => this.addTemplate(element.dataset.template || ''),
        'remove-template': (element) => this.removeTemplate(element.dataset.template || ''),
        'move-template-earlier': (element) =>
          this.moveTemplate(element.dataset.template || '', -1),
        'move-template-later': (element) =>
          this.moveTemplate(element.dataset.template || '', 1),
        'clear-templates': () => this.clearTemplates(),
        'save-templates': () => {
          void this.saveTemplates();
        },
        'confirm-delete-template': (element) => {
          this.templateConfirmId = element.dataset.template || null;
          this.render();
        },
        'delete-template': (element) => {
          const item = this.templates?.find((value) => value.id === element.dataset.template);
          if (item) void this.deleteTemplate(item);
        },
        'cancel-template-delete': () => {
          this.templateConfirmId = null;
          this.render();
        },
        'confirm-delete-package': (element) => {
          this.packagesConfirmId = element.dataset.package || null;
          this.render();
        },
        'delete-package': (element) => {
          const item = this.packages?.find((value) => value.id === element.dataset.package);
          if (item) void this.deletePackage(item);
        },
        'cancel-package-delete': () => {
          this.packagesConfirmId = null;
          this.render();
        },
        retry: () => {
          window.location.reload();
        },
      },
      {
        'template-upload': (form, data) => {
          void this.uploadTemplate(form, data);
        },
        'package-upload': (form, data) => {
          void this.uploadPackage(form, data);
        },
      },
      (path) => this.navigate(path)
    );

    this.root.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement | HTMLSelectElement | null;
      if (!target) return;
      if (target instanceof HTMLSelectElement && target.dataset.routeKind) {
        const kind = target.dataset.routeKind;
        if (kind === 'templates' && !target.value) {
          this.navigate('/templates');
          return;
        }
        this.navigate(`/${kind}/${encodeURIComponent(target.value)}`);
        return;
      }
      if (target instanceof HTMLInputElement && target.type === 'file') {
        const form = target.closest('form');
        const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (submit) submit.disabled = !(target.files && target.files.length > 0);
      }
    });

    document.addEventListener('click', (event) => {
      const target = event.target as Node | null;
      for (const details of this.root.querySelectorAll<HTMLDetailsElement>('details[open]')) {
        if (target && !details.contains(target)) details.open = false;
      }
    });

    window.addEventListener('popstate', () => {
      this.path = readPath();
      void this.route();
    });
  }

  private findSession(publicId: string) {
    return this.sessions?.find((session) => session.public_id === publicId) || null;
  }
}

async function main() {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const config = await getAdminConfig();
  const runtime = new TemplateRuntime({ root, scope: 'admin' });
  const admin = new AdminApp(root, runtime, config.templateLayers);
  admin.bind();
  await admin.start();
}

void main();
