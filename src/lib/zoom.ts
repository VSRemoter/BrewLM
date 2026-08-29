/**
 * App-wide UI zoom. The ⌘+/⌘−/⌘0 shortcuts (main.tsx) and Settings →
 * Appearance → Text size share this one store. Persisted in localStorage —
 * not the settings table — because it must apply synchronously before the DB
 * connection opens (no unscaled flash at startup).
 */
const ZOOM_KEY = "om.zoom";
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 1.6;

function clamp(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}

let zoom = clamp(Number(localStorage.getItem(ZOOM_KEY)) || 1);

export function getZoom(): number {
  return zoom;
}

export function applyZoom(): void {
  document.documentElement.style.setProperty("zoom", String(zoom));
  // vh-based lengths are scaled by root zoom, so modals must divide by it
  // to keep their rendered height inside the actual window.
  document.documentElement.style.setProperty("--om-zoom", String(zoom));
}

/** Clamps, persists, and applies. Returns the value actually set. */
export function setZoom(v: number): number {
  zoom = clamp(Math.round(v * 100) / 100);
  localStorage.setItem(ZOOM_KEY, String(zoom));
  applyZoom();
  return zoom;
}
