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
