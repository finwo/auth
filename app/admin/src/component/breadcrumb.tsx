import m from 'mithril';
import { appUrl } from '../util/api';

export interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface BreadcrumbAttrs {
  items: BreadcrumbItem[];
}

export const Breadcrumb: m.Component<BreadcrumbAttrs> = {
  view({ attrs }) {
    return (
      <div class="breadcrumb">
        {attrs.items.map((item, index) => {
          const isCurrent = index === attrs.items.length - 1 || !item.path;
          return [
            index > 0 ? <span aria-hidden="true">/</span> : null,
            isCurrent ? (
              <span aria-current={index === attrs.items.length - 1 ? 'page' : undefined}>
                {item.label}
              </span>
            ) : (
              <a
                href={appUrl(item.path!)}
                onclick={(event: Event) => {
                  event.preventDefault();
                  m.route.set(item.path!);
                }}
              >
                {item.label}
              </a>
            ),
          ];
        })}
      </div>
    );
  },
};
