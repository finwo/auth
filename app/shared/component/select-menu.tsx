import { Check, ChevronDown } from 'lucide';
import m from 'mithril';
import { Icon } from '@component/icon';
import '@style/select-menu.css';

let nextSelectId = 0;

export interface SelectMenuOption {
  value: string;
  label: string;
}

export interface SelectMenuAttrs {
  id?: string;
  label?: string;
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  value: string;
  options: SelectMenuOption[];
  onchange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  autoWidth?: boolean;
}

export class SelectMenu implements m.ClassComponent<SelectMenuAttrs> {
  private instanceId = `select-${++nextSelectId}`;
  private attrs!: SelectMenuAttrs;
  private root?: HTMLElement;
  private trigger?: HTMLButtonElement;
  private list?: HTMLElement;
  private open = false;
  private activeIndex = -1;
  private typeahead = '';
  private typeaheadTimer = 0;
  private fitSignature = '';
  private handleDocumentClick?: (event: MouseEvent) => void;
  private handleViewportChange?: () => void;
  private handleScroll?: () => void;

  oncreate(vnode: m.VnodeDOM<SelectMenuAttrs>) {
    this.attrs = vnode.attrs;
    this.root = vnode.dom as HTMLElement;
    this.trigger = this.root.querySelector('.select-trigger') as HTMLButtonElement;
    this.list = this.root.querySelector('.select-list') as HTMLElement;

    this.handleDocumentClick = (event: MouseEvent) => {
      if (this.open && event.target instanceof Node && !this.root?.contains(event.target)) {
        this.closePopup(false);
      }
    };
    this.handleViewportChange = () => {
      this.updateFitWidth();
      if (this.open) this.positionPopup();
    };
    this.handleScroll = () => {
      if (this.open) this.positionPopup();
    };

    document.addEventListener('click', this.handleDocumentClick);
    window.addEventListener('resize', this.handleViewportChange, { passive: true });
    window.addEventListener('scroll', this.handleScroll, { capture: true, passive: true });

    this.updateFitWidth();
  }

  onupdate(vnode: m.VnodeDOM<SelectMenuAttrs>) {
    this.attrs = vnode.attrs;

    if (this.attrs.disabled && this.open) this.closePopup(false);

    this.updateFitWidth();
    if (this.open) this.positionPopup();
  }

  onremove() {
    if (this.handleDocumentClick) document.removeEventListener('click', this.handleDocumentClick);
    if (this.handleViewportChange) window.removeEventListener('resize', this.handleViewportChange);
    if (this.handleScroll) window.removeEventListener('scroll', this.handleScroll, true);
    window.clearTimeout(this.typeaheadTimer);
  }

