export type ActionHandler = (element: HTMLElement, event: Event) => void;
export type FormHandler = (form: HTMLFormElement, data: FormData) => void;

export function bindActions(
  root: HTMLElement,
  actions: Record<string, ActionHandler>,
  forms: Record<string, FormHandler>,
  navigate: (path: string) => void
) {
  root.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const action = target?.closest<HTMLElement>('[data-action]');
    if (action) {
      const handler = actions[action.dataset.action || ''];
      if (handler) {
        event.preventDefault();
        handler(action, event);
        return;
      }
    }

    const route = target?.closest<HTMLElement>('[data-route]');
    if (route) {
      event.preventDefault();
      navigate(route.dataset.route || '');
    }
  });

  root.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form) return;
    const handler = forms[form.dataset.form || ''];
    if (!handler) return;
    event.preventDefault();
    handler(form, new FormData(form));
  });
}
