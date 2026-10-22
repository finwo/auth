import m from 'mithril';

interface PageHeaderAttrs {
  title: string;
  subtitle?: string;
  row?: boolean;
}

export const PageHeader: m.Component<PageHeaderAttrs> = {
  view({ attrs, children }) {
    const className = `page-header${attrs.row ? ' page-header-row' : ''}`;
    return (
      <div class={className}>
        <div>
          <h1>{attrs.title}</h1>
          {attrs.subtitle ? <p>{attrs.subtitle}</p> : null}
        </div>
        {children}
      </div>
    );
  },
};
