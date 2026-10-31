
/* Tiny appearance control for the independent GitHub Pages HTML prototype. */
(() => {
  const key = "sehrawat-theme";
  let dark = false;
  try { dark = localStorage.getItem(key) === "dark"; } catch {}
  const apply = () => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const button = document.getElementById("premium-theme-switch");
    if (button) {
      button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      button.setAttribute("title", dark ? "Light theme" : "Dark theme");
      button.setAttribute("aria-pressed", String(dark));
      button.innerHTML = dark
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.9 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.9 13.2Z"/></svg>';
    }
  };
  apply();
  const mount = () => {
    if (document.getElementById("premium-theme-switch")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "premium-theme-switch";
    button.className = "premium-theme-switch";
    button.addEventListener("click", () => {
      dark = !dark;
      try { localStorage.setItem(key,dark ? "dark" : "light"); } catch {}
      apply();
    });
    document.body.appendChild(button);
    apply();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",mount,{once:true});
  else mount();
})();
