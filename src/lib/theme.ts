// Shared by the theme toggle (client) and the root layout (server).

export const THEME_STORAGE_KEY = 'festival-broadcaster.theme';

/**
 * Runs before the page paints (inlined in layout.tsx) so there is no flash of the wrong theme.
 * Uses the saved choice, or the device's light/dark setting when nothing is saved.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
