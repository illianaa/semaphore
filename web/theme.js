// Light or dark before the first paint. "system" (the default) follows the computer's
// appearance; the top-bar button cycles System → Light → Dark and remembers the choice.
// A classic script in <head>, so the page never flashes the wrong palette.
(() => {
  const KEY = "semaphore:theme";
  const ORDER = ["system", "light", "dark"];
  const NAMES = { system: "System", light: "Light", dark: "Dark" };
  const root = document.documentElement;
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => {
    try {
      const value = localStorage.getItem(KEY);
      return ORDER.includes(value) ? value : "system";
    } catch {
      return "system";
    }
  };
  let preference = saved();

  function apply() {
    const theme = preference === "system" ? (systemDark.matches ? "dark" : "light") : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0a0f0c" : "#fafbf9");
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
    const current = preference === "system" ? `System (${NAMES[theme].toLowerCase()})` : NAMES[preference];
    button.setAttribute("aria-label", `Theme: ${current}. Switch to ${NAMES[next]}`);
    button.title = `Theme: ${current} · click for ${NAMES[next]}`;
  }

  // A change after load recolours everything at once, instead of fading control by control.
  function change() {
    root.dataset.themeSwitching = "";
    apply();
    requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.themeSwitching));
  }

  apply();
  systemDark.addEventListener("change", () => {
    if (preference === "system") change();
  });
  // Another Semaphore window (such as Companion) changed the theme.
  addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    preference = saved();
    change();
  });
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      preference = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
      try {
        if (preference === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, preference);
      } catch {}
      change();
    });
    apply();
  });
})();
