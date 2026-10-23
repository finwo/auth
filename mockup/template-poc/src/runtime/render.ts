import Handlebars from 'handlebars';
import type { TemplateAssets } from './assets';
import type { TemplateSet } from './types';

const decoder = new TextDecoder();

export class TemplateRenderer {
  private handlebars = Handlebars.create();
  private pages = new Map<string, Handlebars.TemplateDelegate>();

  constructor(
    private templates: TemplateSet,
    private assets: TemplateAssets
  ) {
    this.handlebars.registerHelper('eq', (left, right) => left === right);
    this.handlebars.registerHelper('ne', (left, right) => left !== right);
    this.handlebars.registerHelper('not', (value) => !value);
    this.handlebars.registerHelper('and', (...values) => {
      values.pop();
      return values.every(Boolean);
    });
    this.handlebars.registerHelper('or', (...values) => {
      values.pop();
      return values.some(Boolean);
    });
    this.handlebars.registerHelper('includes', (values, value) =>
      Array.isArray(values) ? values.includes(value) : false
    );
    this.handlebars.registerHelper('themeLabel', (value) => {
      if (value === 'light') return 'Light';
      if (value === 'dark') return 'Dark';
      return 'Auto';
    });

    for (const [path, file] of templates.files) {
      if (!path.endsWith('.hbs')) continue;
      const name = path.slice(0, -4);
      this.handlebars.registerPartial(name, decoder.decode(file.data));
    }
  }

  render(page: string, data: Record<string, unknown>) {
    const path = page.endsWith('.hbs') ? page : `${page}.hbs`;
    const file = this.templates.files.get(path);
    if (!file) throw new Error(`Missing page template: ${path}`);

    let template = this.pages.get(path);
    if (!template) {
      template = this.handlebars.compile(decoder.decode(file.data), {
        noEscape: false,
        strict: false,
      });
      this.pages.set(path, template);
    }

    return this.assets.rewriteHtml(template(data), path);
  }
}
