/**
 * Startup progress for the watcher in index.html: if a launch stalls, it
 * shows the last step reported here instead of a blank screen.
 */
type BootWatcher = { step(name: string): void; done(): void };

const watcher = (): BootWatcher | undefined =>
  (window as unknown as { brewlmBoot?: BootWatcher }).brewlmBoot;

export function bootStep(name: string): void {
  watcher()?.step(name);
}

/** Startup finished (or failed with its own error screen): hide the watcher. */
export function bootDone(): void {
  watcher()?.done();
}
