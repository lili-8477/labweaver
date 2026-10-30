// UI color theme: "colorful" (liquid glass over the ambient glow, the
// default) or "dark" (gray on near-black). The choice is per browser; it is
// applied as data-theme on <html>, which App.vue's tokens key off.

export type Theme = 'colorful' | 'dark'

const KEY = 'labweaver.theme'

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'colorful'
  } catch {
    return 'colorful'
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try { localStorage.setItem(KEY, theme) } catch { /* private mode: not remembered */ }
}
