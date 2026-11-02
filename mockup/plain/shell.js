(() => {
  const root = document.documentElement;
  const nav = document.getElementById('mobile-navigation');
  const toggle = document.getElementById('mobile-nav-toggle');
  const main = document.querySelector('.main');
  const desktop = window.matchMedia('(min-width: 60em)');

  if (!nav || !toggle) return;

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
})();
