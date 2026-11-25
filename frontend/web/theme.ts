/**
 * Runs in <head> before the stylesheet paints, so the saved theme is applied
 * without a flash. Defaults to the system preference on first visit.
 */
export const THEME_INIT_SCRIPT = String.raw`
(function () {
  try {
    var saved = localStorage.getItem("agnes-theme");
    if (saved !== "light" && saved !== "dark") {
      saved = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    }
    document.documentElement.dataset.theme = saved;
  } catch (error) {
    document.documentElement.dataset.theme = "dark";
  }
})();
`;
