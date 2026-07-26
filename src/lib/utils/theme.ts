// Shared light/dark theme detection, driven by DaisyUI's `data-theme` on <html> (the source's
// convention), falling back to the OS `prefers-color-scheme`. The 2D and 3D canvases use this so they
// follow whatever theme the app is in.

export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/** Subscribe to theme changes (data-theme attribute or OS scheme). Returns an unsubscribe fn. */
export function onThemeChange(cb: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
  mq?.addEventListener?.('change', cb);
  return () => { obs.disconnect(); mq?.removeEventListener?.('change', cb); };
}

/** Flip the app between the DaisyUI 'light' and 'dark' themes (persisted to localStorage). */
export function toggleTheme(): 'light' | 'dark' {
  const next = isDarkTheme() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  return next;
}

/** Apply the persisted theme (call once on app start). */
export function applyStoredTheme(): void {
  if (typeof document === 'undefined') return;
  try {
    const t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch { /* ignore */ }
}
