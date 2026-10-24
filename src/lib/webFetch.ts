/**
 * Reading pages on the open web (links added as sources, YouTube transcripts).
 * The desktop app fetches them itself, through Rust (no CORS). A browser can't
 * read most sites from another site's page, so the web app asks the sync
 * server to fetch them (sync-server/src/fetch.ts): same page, same Response.
 */
import { platform } from "../platform";
import { fetchThroughServer } from "./sync";

export interface WebFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export function fetchWebPage(url: string, init: WebFetchInit = {}): Promise<Response> {
  if (platform.kind === "desktop") return platform.fetch(url, { ...init, connectTimeout: 20000 });
  return fetchThroughServer(url, init);
}
