/** Pieces of Settings → Appearance: Look cards, segmented pickers, the save and import dialogs. */
import { Check, Copy, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { customSwatch } from "../../lib/customTheme";
import { FONTS } from "../../lib/fonts";
import { decodeLook, type Look } from "../../lib/look";
import { THEMES } from "../../lib/themes";
import { GhostButton, Modal, PrimaryButton } from "../ui";

/** A row of mutually exclusive choices. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; name: string }[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-0.5 rounded-lg bg-hover p-0.5">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
              on ? "bg-panel font-semibold text-ink shadow-sm" : "font-medium text-ink-2 hover:text-ink"
            }`}
          >
            {o.name}
          </button>
        );
      })}
    </div>
  );
}

const CORNER = { sharp: 2, soft: 5, round: 9 } as const;
const GAP = { compact: 3, cozy: 4, roomy: 5 } as const;

function swatchOf(look: Look) {
  if (look.theme === "custom" && look.custom) return customSwatch(look.custom);
  return (THEMES.find((t) => t.id === look.theme) ?? THEMES[0]).swatch;
}

/** A Look as a tiny window: its colors, corners, spacing, chat style and reading font. */
export function LookCard({
  look,
  active,
  onPick,
  onShare,
  onDelete,
}: {
  look: Look;
  active: boolean;
  onPick: () => void;
  /** Saved Looks only. */
  onShare?: () => void;
  onDelete?: () => void;
}) {
  const sw = swatchOf(look);
  const r = CORNER[look.shape];
  const g = GAP[look.density];
  const readStack = (FONTS.find((f) => f.id === (look.readFont || look.font)) ?? FONTS[0]).stack;
  const [menu, setMenu] = useState(false);
  const bubbleLeft = look.chatSide === "left" || look.chatStyle === "transcript";
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onPick}
        title={look.blurb ?? look.name}
        className={`flex w-full flex-col gap-1.5 rounded-xl border p-1.5 text-left transition-all ${
          active ? "border-accent shadow-sm" : "border-edge hover:border-ink-3"
        }`}
      >
        <span
          className="relative block h-16 w-full overflow-hidden border border-edge"
          style={{ background: sw.canvas, borderRadius: r + 3 }}
        >
          <span
            className="absolute flex flex-col"
            style={{ inset: g + 2, background: sw.panel, borderRadius: r, padding: g + 1, gap: g - 1 }}
          >
            {/* your message */}
            <span
              className="block h-[7px] w-[46%]"
              style={{
                alignSelf: bubbleLeft ? "flex-start" : "flex-end",
                background: look.chatStyle === "bubbles" ? sw.accent : look.chatStyle === "tinted" ? `${sw.ink}22` : `${sw.ink}40`,
                borderLeft: look.chatStyle === "transcript" ? `2px solid ${sw.accent}` : undefined,
                borderRadius: look.chatStyle === "transcript" ? 0 : r + 2,
              }}
            />
            {/* the reply, in its reading font */}
            <span className="flex items-center gap-1">
              <span className="text-[12px] leading-none" style={{ fontFamily: readStack, color: sw.ink }}>
                Aa
              </span>
              <span className="flex flex-1 flex-col gap-[3px]">
                <span className="block h-[3px] w-[90%] rounded-full opacity-30" style={{ background: sw.ink }} />
                <span className="block h-[3px] w-[70%] rounded-full opacity-30" style={{ background: sw.ink }} />
              </span>
            </span>
          </span>
          {active && (
            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink">
              <Check size={10} strokeWidth={3} />
            </span>
          )}
        </span>
        <span className="truncate px-0.5 pb-0.5 text-[11.5px] leading-tight">
          <span className={active ? "font-semibold" : "font-medium"}>{look.name}</span>
        </span>
      </button>
      {(onShare || onDelete) && (
        <>
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            aria-label={`More for ${look.name}`}
            aria-haspopup="menu"
            className="absolute bottom-1.5 right-1.5 rounded-md p-0.5 text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <MoreHorizontal size={14} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div
                role="menu"
                className="anim-menu absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border border-edge bg-panel p-1 shadow-lg"
              >
                {onShare && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onShare();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink"
                  >
                    <Copy size={13} /> Copy share code
                  </button>
                )}
                {onDelete && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onDelete();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-danger hover:bg-hover"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Name the current appearance and keep it as a Look. */
export function SaveLookDialog({ onSave, onClose }: { onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <Modal
      title="Save as a Look"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton type="submit" form="save-look" disabled={!name.trim()}>
            Save
          </PrimaryButton>
        </>
      }
    >
      <form
        id="save-look"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name);
        }}
      >
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
          Keeps your colors, fonts, shape, spacing and chat style together, so you can come back to them in one click
          or share them.
        </p>
        <input
          autoFocus
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Look"
          aria-label="Look name"
          className="w-full rounded-lg border border-edge bg-canvas/50 px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/70 focus:ring-3 focus:ring-accent/15"
        />
      </form>
    </Modal>
  );
}

/** Paste someone's share code to add their Look. */
export function ImportLookDialog({ onImport, onClose }: { onImport: (look: Look) => void; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    const look = decodeLook(code);
    if (!look) {
      setError("That doesn't look like a Look code. It starts with BREWLOOK1.");
      return;
    }
    onImport(look);
  };
  return (
    <Modal
      title="Import a Look"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={!code.trim()}>
            Import
          </PrimaryButton>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
        Paste a code someone shared from Copy share code. The Look is added to yours and put on right away.
      </p>
      <textarea
        autoFocus
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setError("");
        }}
        rows={4}
        placeholder="BREWLOOK1.…"
        aria-label="Look code"
        className="w-full resize-none rounded-lg border border-edge bg-canvas/50 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent/70 focus:ring-3 focus:ring-accent/15"
      />
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </Modal>
  );
}
