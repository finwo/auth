import { CircleAlert } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';

interface StatusPageAttrs {
  title: string;
  message: string;
  error?: boolean;
  action?: {
    href: string;
    label: string;
  };
}

export const StatusPage: m.Component<StatusPageAttrs> = {
  view({ attrs }) {
    return (
      <div class="status-page">
        <div class="status-panel">
          {attrs.error ? (
            Icon(CircleAlert, { class: 'status-icon' })
          ) : (
            <div class="spinner" aria-hidden="true"></div>
          )}
          <h1>{attrs.title}</h1>
          <p
            class={attrs.error ? 'status-error' : 'status-note'}
            role={attrs.error ? 'alert' : undefined}
          >
            {attrs.message}
          </p>
          {attrs.action ? (
            <div class="status-actions">
              <a class="button" href={attrs.action.href}>
                {attrs.action.label}
              </a>
            </div>
          ) : null}
        </div>
      </div>
    );
  },
};
