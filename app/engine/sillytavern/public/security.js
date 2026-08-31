"use strict";

(function exposeTavernUI(global) {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[character]));
  }

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function safeSameOriginTarget(value) {
    if (!value) return "";
    try {
      const target = new URL(String(value), global.location.href);
      if (!/^https?:$/.test(target.protocol) || target.origin !== global.location.origin) return "";
      return target.pathname + target.search + target.hash;
    } catch (_) {
      return "";
    }
  }

  global.TavernUI = Object.freeze({ escapeHtml, element, safeSameOriginTarget });
}(window));
