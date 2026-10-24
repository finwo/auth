import { X } from 'lucide';
import m from 'mithril';
import { Icon } from './icon';

export interface ModalAttrs {
  title: string;
  onClose: () => void;
}

export const Modal: m.Component<ModalAttrs> = {
  oncreate(this: any, vnode: m.Vnode<ModalAttrs>) {
    this.focusBefore = document.activeElement;
    this.onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') vnode.attrs.onClose();
    };
    window.addEventListener('keydown', this.onKeydown);
    const target = vnode.dom?.querySelector('[data-modal-autofocus]') as HTMLElement | null;
    target?.focus();
  },

  onremove(this: any) {
    window.removeEventListener('keydown', this.onKeydown);
    (this.focusBefore as HTMLElement | null)?.focus?.();
  },

  view({ attrs, children }) {
    return (
      <div
        class="modal-overlay"
        onmousedown={(event: MouseEvent) => {
          if (event.target === event.currentTarget) attrs.onClose();
        }}
      >
        <div
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-label={attrs.title}
          tabindex="-1"
        >
          <div class="modal-header">
            <h2 id={`modal-${attrs.title}`}>{attrs.title}</h2>
            <button
              class="modal-close"
              type="button"
              aria-label="Close dialog"
              data-modal-autofocus
              onclick={() => attrs.onClose()}
            >
              {Icon(X)}
            </button>
          </div>
          <div class="modal-body">{children}</div>
        </div>
      </div>
    );
  },
};
