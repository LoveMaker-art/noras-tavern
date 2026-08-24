/* bridge.js — Tavern frontend to same-origin runtime bridge. */
(function (global) {
  "use strict";
  async function event(ev) {
    try {
      const r = await fetch("/api/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        const error = new Error(data.error || ("HTTP " + r.status));
        error.status = r.status;
        error.code = data.code || "";
        error.data = data;
        throw error;
      }
      return data;
    } catch (err) {
      console.error("[bridge] event failed:", ev.type, err);
      throw err;
    }
  }
  async function get(path) {
    const r = await fetch(path);
    return r.json();
  }
  async function generate(ev, signal) {
    try {
      const r = await fetch("/api/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
        signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
      const result = data.message || (data.reply ? { role: "char", text: data.reply } : {}) || {};
      if (result && typeof result === "object") result._event = data;
      return result;
    } catch (err) {
      console.error("[bridge] generation failed:", ev.type, err);
      throw err;
    }
  }
  async function audioRequest(path, payload, signal) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || ("HTTP " + r.status));
    }
    return r.blob();
  }
  async function speech(text, signal) {
    return audioRequest("/api/tts", { text }, signal);
  }
  async function speechPreview(payload, signal) {
    return audioRequest("/api/tts/preview", payload, signal);
  }
  async function saveVoiceClone(payload) {
    const r = await fetch("/api/tts/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
    return data;
  }
  global.bridge = { event, get, generate, speech, speechPreview, saveVoiceClone };
})(window);