  view({ attrs }) {
    const triggerId = attrs.id || this.instanceId;
    const listId = `${triggerId}-listbox`;
    const labelId = `${triggerId}-label`;
    const labelIdUsed = !attrs.labelledBy && attrs.label ? labelId : undefined;
    const selected = attrs.options.find((option) => option.value === attrs.value);
    const selectedLabel = selected?.label || attrs.placeholder || '';
    const classNames = ['select', attrs.autoWidth ? 'select-auto' : '', attrs.className || '']
      .filter(Boolean)
      .join(' ');
    const activeId = this.open && this.activeIndex >= 0 ? `${triggerId}-option-${this.activeIndex}` : undefined;

    return (
      <div class={classNames}>
        {labelIdUsed ? <span id={labelId} class="sr-only">{attrs.label}</span> : null}
        <button
          class="select-trigger"
          type="button"
          id={triggerId}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={String(this.open)}
          aria-controls={listId}
          aria-labelledby={attrs.labelledBy || labelIdUsed || undefined}
          aria-label={attrs.labelledBy || attrs.label || attrs.ariaLabel ? attrs.ariaLabel : undefined}
          aria-describedby={attrs.describedBy}
          aria-activedescendant={activeId}
          disabled={attrs.disabled}
          onclick={() => {
            if (attrs.disabled) return;
            if (this.open) this.closePopup(true);
            else this.openPopup(this.selectedIndex());
          }}
          onkeydown={(event: KeyboardEvent) => this.handleKeydown(event)}
        >
          <span class="select-value">{selectedLabel}</span>
          {Icon(ChevronDown)}
        </button>
        <div
          class="select-list"
          id={listId}
          role="listbox"
          hidden={!this.open}
          aria-labelledby={attrs.labelledBy || labelIdUsed || undefined}
          aria-label={attrs.labelledBy || attrs.label ? undefined : attrs.ariaLabel}
        >
          {attrs.options.map((option, index) => {
            const isSelected = option.value === attrs.value;
            const isActive = this.open && index === this.activeIndex;
            const optionClass = [
              'select-option',
              isSelected ? 'is-selected' : '',
              isActive ? 'is-active' : '',
            ].filter(Boolean).join(' ');

            return (
              <div
                class={optionClass}
                id={`${triggerId}-option-${index}`}
                role="option"
                aria-selected={String(isSelected)}
                onclick={(event: MouseEvent) => {
                  event.preventDefault();
                  this.selectOption(index);
                }}
              >
                <span class="select-option-label">{option.label}</span>
                <span class="select-option-mark" aria-hidden="true">
                  {Icon(Check)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  private selectedIndex() {
    const index = this.attrs.options.findIndex((option) => option.value === this.attrs.value);

    return index >= 0 ? index : 0;
  }

  private boundedIndex(index: number) {
    const options = this.attrs.options;
    if (!options.length) return -1;

    return Math.max(0, Math.min(index, options.length - 1));
  }

  private openPopup(index: number) {
    if (this.attrs.disabled || !this.attrs.options.length) return;

    this.open = true;
    this.activeIndex = this.boundedIndex(index);
    m.redraw.sync();
    this.positionPopup();
    this.scrollActiveOption();
  }

  private closePopup(focusTrigger: boolean) {
    if (!this.open) return;

    this.open = false;
    this.activeIndex = -1;
    this.typeahead = '';
    window.clearTimeout(this.typeaheadTimer);
    m.redraw.sync();

    if (focusTrigger) this.trigger?.focus();
  }

  private selectOption(index: number) {
    const option = this.attrs.options[index];
    if (!option) return;

    const attrs = this.attrs;
    this.open = false;
    this.activeIndex = -1;
    this.typeahead = '';
    window.clearTimeout(this.typeaheadTimer);
    m.redraw.sync();
    attrs.onchange(option.value);

    if (this.root?.isConnected && document.activeElement !== this.trigger) this.trigger?.focus();
  }

  private activateOption(index: number) {
    if (!this.open) return;

    this.activeIndex = this.boundedIndex(index);
    m.redraw.sync();
    this.scrollActiveOption();
  }

  private findMatch(query: string) {
    const options = this.attrs.options;
    if (!options.length) return -1;

    const start = (this.activeIndex + 1) % options.length;

    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length;
      if (options[index].label.toLowerCase().startsWith(query.toLowerCase())) return index;
    }

    return -1;
  }

  private handleKeydown(event: KeyboardEvent) {
    const attrs = this.attrs;
    if (!attrs || attrs.disabled || event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === 'Escape') {
      if (!this.open) return;
      event.preventDefault();
      event.stopPropagation();
      this.closePopup(true);
      return;
    }

    if (event.key === 'Tab') {
      if (this.open) this.closePopup(false);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!this.open) this.openPopup(0);
      else this.activateOption(this.activeIndex + 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.open) this.openPopup(attrs.options.length - 1);
      else this.activateOption(this.activeIndex - 1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      if (!this.open) this.openPopup(0);
      else this.activateOption(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      if (!this.open) this.openPopup(attrs.options.length - 1);
      else this.activateOption(attrs.options.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!this.open) this.openPopup(this.selectedIndex());
      else this.selectOption(this.activeIndex);
      return;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      if (!this.open) this.openPopup(0);

      this.typeahead += event.key;
      window.clearTimeout(this.typeaheadTimer);
      this.typeaheadTimer = window.setTimeout(() => {
        this.typeahead = '';
      }, 500);

      const match = this.findMatch(this.typeahead);
      if (match >= 0) this.activateOption(match);
    }
  }

  private scrollActiveOption() {
    const list = this.list;
    if (!list || this.activeIndex < 0) return;

    const option = list.children[this.activeIndex] as HTMLElement | undefined;
    if (!option) return;

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;

    if (optionTop < list.scrollTop) {
      list.scrollTop = optionTop;
      return;
    }

    if (optionBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = optionBottom - list.clientHeight;
    }
  }

  private rootFontSize() {
    const size = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);

    return Number.isFinite(size) && size > 0 ? size : 16;
  }

  private updateFitWidth() {
    const signature = `${this.attrs.options.length}:${this.attrs.options.map((option) => option.label).join('\u0000')}`;
    if (signature === this.fitSignature || this.open) return;

    this.fitSignature = signature;
    this.fitWidth();
  }

  private fitWidth() {
    const root = this.root;
    const list = this.list;
    if (!root || !list || !root.classList.contains('select-auto') || this.open) return;

    const wasHidden = list.hasAttribute('hidden');
    list.removeAttribute('hidden');
    list.classList.add('is-measuring');

    const font = this.rootFontSize();
    const containerWidth = root.getBoundingClientRect().width;
    const measuredWidth = Math.max(containerWidth, list.getBoundingClientRect().width);
    const allowedWidth = Math.min(measuredWidth, window.innerWidth - font);

    root.style.minWidth = `${allowedWidth / font}rem`;

    list.classList.remove('is-measuring');
    if (wasHidden) list.setAttribute('hidden', '');
  }

  private positionPopup() {
    const list = this.list;
    const trigger = this.trigger;
    if (!this.open || !list || !trigger) return;

    const font = this.rootFontSize();
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth / font;
    const listWidth = Math.min(rect.width / font, viewportWidth - 1);
    const spaceBelow = (window.innerHeight - rect.bottom) / font - 0.5;
    const spaceAbove = rect.top / font - 0.5;
    const openBelow = spaceBelow >= spaceAbove;
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    const listHeight = Math.max(5, Math.min(18, availableHeight));

    list.style.width = `${listWidth}rem`;
    list.style.maxHeight = `${listHeight}rem`;
    list.style.right = 'auto';
    list.style.left = `${Math.max(0, Math.min(rect.left / font, viewportWidth - listWidth))}rem`;

    if (openBelow) {
      list.style.top = `${rect.bottom / font}rem`;
      list.style.bottom = 'auto';
    } else {
      list.style.top = 'auto';
      list.style.bottom = `${(window.innerHeight - rect.top) / font}rem`;
    }
  }
}
