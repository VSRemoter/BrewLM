/** Settings → AI Model → Web search: where research, /search and /fetch find pages (webSearch.ts). */
import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { SearchService, Settings } from "../../lib/types";
import { normalizeSearxngUrl, SEARCH_SERVICE_LABELS, searchWithService } from "../../lib/webSearch";
import { Spinner } from "../ui";
import { Card } from "./controls";

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

const KEY_LINKS: Partial<Record<SearchService, string>> = {
  brave: "https://api-dashboard.search.brave.com/app/keys",
  tavily: "https://app.tavily.com/home",
};

type TestState = { state: "idle" } | { state: "testing" } | { state: "ok"; count: number; first: string } | { state: "error"; message: string };

export default function WebSearchCard({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const service = settings.searchService;
  const local = settings.provider === "local";
  const [test, setTest] = useState<TestState>({ state: "idle" });
  useEffect(() => setTest({ state: "idle" }), [service, settings.searxngUrl, settings.braveKey, settings.tavilyKey]);

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const results = await searchWithService("open source note taking apps", settings, { count: 5 });
      setTest({ state: "ok", count: results.length, first: results[0]?.title ?? "" });
    } catch (e) {
      setTest({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const keyField = service === "brave" ? "braveKey" : "tavilyKey";
  const ready =
    service === "searxng" ? !!settings.searxngUrl.trim() : service === "auto" ? false : !!settings[keyField].trim();

  return (
    <Card>
      <div className="py-3">
        <div className="text-[13px] font-medium text-ink">Web search</div>
        <div className="mt-0.5 mb-2.5 text-[12px] leading-relaxed text-ink-3">
          Finds pages for Deep Research, <code>/search</code> and <code>/fetch</code>. Automatic uses your AI
          provider's own search{local ? ", which local models don't have" : ""}. A search service works with
          any model, local ones included: it only finds the pages, and your model reads them and writes.
        </div>
        <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-canvas p-1">
          {(Object.keys(SEARCH_SERVICE_LABELS) as SearchService[]).map((s) => (
            <button
              key={s}
              onClick={() => patch({ searchService: s })}
              className={`rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors ${
                service === s ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {SEARCH_SERVICE_LABELS[s]}
            </button>
          ))}
        </div>

        {service === "auto" && local && (
          <p className="mt-2 text-[12px] leading-relaxed text-warn">
            With a local model, pick a search service to use Deep Research, <code>/search</code> and{" "}
            <code>/fetch</code>. SearXNG runs on your computer, so nothing leaves it but the searches themselves.
          </p>
        )}

        {service === "searxng" && (
          <div className="mt-3">
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink-2">SearXNG address</label>
            <input
              value={settings.searxngUrl}
              onChange={(e) => patch({ searxngUrl: e.target.value })}
              onBlur={(e) => {
                const url = normalizeSearxngUrl(e.target.value);
                if (url !== e.target.value) patch({ searxngUrl: url });
              }}
              placeholder="http://localhost:8888"
              className={inputClass}
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
              A self-hosted metasearch engine. Its JSON output must be on: add <code>json</code> to{" "}
              <code>search: formats:</code> in its settings.yml.
            </p>
          </div>
        )}

        {(service === "brave" || service === "tavily") && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[12.5px] font-medium text-ink-2">{SEARCH_SERVICE_LABELS[service]} API key</label>
              <a
                href={KEY_LINKS[service]}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[12px] text-link hover:underline"
              >
                Get a key <ExternalLink size={11} />
              </a>
            </div>
            <input
              type="password"
              value={settings[keyField]}
              onChange={(e) => patch({ [keyField]: e.target.value } as Partial<Settings>)}
              placeholder={service === "brave" ? "BSA…" : "tvly-…"}
              className={inputClass}
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
              Your searches go to {SEARCH_SERVICE_LABELS[service]}; your sources and chats don't. Both have a
              free monthly allowance.
            </p>
          </div>
        )}

        {service !== "auto" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void runTest()}
              disabled={!ready || test.state === "testing"}
              className="flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:opacity-40"
            >
              {test.state === "testing" ? <Spinner size={12} /> : <RefreshCw size={12} />}
              Test search
            </button>
            {test.state === "ok" && (
              <span className="text-[12px] text-ok">
                {test.count === 0 ? "It answered, but found nothing." : `Found ${test.count} results, starting with “${test.first}”.`}
              </span>
            )}
            {test.state === "error" && <span className="text-[12px] leading-relaxed text-danger">{test.message}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}
