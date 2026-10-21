/**
 * The Excalidraw canvas behind Studio → Drawings. Loaded lazily (it's a few
 * MB), so the rest of BrewLM doesn't pay for it until a drawing is opened.
 */
import { Excalidraw, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useMemo, useRef } from "react";

// Fonts come from public/excalidraw (copied on npm install), so drawing works
// offline; anything missing there falls back to Excalidraw's CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";

type ExcalidrawProps = Parameters<typeof Excalidraw>[0];
type InitialData = NonNullable<Exclude<ExcalidrawProps["initialData"], Promise<unknown> | (() => unknown)>>;
export type DrawingApi = Parameters<NonNullable<ExcalidrawProps["excalidrawAPI"]>>[0];

/** What a drawing artifact stores. */
export interface DrawingScene {
  elements: readonly unknown[];
  files: Record<string, unknown>;
  background?: string;
}

export function parseDrawing(data: string): DrawingScene {
  try {
    const d = JSON.parse(data);
    return {
      elements: Array.isArray(d?.elements) ? d.elements : [],
      files: d?.files && typeof d.files === "object" ? d.files : {},
      background: typeof d?.background === "string" ? d.background : undefined,
    };
  } catch {
    return { elements: [], files: {} };
  }
}

export default function DrawingCanvas({
  data,
  dark,
  onSceneChange,
  onReady,
}: {
  data: string;
  dark: boolean;
  /** Called with the serialized scene whenever the drawing itself changes. */
  onSceneChange: (data: string) => void;
  onReady?: (api: DrawingApi) => void;
}) {
  // Only the first value matters — Excalidraw owns the scene after mount.
  const initialData = useMemo<InitialData>(() => {
    const scene = parseDrawing(data);
    return {
      elements: scene.elements as InitialData["elements"],
      files: scene.files as InitialData["files"],
      appState: scene.background ? { viewBackgroundColor: scene.background } : undefined,
      scrollToContent: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Skip onChange calls that are only selection / scroll / zoom. */
  const lastKey = useRef<string | null>(null);

  return (
    <Excalidraw
      initialData={initialData}
      theme={dark ? "dark" : "light"}
      excalidrawAPI={onReady}
      // BrewLM handles saving, downloading and theming itself.
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          saveAsImage: false,
          toggleTheme: false,
        },
      }}
      onChange={(elements, appState, files) => {
        const key = `${getSceneVersion(elements)}:${Object.keys(files).length}:${appState.viewBackgroundColor}`;
        if (lastKey.current === null) {
          lastKey.current = key; // the initial load isn't an edit
          return;
        }
        if (key === lastKey.current) return;
        lastKey.current = key;
        const scene: DrawingScene = {
          elements: elements.filter((e) => !e.isDeleted),
          files,
          background: appState.viewBackgroundColor,
        };
        onSceneChange(JSON.stringify(scene));
      }}
    />
  );
}
