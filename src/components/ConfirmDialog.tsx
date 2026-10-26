/**
 * "Are you sure?" before deleting things. Any handler can
 * `if (!(await confirmAction({...}))) return;` — the one <ConfirmHost />
 * mounted in App shows the dialog. Cancel holds focus, so a stray Enter
 * never deletes anything.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./ui";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** Label of the destructive button. Default: "Delete". */
  confirmLabel?: string;
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void };

let showDialog: ((r: Request) => void) | null = null;

export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (!showDialog) {
    const text = typeof opts.message === "string" ? `${opts.title}\n\n${opts.message}` : opts.title;
    return Promise.resolve(window.confirm(text));
  }
  return new Promise((resolve) => showDialog!({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    showDialog = (r) =>
      setReq((cur) => {
        cur?.resolve(false); // a newer request replaces one still open
        return r;
      });
    return () => {
      showDialog = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const close = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };

  if (!req) return null;
  return (
    <Modal title={req.title} onClose={() => close(false)}>
      <div className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">{req.message}</div>
      <div className="flex justify-end gap-2">
        <button
          ref={cancelRef}
          onClick={() => close(false)}
          className="rounded-full border border-edge bg-panel px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-hover-soft"
        >
          Cancel
        </button>
        <button
          onClick={() => close(true)}
          className="rounded-full bg-danger px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-85"
        >
          {req.confirmLabel ?? "Delete"}
        </button>
      </div>
    </Modal>
  );
}
