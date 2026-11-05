/**
 * Open someone's shared notebook link: pasted here, or (web app) arrived at
 * through `/s/<id>#<key>`. Downloads it as a read-only notebook and opens it.
 */
import { useEffect, useRef, useState } from "react";
import { parseShareUrl, type Progress } from "../lib/shareLinks";
import { notebookForShare, openSharedLink } from "../lib/shareView";
import { Modal, PrimaryButton, Spinner } from "./ui";

export default function OpenLinkDialog({
  initial,
  onOpened,
  onClose,
}: {
  /** A link to open straight away (the web app's address); none = ask for one. */
  initial?: { id: string; secret: Uint8Array };
  onOpened: (notebookId: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const open = async (link: { id: string; secret: Uint8Array }) => {
    setBusy(true);
    setError(null);
    try {
      // Opened before: show it now; its banner offers any update.
      const known = await notebookForShare(link.id);
      onOpened(known ?? (await openSharedLink(link.id, link.secret, setProgress)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initial && !started.current) {
      started.current = true;
      void open(initial);
    }
  });

  const parsed = parseShareUrl(text);
  return (
    <Modal title="Open a shared notebook" onClose={busy ? () => {} : onClose}>
      {!initial && (
        <>
          <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink-3">
            Paste a BrewLM link someone sent you. The notebook opens read-only; save a copy to make it your own.
          </p>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && parsed && !busy && void open(parsed)}
            placeholder="https://app.brewlm.com/s/…"
            disabled={busy}
            className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
            aria-label="Shared link"
          />
          {text.trim() && !parsed && (
            <p className="mt-1.5 text-[11.5px] text-ink-3">That doesn't look like a whole BrewLM link: it ends with # and a key.</p>
          )}
        </>
      )}
      {busy && (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
          <Spinner size={12} />
          Opening…
          {progress && progress.total > 1 && ` ${progress.done} of ${progress.total} files`}
        </p>
      )}
      {error && <p className="mt-3 text-[12px] leading-relaxed text-danger">{error}</p>}
      {!initial && (
        <div className="mt-4 flex justify-end">
          <PrimaryButton disabled={!parsed || busy} onClick={() => parsed && void open(parsed)}>
            Open
          </PrimaryButton>
        </div>
      )}
    </Modal>
  );
}
