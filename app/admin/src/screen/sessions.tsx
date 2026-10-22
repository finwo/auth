import m from 'mithril';
import type { AdminRealm, AdminSession } from '../util/api';
import {
  loadAdminSessions,
  revokeAdminSessionRealm,
  terminateAdminSession,
} from '../util/auth';
import { formatTime, scopeLabel } from '../util/format';

interface SessionsAttrs {
  realmSlug: string | null;
  realms: AdminRealm[] | null;
  realmsError: Error | null;
  onAuthExpired: () => void;
}

type SessionAction = 'realm' | 'terminate';

function actionKey(action: SessionAction, session: AdminSession) {
  return `${action}:${session.public_id}`;
}

export const SessionsPage: m.Component<SessionsAttrs> = {
  attrs: null as SessionsAttrs | null,
  loadedRealm: null as string | null,
  loading: false,
  redirecting: false,
  sessions: null as AdminSession[] | null,
  error: null as Error | null,
  notice: null as string | null,
  confirmKey: null as string | null,
  pendingKey: null as string | null,

  oninit(this: any, vnode: m.Vnode<SessionsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  onupdate(this: any, vnode: m.Vnode<SessionsAttrs>) {
    this.attrs = vnode.attrs;
    this.ensure();
  },

  ensure(this: any) {
    const { realms, realmSlug } = this.attrs;
    if (!realms) return;

    if (realms.length === 0) {
      this.sessions = [];
      this.loading = false;
      this.error = null;
      return;
    }

    const selected = realmSlug && realms.some((realm) => realm.slug === realmSlug);
    if (!selected) {
      if (!this.redirecting) {
        this.redirecting = true;
        m.route.set(`/sessions/${encodeURIComponent(realms[0].slug)}`, null, {
          replace: true,
        });
      }
      return;
    }

    this.redirecting = false;
    if (this.loadedRealm !== realmSlug) {
      this.load(realmSlug);
    }
  },

  async load(this: any, realmSlug: string) {
    this.loadedRealm = realmSlug;
    this.loading = true;
    this.error = null;
    this.sessions = null;
    m.redraw();

    try {
      const sessions = await loadAdminSessions(realmSlug);
      if (this.loadedRealm === realmSlug) this.sessions = sessions;
    } catch (e: any) {
      if (this.loadedRealm !== realmSlug) return;
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      if (this.loadedRealm === realmSlug) this.loading = false;
      m.redraw();
    }
  },

  async act(this: any, session: AdminSession, action: SessionAction) {
    const { realmSlug } = this.attrs;
    if (!realmSlug) return;

    const key = actionKey(action, session);
    this.pendingKey = key;
    this.error = null;
    this.notice = null;

    try {
      if (action === 'realm') {
        await revokeAdminSessionRealm(realmSlug, session.public_id);
        this.notice =
          'Realm access revoked. The next authorization for this realm requires re-verification.';
      } else {
        await terminateAdminSession(realmSlug, session.public_id);
        this.notice = 'Session terminated.';
      }
      this.confirmKey = null;
      await this.load(realmSlug);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 400) {
        this.attrs.onAuthExpired();
        return;
      }
      this.error = e as Error;
    } finally {
      this.pendingKey = null;
      m.redraw();
    }
  },

  view(this: any) {
    const { realms, realmsError } = this.attrs;
    const selected =
      realms?.find((realm) => realm.slug === this.attrs.realmSlug) || realms?.[0] || null;

    return (
      <div class="admin-sessions">
        <div class="admin-page-header admin-page-header-row">
          <div>
            <h1>Sessions</h1>
            <p>Active sessions with access to this realm.</p>
          </div>
          {realms && realms.length > 1 ? (
            <label class="admin-realm-select">
              <span>Realm</span>
              <select
                value={selected?.slug || ''}
                onchange={(event: Event) => {
                  const value = (event.target as HTMLSelectElement).value;
                  this.notice = null;
                  m.route.set(`/sessions/${encodeURIComponent(value)}`);
                }}
              >
                {realms.map((realm) => (
                  <option value={realm.slug}>{realm.display_name}</option>
                ))}
              </select>
            </label>
          ) : selected ? (
            <span class="admin-realm-current">{selected.display_name}</span>
          ) : null}
        </div>

        {realmsError ? (
          <div class="admin-alert" role="alert">
            {realmsError.message}
          </div>
        ) : null}

        {this.error ? (
          <div class="admin-alert" role="alert">
            <p>{this.error.message}</p>
            {this.attrs.realmSlug ? (
              <button
                class="admin-button-secondary"
                type="button"
                onclick={() => this.load(this.attrs.realmSlug)}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {this.notice ? (
          <div class="admin-notice" role="status">
            {this.notice}
          </div>
        ) : null}

        {!realms ? (
          <div class="admin-loading">Loading realms</div>
        ) : realms.length === 0 ? (
          <div class="admin-empty">
            <p>No realms are available for this account.</p>
          </div>
        ) : this.loading || this.redirecting ? (
          <div class="admin-session-stack" aria-busy="true">
            <div class="admin-session-skeleton">
              <div class="admin-skeleton admin-skeleton-title"></div>
              <div class="admin-skeleton"></div>
              <div class="admin-skeleton admin-skeleton-short"></div>
            </div>
            <div class="admin-session-skeleton">
              <div class="admin-skeleton admin-skeleton-title"></div>
              <div class="admin-skeleton"></div>
              <div class="admin-skeleton admin-skeleton-short"></div>
            </div>
          </div>
        ) : this.sessions && this.sessions.length > 0 ? (
          <div class="admin-session-stack">
            {this.sessions.map((session: AdminSession) => {
              const realmKey = actionKey('realm', session);
              const terminateKey = actionKey('terminate', session);
              const pending = this.pendingKey;
              const revokePending = pending === realmKey;
              const terminatePending = pending === terminateKey;

              return (
                <article class="admin-session">
                  <div class="admin-session-header">
                    <div>
                      <h2>{session.user.display_name || session.user.username}</h2>
                      <p class="admin-session-user">
                        {session.user.username}
                        {session.user.status !== 'active'
                          ? ` · ${session.user.status}`
                          : ''}
                      </p>
                    </div>
                    {session.revoked_at ? (
                      <span class="admin-session-badge">
                        Realm access revoked {formatTime(session.revoked_at)}
                      </span>
                    ) : null}
                  </div>

                  <dl class="admin-definition admin-session-details">
                    <div>
                      <dt>Scope</dt>
                      <dd>{scopeLabel(session.scope.type)}</dd>
                    </div>
                    <div>
                      <dt>Host</dt>
                      <dd>{session.scope.host || 'Canonical'}</dd>
                    </div>
                    <div>
                      <dt>Client</dt>
                      <dd>{session.scope.client_id || 'None'}</dd>
                    </div>
                    <div>
                      <dt>Last seen</dt>
                      <dd>{formatTime(session.last_seen_at)}</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{formatTime(session.expires_at)}</dd>
                    </div>
                    <div>
                      <dt>Address</dt>
                      <dd>{session.ip || 'Unknown'}</dd>
                    </div>
                  </dl>

                  {session.user_agent ? (
                    <p class="admin-session-agent">{session.user_agent}</p>
                  ) : null}

                  <div class="admin-session-actions">
                    {session.revoked_at ? null : this.confirmKey === realmKey ? (
                      <div class="admin-confirm">
                        <span>Revoke this realm’s access?</span>
                        <button
                          class="admin-button"
                          type="button"
                          disabled={Boolean(pending)}
                          onclick={() => this.act(session, 'realm')}
                        >
                          {revokePending ? 'Revoking' : 'Confirm'}
                        </button>
                        <button
                          class="admin-button-secondary"
                          type="button"
                          disabled={Boolean(pending)}
                          onclick={() => {
                            this.confirmKey = null;
                            m.redraw();
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        class="admin-button-secondary"
                        type="button"
                        disabled={Boolean(pending)}
                        onclick={() => {
                          this.confirmKey = realmKey;
                          m.redraw();
                        }}
                      >
                        Revoke realm access
                      </button>
                    )}

                    {session.can_terminate ? (
                      this.confirmKey === terminateKey ? (
                        <div class="admin-confirm">
                          <span>Terminate this session?</span>
                          <button
                            class="admin-button admin-button-danger"
                            type="button"
                            disabled={Boolean(pending)}
                            onclick={() => this.act(session, 'terminate')}
                          >
                            {terminatePending ? 'Terminating' : 'Confirm'}
                          </button>
                          <button
                            class="admin-button-secondary"
                            type="button"
                            disabled={Boolean(pending)}
                            onclick={() => {
                              this.confirmKey = null;
                              m.redraw();
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          class="admin-button-danger"
                          type="button"
                          disabled={Boolean(pending)}
                          onclick={() => {
                            this.confirmKey = terminateKey;
                            m.redraw();
                          }}
                        >
                          Terminate session
                        </button>
                      )
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div class="admin-empty">
            <p>No active sessions with access to this realm.</p>
          </div>
        )}
      </div>
    );
  },
};
