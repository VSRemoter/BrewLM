/** Which Settings section opens next (Settings → SettingsPage reads it once as it opens). */
export type SettingsSectionId = "appearance" | "ai" | "studio" | "audio" | "usage" | "data" | "phone" | "sync" | "sharing" | "about";

let next: SettingsSectionId | null = null;

/** Open Settings on this section next time (e.g. from a "BrewLM AI limit reached" notice). */
export function openSettingsAt(id: SettingsSectionId): void {
  next = id;
}

/** The section asked for, once; null for the default. */
export function takeSettingsSection(): SettingsSectionId | null {
  const id = next;
  next = null;
  return id;
}

const SECTION_EVENT = "brewlm:settings-section";

/** Switch the open Settings page to this section (SettingsPage listens). */
export function goToSettingsSection(id: SettingsSectionId): void {
  window.dispatchEvent(new CustomEvent(SECTION_EVENT, { detail: id }));
}

/** Listen for goToSettingsSection; returns the unsubscribe. */
export function onSettingsSection(fn: (id: SettingsSectionId) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<SettingsSectionId>).detail);
  window.addEventListener(SECTION_EVENT, handler);
  return () => window.removeEventListener(SECTION_EVENT, handler);
}

let planPicker = false;

/** Open the plan picker as Settings → Sync shows the account next (a "See plans" button). */
export function requestPlanPicker(): void {
  planPicker = true;
}

/** Whether the plan picker was asked for, once. */
export function takePlanPicker(): boolean {
  const asked = planPicker;
  planPicker = false;
  return asked;
}
