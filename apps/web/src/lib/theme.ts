export type ThemePref = "dark" | "light" | "system";

const KEY = "aatmiq.theme";

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {}
  return "dark";
}

export function applyTheme(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
}

/** Runs before paint to avoid a theme flash. Dark is the default. */
export const themeBootScript = `(function(){try{var p=localStorage.getItem("${KEY}")||"dark";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";}catch(e){document.documentElement.dataset.theme="dark";}})();`;

/** Use the org logo as the tab icon (or put the product icon back). */
export function applyFavicon(url: string | null | undefined): void {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  links.forEach((l) => {
    if (!l.dataset.original) l.dataset.original = l.href;
    l.href = url ? new URL(url, window.location.href).href : l.dataset.original;
  });
}

/** Set the org accent color and a readable foreground for text on it. */
export function applyAccent(hex: string | null | undefined): void {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-fg", lum > 0.36 ? "#041014" : "#ffffff");
}
