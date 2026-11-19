/** Settings → Sharing: every shared link, with its views and size, to copy or stop. */
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getDb } from "../../lib/db";
import { fetchShareInfo, listShares, shareUrl, stopSharing, type ShareInfo, type ShareRow } from "../../lib/shareLinks";
import { formatBytes } from "../../lib/storage";
import { confirmAction } from "../ConfirmDialog";
import { Spinner } from "../ui";
import { Card, Footnote, SectionTitle } from "./controls";
import { useSyncStatus } from "./SyncSection";

const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default function SharingSection() {
  const sync = useSyncStatus();
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [info, setInfo] = useState<Map<string, ShareInfo>>(new Map());
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await listShares();
    const d = await getDb();
    const nbs = await d.select<{ id: string; title: string }[]>("SELECT id, title FROM notebooks");
    setTitles(new Map(nbs.map((n) => [n.id, n.title])));
    setRows(list);
    if (sync.account) fetchShareInfo().then(setInfo, () => {});
  }, [sync.account]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (r: ShareRow) => {
    await navigator.clipboard.writeText(shareUrl(r)).catch(() => {});
    setCopied(r.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const stop = async (r: ShareRow) => {
    const ok = await confirmAction({
      title: "Stop sharing?",
      message: "The link stops working for everyone right away. Copies people already saved stay theirs.",
      confirmLabel: "Stop sharing",
    });
    if (!ok) return;
    setError(null);
    try {
      await stopSharing(r);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <SectionTitle
        title="Sharing"
        desc="Read-only links to your notebooks. Anyone with a link can read the notebook and save a copy; to share or update one, open the notebook and press Share."
      />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <p className="py-3 text-[12.5px] text-ink-3">No shared links yet.</p>
        </Card>
      ) : (
        <Card>
          {rows.map((r) => {
            const i = info.get(r.id);
            return (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">
                    {titles.get(r.notebook_id) ?? "Deleted notebook"}
                    {r.label && <span className="font-normal text-ink-3"> · {r.label}</span>}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    Updated {when(r.updated_at || r.created_at)}
                    {i && ` · ${i.views} ${i.views === 1 ? "view" : "views"} · ${formatBytes(i.bytes)}`}
                    {r.expires_at ? ` · until ${when(r.expires_at)}` : ""}
                    {i?.disabled && " · taken down"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => void copy(r)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-hover-soft"
                  >
                    {copied === r.id ? <Check size={13} /> : <Copy size={13} />}
                    {copied === r.id ? "Copied" : "Copy link"}
                  </button>
                  <button
                    onClick={() => void stop(r)}
                    className="rounded-md px-2 py-1 text-[12px] font-medium text-danger hover:bg-danger-bg"
                  >
                    Stop
                  </button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
      {error && <p className="mb-4 text-[12px] text-danger">{error}</p>}
      <Footnote>
        Links count toward your Sync storage. Deleting a notebook for good stops its link too.
      </Footnote>
    </div>
  );
}
