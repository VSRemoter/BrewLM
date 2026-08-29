import { invoke } from "@tauri-apps/api/core";
import { Download, FolderOpen, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import {
  dbFilePath,
  exportBackup,
  factoryReset,
  importBackup,
  revealDataFolder,
} from "../../lib/backup";
import type { Settings } from "../../lib/types";
import { GhostButton, Modal, Segmented } from "../ui";
import { Card, Footnote, Row, SectionTitle } from "./controls";

export default function DataSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [dbPath, setDbPath] = useState("");
  const [busy, setBusy] = useState<"export" | null>(null);
  const [exportedTo, setExportedTo] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    dbFilePath().then(setDbPath).catch(() => {});
  }, []);

  const doExport = async () => {
    setBusy("export");
    setExportedTo(null);
    try {
      const dest = await exportBackup();
      if (dest) setExportedTo(dest);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmImport = async () => {
    setImportError(null);
    try {
      // The Rust server holds the DB open while sharing — refuse the swap.
      const share = await invoke<{ url: string | null } | null>("share_status").catch(() => null);
      if (share) {
        setImportOpen(false);
        setImportError("Stop phone sharing first (Phone Pairing section), then import again.");
        return;
      }
      await importBackup(); // opens the picker; reloads the window on success
      setImportOpen(false);
    } catch (e) {
      setImportOpen(false);
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <SectionTitle title="Data & Storage" />

      {/* Storage location */}
      <Card>
        <Row label="Database" desc={dbPath || "…"} alignTop>
          <button
            onClick={() => void revealDataFolder()}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
          >
            <FolderOpen size={13} /> Reveal
          </button>
        </Row>
      </Card>

      {/* Backup & restore */}
      <SectionTitle title="Backup & Restore" />
      <Card>
        <Row label="Export backup" desc="A self-contained copy of the database you can archive or move to another machine.">
          <button
            onClick={() => void doExport()}
            disabled={busy === "export"}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft disabled:opacity-40"
          >
            <Download size={13} /> {busy === "export" ? "Exporting…" : "Export"}
          </button>
        </Row>
        <Row label="Import backup" desc="Replaces ALL current data with a backup file, then reloads the app.">
          <button
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-soft"
          >
            <Upload size={13} /> Import
          </button>
        </Row>
      </Card>
      {exportedTo && <Footnote>Backup saved to {exportedTo}</Footnote>}
      {importError && <Footnote>{importError}</Footnote>}

      {/* Trash */}
      <SectionTitle title="Trash" />
      <Card>
        <Row
          label="Auto-empty Trash"
          desc="Permanently delete notebooks after they've been in the Trash this long. Runs at launch."
        >
          <Segmented
            options={[
              { id: "0", label: "Never" },
              { id: "7", label: "7 days" },
              { id: "30", label: "30 days" },
              { id: "90", label: "90 days" },
            ]}
            value={String(settings.trashRetentionDays)}
            onChange={(v) => patch({ trashRetentionDays: Number(v) })}
          />
        </Row>
      </Card>

      {/* Danger zone */}
      <SectionTitle title="Danger Zone" />
      <Card>
        <Row label="Factory reset" desc="Erase every notebook, source, chat, studio output, pairing, and setting on this machine.">
          <button
            onClick={() => setResetOpen(true)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-bg"
          >
            <Trash2 size={13} /> Reset…
          </button>
        </Row>
      </Card>

      {/* Import confirm */}
      {importOpen && (
        <Modal title="Import backup?" onClose={() => setImportOpen(false)}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            The backup you pick will <b>replace everything currently in BrewLM</b> — notebooks,
            sources, chats, studio outputs, and settings. The app reloads afterwards.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            This can't be undone. Export a backup first if you're unsure.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setImportOpen(false)}>Cancel</GhostButton>
            <button
              onClick={() => void confirmImport()}
              className="rounded-full border border-danger-edge bg-danger-bg px-4 py-2 text-[13px] font-medium text-danger transition-opacity hover:opacity-85"
            >
              Choose backup file…
            </button>
          </div>
        </Modal>
      )}

      {/* Factory reset confirm */}
      {resetOpen && (
        <Modal title="Factory reset?" onClose={() => setResetOpen(false)}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            This erases <b>all BrewLM data on this machine</b> — every notebook, source, chat,
            studio output, paired device, usage stat, and setting (including API keys).
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            The app restarts fresh, as if just installed. This can't be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setResetOpen(false)}>Cancel</GhostButton>
            <button
              onClick={() => void factoryReset()}
              className="rounded-full border border-danger-edge bg-danger-bg px-4 py-2 text-[13px] font-medium text-danger transition-opacity hover:opacity-85"
            >
              Erase everything
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
