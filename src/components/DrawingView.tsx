/**
 * Studio → Drawings: a sketchpad (Excalidraw) for quick notes, diagrams and
 * working math by hand — e.g. while an Audio Overview plays in the mini
 * player. Like other outputs it takes over the Studio panel, so the chat stays
 * usable alongside it, and can go full screen. Saves as you draw; drawings are
 * never sent to the AI.
 */
import { Download, Maximize2, Minimize2, PenLine, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getArtifact, renameArtifact, updateArtifact } from "../lib/db";
import { platform } from "../platform";
import type { Artifact } from "../lib/types";
import type { DrawingApi } from "./DrawingCanvas";
import { IconButton } from "./ui";

const DrawingCanvas = lazy(() => import("./DrawingCanvas"));

/** Keystroke-to-disk delay for drawing and renaming. */
const SAVE_DELAY_MS = 600;

export default function DrawingView({
  artifact,
  dark,
  onClose,
}: {
  artifact: Artifact;
  /** Match Excalidraw's light/dark UI to the app theme. */
  dark: boolean;
  /** Minimize: back to the Studio tools and saved outputs. */
  onClose: () => void;
}) {
  const [title, setTitle] = useState(artifact.title);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [exportError, setExportError] = useState<string | null>(null);
  /** Shown over the whole window instead of in the panel. */
  const [expanded, setExpanded] = useState(false);
  const apiRef = useRef<DrawingApi | null>(null);
  /** The scene as last saved — read fresh so a quick close-and-reopen never loses strokes. */
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getArtifact(artifact.id)
      .then((a) => live && setData(a?.data ?? artifact.data))
      .catch(() => live && setData(artifact.data));
    return () => {
      live = false;
    };
  }, [artifact.id, artifact.data]);
  const pending = useRef<{ data?: string; title?: string }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { data, title: t } = pending.current;
    pending.current = {};
    if (data === undefined && t === undefined) return;
    try {
      if (data !== undefined) await updateArtifact(artifact.id, data);
      if (t !== undefined) await renameArtifact(artifact.id, t.trim() || "Drawing");
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [artifact.id]);

  const queue = (p: { data?: string; title?: string }) => {
    pending.current = { ...pending.current, ...p };
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const close = async () => {
    await flush();
    onClose();
  };

  // Save anything pending if the view goes away another way.
  useEffect(() => () => void flush(), [flush]);

  // Let the audio mini player step out of Excalidraw's corner controls.
  useEffect(() => {
    document.documentElement.dataset.drawing = expanded ? "full" : "panel";
    return () => {
      delete document.documentElement.dataset.drawing;
    };
  }, [expanded]);

  // The canvas is restyled, not remounted, when going full screen — tell
  // Excalidraw it moved so pointer positions line up again.
  useEffect(() => {
    apiRef.current?.refresh();
  }, [expanded]);

  const downloadPng = async () => {
    const api = apiRef.current;
    if (!api) return;
    setExportError(null);
    try {
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: dark },
        files: api.getFiles(),
        mimeType: "image/png",
      });
      const base = (title.replace(/[/\\?%*:|"<>]/g, "").trim() || "drawing").slice(0, 60);
      await platform.saveFile({
        defaultName: `${base}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    } catch (e) {
      setExportError(`Couldn't export: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div
      className={
        expanded
          ? "anim-fade fixed inset-0 z-50 flex flex-col bg-canvas text-ink"
          : "anim-fade flex h-full min-h-0 flex-col"
      }
      role={expanded ? "dialog" : "region"}
      aria-label={title}
    >
      <div
        className={`flex h-11 shrink-0 items-center gap-1 border-b border-edge-soft ${expanded ? "bg-panel px-3" : "px-2"}`}
      >
        {expanded ? (
          <PenLine size={15} strokeWidth={1.8} className="mx-1 shrink-0 text-ink-2" />
        ) : (
          <IconButton onClick={close} label="Minimize — back to Studio">
            <Minimize2 size={15} strokeWidth={1.8} />
          </IconButton>
        )}
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            queue({ title: e.target.value });
          }}
          aria-label="Drawing name"
          className="min-w-0 max-w-sm flex-1 rounded-md bg-transparent px-1.5 py-1 text-[13px] font-semibold tracking-tight outline-none hover:bg-hover focus:bg-hover"
        />
        <span className="shrink-0 px-1 text-[11px] text-ink-3">
          {status === "saving" ? "Saving…" : status === "error" ? "Couldn't save" : "Saved"}
        </span>
        {expanded && <span className="flex-1" />}
        <IconButton onClick={downloadPng} label="Download as PNG">
          <Download size={15} strokeWidth={1.8} />
        </IconButton>
        {expanded ? (
          <IconButton onClick={() => setExpanded(false)} label="Exit full screen">
            <X size={16} strokeWidth={1.8} />
          </IconButton>
        ) : (
          <IconButton onClick={() => setExpanded(true)} label="Full screen">
            <Maximize2 size={15} strokeWidth={1.8} />
          </IconButton>
        )}
      </div>
      {exportError && (
        <p className="mx-3 mt-3 rounded-lg border border-danger-edge bg-danger-bg px-3 py-2 text-[12px] leading-snug text-danger">
          {exportError}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<CanvasLoading />}>
          {data === null ? (
            <CanvasLoading />
          ) : (
            <DrawingCanvas
              data={data}
              dark={dark}
              onSceneChange={(scene) => queue({ data: scene })}
              onReady={(api) => (apiRef.current = api)}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}

function CanvasLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
    </div>
  );
}
