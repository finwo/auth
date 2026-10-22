export type Theme = 'auto' | 'light' | 'dark';

const THEME_KEY = 'auth_theme';
const THEMES: Theme[] = ['auto', 'light', 'dark'];

export function getTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    return 'auto';
  }
  return 'auto';
}

export function applyTheme(theme: Theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
  applyTheme(theme);
}

export function cycleTheme(): Theme {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  setTheme(next);
  return next;
}

export function themeLabel(theme: Theme) {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}
