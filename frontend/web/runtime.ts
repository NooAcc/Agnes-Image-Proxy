/**
 * Shared browser runtime for the console: API helper, DOM helpers, toasts,
 * confirmation dialogs, formatting and theme control. Loaded before the
 * per-section scripts.
 */
export const RUNTIME_SCRIPT = String.raw`
(function () {
  "use strict";

  var THEME_KEY = "agnes-theme";
  var AUTO_REFRESH_KEY = "agnes-auto-refresh";
  var SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function iconNode(name) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }

  async function api(path, options) {
    var init = Object.assign({ credentials: "same-origin" }, options || {});
    var responseType = init.responseType;
    delete init.responseType;
    var response = await fetch(path, init);
    if (response.status === 204) return null;
    if (response.ok && responseType === "blob") return response.blob();
    var body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    if (!response.ok) {
      var message = body && body.error && body.error.message
        ? body.error.message
        : "请求失败（HTTP " + response.status + "）";
      var failure = new Error(message);
      failure.status = response.status;
      failure.body = body;
      throw failure;
    }
    return body;
  }

  function toast(message, tone) {
    var stack = document.querySelector('[data-role="toast-stack"]');
    if (!stack) return;
    var kind = tone === "error" ? "error" : (tone === "info" ? "info" : "ok");
    var node = el("div", "toast " + kind);
    node.append(iconNode(kind === "error" ? "alert" : (kind === "info" ? "info" : "check")));
    node.append(el("span", "toast-text", message));
    stack.append(node);
    while (stack.children.length > 3) stack.firstElementChild.remove();
    requestAnimationFrame(function () { node.classList.add("show"); });
    setTimeout(function () {
      node.classList.remove("show");
      setTimeout(function () { node.remove(); }, 240);
    }, 4200);
  }

  function confirmAction(options) {
    var dialog = document.querySelector('[data-role="confirm-dialog"]');
    if (!dialog || typeof dialog.showModal !== "function") {
      return Promise.resolve(window.confirm(options.message || options.title || "确认继续？"));
    }
    var titleNode = dialog.querySelector('[data-role="confirm-title"]');
    var descNode = dialog.querySelector('[data-role="confirm-desc"]');
    var accept = dialog.querySelector('[data-role="confirm-accept"]');
    titleNode.textContent = options.title || "确认操作";
    descNode.textContent = options.message || "";
    accept.textContent = options.confirmLabel || "确认";
    accept.className = options.tone === "danger" ? "btn danger" : "btn primary";
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise(function (resolve) {
      function onClose() {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "confirm");
      }
      dialog.addEventListener("close", onClose);
    });
  }

  function fmtNumber(value) {
    var number = Number(value);
    if (!isFinite(number)) return String(value);
    return number.toLocaleString("zh-CN");
  }

  // The IANA Etc/GMT names use the POSIX sign convention: -8 is UTC+8.
  var consoleTimeZone = "Etc/GMT-8";
  var dayFormatter = new Intl.DateTimeFormat("en", {
    timeZone: consoleTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });

  function consoleDay(value) {
    if (value == null || value === "") return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) return "";
    var parts = {};
    dayFormatter.formatToParts(date).forEach(function (part) { parts[part.type] = part.value; });
    return parts.year.padStart(4, "0") + "-" + parts.month + "-" + parts.day;
  }

  function fmtTime(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", {
      timeZone: consoleTimeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function fmtShortTime(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString("zh-CN", {
      timeZone: consoleTimeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    });
  }

  function fmtRelative(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    var delta = Date.now() - date.getTime();
    if (delta < 0) return fmtTime(value);
    if (delta < 60e3) return "刚刚";
    if (delta < 3600e3) return Math.floor(delta / 60e3) + " 分钟前";
    if (delta < 86400e3) return Math.floor(delta / 3600e3) + " 小时前";
    if (delta < 7 * 86400e3) return Math.floor(delta / 86400e3) + " 天前";
    return date.toLocaleDateString("zh-CN", { timeZone: consoleTimeZone });
  }

  function dayShort(day) {
    return typeof day === "string" && day.length >= 10 ? day.slice(5) : String(day || "");
  }

  function fmtDuration(ms) {
    var number = Number(ms);
    if (!isFinite(number)) return "—";
    if (number < 1000) return number + " ms";
    return (number / 1000).toFixed(number < 10000 ? 2 : 1) + " s";
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.idleHtml = button.innerHTML;
      button.replaceChildren(iconNode("clock"));
      var iconOnly = button.classList.contains("icon-only") || button.classList.contains("icon-btn");
      if (!iconOnly) button.append(document.createTextNode(label || "处理中…"));
      button.disabled = true;
      button.classList.add("is-busy");
      button.setAttribute("aria-busy", "true");
    } else {
      if (button.dataset.idleHtml) {
        button.innerHTML = button.dataset.idleHtml;
        delete button.dataset.idleHtml;
      }
      button.disabled = false;
      button.classList.remove("is-busy");
      button.removeAttribute("aria-busy");
    }
  }

  function badge(text, tone) {
    var node = el("span", "badge " + (tone || "muted"));
    node.append(el("span", "dot"));
    node.append(document.createTextNode(text));
    return node;
  }

  function setHealth(healthy, total) {
    var chip = document.querySelector('[data-role="health-chip"]');
    if (!chip) return;
    var label = chip.querySelector("[data-role=health-text]");
    var tone = "muted";
    var text = "Key 池 —";
    if (total === 0) {
      text = "未添加账号";
      tone = "warn";
    } else if (healthy === total) {
      text = "Key 池正常 " + healthy + "/" + total;
      tone = "ok";
    } else if (healthy === 0) {
      text = "Key 池不可用 0/" + total;
      tone = "bad";
    } else {
      text = "Key 池降级 " + healthy + "/" + total;
      tone = "warn";
    }
    if (label) label.textContent = text;
    chip.setAttribute("data-tone", tone);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) { /* fall through to the legacy path */ }
    var area = document.createElement("textarea");
    try {
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      return document.execCommand("copy");
    } catch (error) {
      return false;
    } finally {
      area.remove();
    }
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function syncThemeUi() {
    var button = document.querySelector('[data-action="toggle-theme"]');
    if (!button) return;
    var theme = currentTheme();
    var next = theme === "dark" ? "浅色" : "深色";
    button.setAttribute("aria-label", "切换到" + next + "主题");
    button.title = "切换到" + next + "主题";
    button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
  }

  function applyTheme(theme) {
    var next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* ignore */ }
    syncThemeUi();
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  var autoRefresh = (function () {
    var refreshers = {};
    var enabled = true;
    var intervalMs = 5000;
    var timer = null;
    var pausedBySelection = false;

    try {
      if (localStorage.getItem(AUTO_REFRESH_KEY) === "0") enabled = false;
    } catch (error) { /* ignore */ }

    function activeName() {
      var section = document.querySelector("[data-section].is-active");
      return section ? section.getAttribute("data-section") : null;
    }

    function syncUi() {
      var input = document.querySelector('[data-role="auto-refresh-toggle"]');
      if (input) input.checked = enabled;
      document.documentElement.setAttribute("data-auto-refresh", enabled ? "on" : "off");
    }

    function run(silent) {
      if (window.Agnes && window.Agnes.halted) return Promise.resolve();
      var name = activeName();
      var refresh = name ? refreshers[name] : null;
      if (!refresh) return Promise.resolve();
      return Promise.resolve(refresh(Boolean(silent))).catch(function () {
        /* sections report their own failures */
      });
    }

    function tick() {
      if (!enabled || document.hidden || pausedBySelection) return;
      if (window.Agnes && window.Agnes.halted) return;
      run(true);
    }

    function restart() {
      if (timer !== null) clearInterval(timer);
      timer = setInterval(tick, intervalMs);
    }

    function register(name, refresh) {
      refreshers[name] = refresh;
    }

    function setEnabled(next) {
      enabled = Boolean(next);
      try {
        localStorage.setItem(AUTO_REFRESH_KEY, enabled ? "1" : "0");
      } catch (error) { /* ignore */ }
      syncUi();
      if (enabled) run(true);
    }

    function setIntervalMs(next) {
      var value = Number(next);
      if (!isFinite(value) || value <= 0 || value === intervalMs) return;
      intervalMs = value;
      restart();
    }

    document.addEventListener("change", function (event) {
      var target = event.target;
      if (target && target.getAttribute &&
        target.getAttribute("data-action") === "toggle-auto-refresh") {
        setEnabled(target.checked);
      }
    });

    document.addEventListener("selectionchange", function () {
      pausedBySelection = String(window.getSelection() || "").trim().length > 0;
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && enabled) run(true);
    });

    // Navigation always loads the target section, even with auto refresh off.
    document.addEventListener("agnes:section", function () {
      run(false);
    });

    syncUi();
    restart();

    return {
      register: register,
      refreshNow: function () { return run(false); },
      setEnabled: setEnabled,
      setIntervalMs: setIntervalMs,
      isEnabled: function () { return enabled; },
    };
  })();

  window.Agnes = {
    api: api,
    el: el,
    icon: iconNode,
    toast: toast,
    confirm: confirmAction,
    fmtNumber: fmtNumber,
    consoleDay: consoleDay,
    fmtTime: fmtTime,
    fmtShortTime: fmtShortTime,
    fmtRelative: fmtRelative,
    fmtDuration: fmtDuration,
    dayShort: dayShort,
    setBusy: setBusy,
    badge: badge,
    setHealth: setHealth,
    debounce: debounce,
    copyText: copyText,
    currentTheme: currentTheme,
    syncThemeUi: syncThemeUi,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    autoRefresh: autoRefresh,
  };
})();
`;
