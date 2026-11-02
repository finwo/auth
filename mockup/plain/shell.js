(() => {
  const root = document.documentElement;
  const nav = document.getElementById('mobile-navigation');
  const toggle = document.getElementById('mobile-nav-toggle');
  const main = document.querySelector('.main');
  const desktop = window.matchMedia('(min-width: 60em)');

  if (nav && toggle) {
    const setOpen = (open) => {
      nav.classList.toggle('is-open', open);
      nav.setAttribute('aria-hidden', open ? 'false' : 'true');
      toggle.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      root.classList.toggle('mobile-nav-open', open);

      if (main) main.inert = open;
    };

    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

    toggle.addEventListener('click', () => setOpen(!isOpen()));

    nav.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest('.nav-item')) {
        setOpen(false);
        return;
      }

      if (!target.closest('.user-menu-item, button, a')) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });

    desktop.addEventListener('change', (event) => {
      if (event.matches) setOpen(false);
    });

    if (desktop.matches) setOpen(false);
  }

  const selects = [];
  let selectId = 0;

  const nextId = (prefix) => {
    selectId += 1;
    return `${prefix}-${selectId}`;
  };

  const fontSize = () => {
    const size = Number.parseFloat(window.getComputedStyle(root).fontSize);

    return Number.isFinite(size) && size > 0 ? size : 16;
  };

  const toRem = (value) => {
    const rounded = Math.round((value / fontSize()) * 100) / 100;

    return `${rounded < 0 ? 0 : rounded}rem`;
  };

  const fitSelectWidth = (select) => {
    const previousHidden = select.list.hidden;
    select.list.hidden = false;
    select.list.classList.add('is-measuring');

    const containerWidth = select.container.getBoundingClientRect().width;

    if (containerWidth > 0) {
      const measuredWidth = Math.max(containerWidth, select.list.getBoundingClientRect().width);
      const allowedWidth = Math.min(measuredWidth, window.innerWidth - fontSize());

      select.container.style.minWidth = `${allowedWidth / fontSize()}rem`;
    }

    select.list.classList.remove('is-measuring');
    select.list.hidden = previousHidden;
  };

  const activeOption = (select) => {
    if (select.activeIndex < 0) return null;

    return select.options[select.activeIndex] || null;
  };

  const setActive = (select, index, scroll) => {
    const options = select.options;
    if (!options.length) return;

    const nextIndex = Math.max(0, Math.min(index, options.length - 1));

    if (select.activeIndex === nextIndex) {
      if (scroll) scrollActiveOption(select);

      return;
    }

    options.forEach((option, optionIndex) => {
      option.classList.toggle('is-active', optionIndex === nextIndex);
    });

    select.activeIndex = nextIndex;

    const option = options[nextIndex];
    if (!option) return;

    select.trigger.setAttribute('aria-activedescendant', option.id);
    if (scroll) scrollActiveOption(select);
  };

  const scrollActiveOption = (select) => {
    const option = activeOption(select);
    if (!option) return;

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;

    if (optionTop < select.list.scrollTop) {
      select.list.scrollTop = optionTop;
      return;
    }

    if (optionBottom > select.list.scrollTop + select.list.clientHeight) {
      select.list.scrollTop = optionBottom - select.list.clientHeight;
    }
  };

  const positionSelect = (select) => {
    if (!select.open) return;

    const triggerRect = select.trigger.getBoundingClientRect();
    const rootFontSize = fontSize();
    const viewportWidth = window.innerWidth / rootFontSize;
    const triggerLeft = triggerRect.left / rootFontSize;
    const listWidth = Math.min(triggerRect.width / rootFontSize, viewportWidth - 1);
    const spaceBelow = (window.innerHeight - triggerRect.bottom) / rootFontSize - 0.5;
    const spaceAbove = triggerRect.top / rootFontSize - 0.5;
    const openBelow = spaceBelow >= spaceAbove;
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    const listHeight = Math.max(5, Math.min(18, availableHeight));

    select.list.style.width = `${listWidth}rem`;
    select.list.style.maxHeight = `${listHeight}rem`;
    select.list.style.right = 'auto';
    select.list.style.left = `${Math.max(0, Math.min(triggerLeft, viewportWidth - listWidth))}rem`;

    if (openBelow) {
      select.list.style.top = `${triggerRect.bottom / rootFontSize}rem`;
      select.list.style.bottom = 'auto';
    } else {
      select.list.style.top = 'auto';
      select.list.style.bottom = `${(window.innerHeight - triggerRect.top) / rootFontSize}rem`;
    }
  };

  const openSelect = (select, index) => {
    if (select.open || select.trigger.disabled || !select.options.length) return;

    select.open = true;
    select.list.hidden = false;
    select.trigger.setAttribute('aria-expanded', 'true');
    setActive(select, index, false);
    positionSelect(select);
  };

  const closeSelect = (select, focusTrigger) => {
    if (!select.open) return;

    select.open = false;
    select.list.hidden = true;
    select.list.style.width = '';
    select.list.style.maxHeight = '';
    select.list.style.left = '';
    select.list.style.right = '';
    select.list.style.top = '';
    select.list.style.bottom = '';
    select.trigger.removeAttribute('aria-activedescendant');
    select.trigger.setAttribute('aria-expanded', 'false');
    select.activeIndex = -1;
    select.typeahead = '';
    select.options.forEach((option) => option.classList.remove('is-active'));

    if (focusTrigger) select.trigger.focus();
  };

  const selectOption = (select, index) => {
    const option = select.options[index];
    if (!option) return;

    const value = option.dataset.value || option.textContent.trim();
    const label = option.querySelector('.select-option-label').textContent;

    select.container.dataset.value = value;
    select.value.textContent = label;
    select.options.forEach((candidate, candidateIndex) => {
      const selected = candidateIndex === index;
      candidate.classList.toggle('is-selected', selected);
      candidate.setAttribute('aria-selected', selected ? 'true' : 'false');
    });

    closeSelect(select, true);
  };

  const findSelected = (select) => {
    const index = select.options.findIndex((option) => option.classList.contains('is-selected'));

    return index >= 0 ? index : 0;
  };

  const findMatch = (select, query) => {
    const start = select.activeIndex + 1;

    for (let offset = 0; offset < select.options.length; offset += 1) {
      const index = (start + offset) % select.options.length;
      const label = select.options[index].dataset.label || '';
      if (label.toLowerCase().startsWith(query.toLowerCase())) return index;
    }

    return -1;
  };

  document.querySelectorAll('[data-select]').forEach((container) => {
    const trigger = container.querySelector('.select-trigger');
    const list = container.querySelector('.select-list');
    const options = Array.from(container.querySelectorAll('.select-option'));
    if (!trigger || !list || !options.length) return;

    if (!trigger.id) trigger.id = nextId('select-trigger');
    if (!list.id) list.id = nextId('select-list');
    options.forEach((option, index) => {
      if (!option.id) option.id = `${list.id}-option-${index + 1}`;
      if (!option.dataset.label) option.dataset.label = option.textContent.trim();
    });

    const select = {
      container,
      trigger,
      list,
      options,
      value: trigger.querySelector('.select-value'),
      open: false,
      activeIndex: -1,
      typeahead: '',
      typeaheadTimer: 0,
    };

    selects.push(select);

    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', list.id);
    list.setAttribute('role', 'listbox');
    if (!list.getAttribute('aria-labelledby')) {
      list.setAttribute('aria-labelledby', trigger.getAttribute('aria-labelledby') || trigger.id);
    }

    if (!container.dataset.value) {
      const selected = options.find((option) => option.classList.contains('is-selected'));
      container.dataset.value = selected ? selected.dataset.value || selected.textContent.trim() : '';
    }

    options.forEach((option) => {
      option.setAttribute('role', 'option');
      option.tabIndex = -1;
    });

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (select.open) closeSelect(select, true);
      else openSelect(select, findSelected(select));
    });

    trigger.addEventListener('keydown', (event) => {
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '];
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.key === 'Escape') {
        if (!select.open) return;
        event.preventDefault();
        event.stopPropagation();
        closeSelect(select, true);
        return;
      }

      if (event.key === 'Tab') {
        closeSelect(select, false);
        return;
      }

      if (!keys.includes(event.key) && event.key.length === 1) {
        event.preventDefault();
        if (!select.open) openSelect(select, 0);
        select.typeahead += event.key;
        window.clearTimeout(select.typeaheadTimer);
        select.typeaheadTimer = window.setTimeout(() => {
          select.typeahead = '';
        }, 500);

        const match = findMatch(select, select.typeahead);
        if (match >= 0) setActive(select, match, true);

        return;
      }

      if (!keys.includes(event.key)) return;

      event.preventDefault();

      if (!select.open) {
        openSelect(select, event.key === 'ArrowUp' ? select.options.length - 1 : 0);
        return;
      }

      if (event.key === 'Home') setActive(select, 0, true);
      else if (event.key === 'End') setActive(select, select.options.length - 1, true);
      else if (event.key === 'ArrowDown') setActive(select, select.activeIndex + 1, true);
      else if (event.key === 'ArrowUp') setActive(select, select.activeIndex - 1, true);
      else if (event.key === 'Enter' || event.key === ' ') selectOption(select, select.activeIndex);
    });

    options.forEach((option, index) => {
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        selectOption(select, index);
      });
    });

    fitSelectWidth(select);
    closeSelect(select, false);
  });

  const refitSelectWidths = () => {
    selects.forEach((select) => fitSelectWidth(select));
    repositionOpenSelects();
  };

  document.addEventListener('click', (event) => {
    const target = event.target;

    selects.forEach((select) => {
      if (select.open && (!(target instanceof Node) || !select.container.contains(target))) {
        closeSelect(select, false);
      }
    });
  });

  const repositionOpenSelects = () => {
    selects.forEach((select) => positionSelect(select));
  };

  window.addEventListener('resize', refitSelectWidths);
  window.addEventListener('scroll', repositionOpenSelects, true);
})();
