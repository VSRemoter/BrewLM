import { useState } from "react";
import { CONSTITUTION_TEMPLATES } from "../lib/constitution";
import { Modal, PrimaryButton } from "./ui";

/** Picker id for the user's own pasted-in constitution (starts empty). */
const CUSTOM_ID = "custom";

const CHOICES = [
  ...CONSTITUTION_TEMPLATES.map(({ id, name, tagline }) => ({ id, name, tagline })),
  { id: CUSTOM_ID, name: "Custom", tagline: "Paste or write your own constitution from scratch." },
];

/** Selectable card grid of constitution personas, plus Custom. */
export function TemplateGrid({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {CHOICES.map((t) => {
        const active = t.id === selected;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            aria-pressed={active}
            className={`rounded-xl border px-3.5 py-3 text-left transition-colors ${
              active
                ? "border-accent bg-hover-soft"
                : "border-edge bg-panel hover:border-ink-3"
            }`}
          >
            <div className="text-[13px] font-semibold">{t.name}</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{t.tagline}</div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Standalone modal for (re)adding a constitution to an existing notebook.
 * The chosen template's full text is shown and editable before it's added;
 * each choice keeps its own draft, so flipping between them loses no edits.
 */
export function ConstitutionPickerModal({
  onPick,
  onClose,
}: {
  onPick: (body: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(CONSTITUTION_TEMPLATES[0].id);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(CONSTITUTION_TEMPLATES.map((t) => [t.id, t.body])),
    [CUSTOM_ID]: "",
  }));
  const body = drafts[selected] ?? "";
  const name = CHOICES.find((c) => c.id === selected)?.name ?? "";
  const template = CONSTITUTION_TEMPLATES.find((t) => t.id === selected);
  const edited = template !== undefined && body !== template.body;
  return (
    <Modal title="Choose a constitution" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Seeded as {`BrewLM-Context.md`} in your sources — edit it below before adding, or
          anytime later, and the change applies to your next message.
        </p>
        <TemplateGrid selected={selected} onSelect={setSelected} />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-ink-3">
            <span className="font-medium uppercase tracking-wide">
              {selected === CUSTOM_ID ? "Your constitution" : `${name} constitution`}
              {edited && <span className="normal-case tracking-normal"> · edited</span>}
            </span>
            {edited && (
              <button
                type="button"
                onClick={() => setDrafts((d) => ({ ...d, [selected]: template.body }))}
                className="rounded px-1 hover:text-ink"
              >
                Reset to template
              </button>
            )}
          </div>
          <textarea
            value={body}
            onChange={(e) => setDrafts((d) => ({ ...d, [selected]: e.target.value }))}
            rows={14}
            spellCheck={false}
            placeholder={
              selected === CUSTOM_ID
                ? "Paste your constitution here — how the AI should behave, format answers, and talk to you in this notebook."
                : undefined
            }
            className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed outline-none placeholder:font-sans placeholder:text-ink-3 focus:border-ink-3"
            aria-label="Constitution text"
          />
        </div>
        <div className="flex justify-end">
          <PrimaryButton disabled={!body.trim()} onClick={() => onPick(body)}>
            Add {name}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
