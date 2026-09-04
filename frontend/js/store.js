// Shared settings state with a minimal pub/sub so views react to changes.
import { api } from "./api.js";

const listeners = new Set();
let settings = null;

export const store = {
  get: () => settings,
  async load() {
    settings = await api.getSettings();
    emit();
    return settings;
  },
  // Persist a partial patch (deep-merged server-side), then update locally.
  async save(patch) {
    settings = await api.saveSettings(patch);
    emit();
    return settings;
  },
  subscribe(fn) {
    listeners.add(fn);
    if (settings) fn(settings);
    return () => listeners.delete(fn);
  },
};

function emit() {
  for (const fn of listeners) {
    try { fn(settings); } catch (e) { console.error(e); }
  }
}
