/**
 * Console bootstrap: confirm the session and storage state before any section
 * query runs, then gate every management request on readiness. The function is
 * embedded into the built browser asset with `toString()`, so it must stay
 * self-contained plain JavaScript and receive collaborators as arguments.
 */

import { safeAdminDestination } from "./contracts.ts";

/**
 * @param {any} win
 * @param {(raw: string) => string} safeAdminDestination
 * @returns {Promise<boolean>}
 */
export function runBootstrap(win, safeAdminDestination) {
  const A = win.Agnes;
  const doc = win.document;
  const location = win.location;
  let halted = false;
  let resolveReady = null;
  const ready = new win.Promise(function (resolve) {
    resolveReady = resolve;
  });

  A.ready = ready;
  A.halted = false;
  A.readyState = "booting";

  function destination() {
    return safeAdminDestination(location.pathname + (location.hash || ""));
  }

  function halt(state) {
    halted = true;
    A.halted = true;
    A.readyState = state || "halted";
  }

  function redirectFor(error) {
    if (error && error.status === 401) {
      halt("halted");
      location.replace("/admin/login?next=" + encodeURIComponent(destination()));
      return true;
    }
    if (
      error && error.status === 503 && error.body && error.body.error &&
      error.body.error.code === "initialization_required"
    ) {
      halt("halted");
      location.replace("/admin/setup");
      return true;
    }
    return false;
  }

  const originalApi = A.api;
  A.api = function (path, options) {
    if (halted) return win.Promise.reject(new Error("请求已停止"));
    const gated = typeof path === "string" && path.indexOf("/admin/api/") === 0 &&
      path.indexOf("/admin/api/session") !== 0 &&
      path.indexOf("/admin/api/storage") !== 0;
    const start = gated ? ready : win.Promise.resolve(true);
    return start.then(function () {
      if (halted) throw new Error("请求已停止");
      if (gated && A.readyState !== "ready") throw new Error("管理接口尚未就绪");
      return originalApi.call(A, path, options);
    }).catch(function (error) {
      redirectFor(error);
      throw error;
    });
  };

  function requestJSON(path) {
    return win.fetch(path, { credentials: "same-origin" }).then(function (response) {
      return response.json().catch(function () {
        return null;
      }).then(function (body) {
        if (!response.ok) {
          const message = body && body.error && body.error.message
            ? body.error.message
            : "HTTP " + response.status;
          const error = new Error(message);
          error.status = response.status;
          error.body = body;
          throw error;
        }
        return body;
      });
    });
  }

  function bootErrorNode() {
    return doc && doc.querySelector ? doc.querySelector('[data-role="boot-error"]') : null;
  }

  function revealBody() {
    if (doc.documentElement && doc.documentElement.classList) {
      doc.documentElement.classList.remove("is-booting");
    }
    if (doc.body && doc.body.classList) doc.body.classList.remove("is-booting");
  }

  function showRetry(message) {
    revealBody();
    const box = bootErrorNode();
    if (box) {
      const text = box.querySelector('[data-role="boot-error-text"]');
      if (text) text.textContent = message;
      box.hidden = false;
    }
  }

  function hideRetry() {
    const box = bootErrorNode();
    if (box) box.hidden = true;
  }

  function setReady() {
    A.readyState = "ready";
    revealBody();
    if (doc.documentElement && doc.documentElement.classList) {
      doc.documentElement.classList.add("is-ready");
    }
    if (A.autoRefresh && typeof A.autoRefresh.refreshNow === "function") {
      A.autoRefresh.refreshNow();
    }
    if (typeof doc.dispatchEvent === "function" && typeof win.CustomEvent === "function") {
      doc.dispatchEvent(new win.CustomEvent("agnes:ready"));
    }
  }

  function check() {
    hideRetry();
    return requestJSON("/admin/api/session").then(function () {
      return requestJSON("/admin/api/storage");
    }).then(function (storage) {
      if (!storage || storage.initialized !== true) {
        halt("halted");
        location.replace("/admin/setup");
        resolveReady(false);
        return false;
      }
      setReady();
      resolveReady(true);
      return true;
    }).catch(function (error) {
      if (redirectFor(error)) {
        resolveReady(false);
        return false;
      }
      A.readyState = "error";
      showRetry(
        error && error.status
          ? "无法确认登录或存储状态（HTTP " + error.status + "），请重试。"
          : "网络错误，无法连接管理接口，请重试。",
      );
      resolveReady(false);
      return false;
    });
  }

  const retryButton = doc && doc.querySelector
    ? doc.querySelector('[data-action="boot-retry"]')
    : null;
  if (retryButton && typeof retryButton.addEventListener === "function") {
    retryButton.addEventListener("click", function () {
      check();
    });
  }

  return check();
}

/** Browser script installed after the runtime and before the section scripts. */
export const BOOTSTRAP_SCRIPT = String.raw`
(function () {
  "use strict";
  var safeAdminDestination = ${safeAdminDestination.toString()};
  var runBootstrap = ${runBootstrap.toString()};
  runBootstrap(window, safeAdminDestination);
})();
`;
