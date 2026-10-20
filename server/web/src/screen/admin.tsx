import m from 'mithril';
import { getSession, signOut, type ApiError, type SessionInfo } from '../util/api';

export const Admin: m.Component = {
  session: null as SessionInfo | null,
  error: null as Error | null,
  pending: false,

  oninit(this: any) {
    this.load();
  },

  async load(this: any) {
    try {
      this.session = await getSession();
      document.title = this.session.realm?.display_name || 'Identity';
    } catch (e) {
      const error = e as ApiError;
      if (error.status === 401) {
        m.route.set('/oidc/admin/login');
        return;
      }
      this.error = error;
    }
    m.redraw();
  },

  async signOut(this: any) {
    this.pending = true;
    this.error = null;
    try {
      await signOut();
      m.route.set('/oidc/admin/login');
    } catch (e) {
      this.error = e as Error;
      this.pending = false;
      m.redraw();
    }
  },

  view(this: any) {
    const session = this.session;
    const branding = session?.realm?.branding || {};
    const primary = typeof branding.primary_color === 'string' ? branding.primary_color : '#25A';
    const style = { '--realm-primary': primary } as any;

    if (!session) {
      return (
        <div class="auth-page" style={style}>
          <div class="auth-card">
            <h1>Admin</h1>
            {this.error ? <p class="auth-error">{this.error.message}</p> : <p class="auth-note">Loading</p>}
          </div>
        </div>
      );
    }

    return (
      <div class="auth-page" style={style}>
        <div class="auth-card">
          <h1>{session.realm?.display_name || 'Identity'}</h1>
          <p class="auth-identifier">
            Signed in as {session.user.display_name || session.user.username}
          </p>
          <p class="auth-note">{session.user.username}</p>
          <p class="auth-note">
            {session.roles.length > 0 ? `Roles: ${session.roles.join(', ')}` : 'No realm roles'}
          </p>
          {this.error ? <p class="auth-error">{this.error.message}</p> : null}
          <div class="auth-actions">
            <button class="auth-button" type="button" disabled={this.pending} onclick={() => this.signOut()}>
              {this.pending ? 'Signing out' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    );
  },
};
