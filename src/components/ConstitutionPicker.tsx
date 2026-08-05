import { useState } from "react";
import { CONSTITUTION_TEMPLATES, type ConstitutionTemplate } from "../lib/constitution";
import { Modal, PrimaryButton } from "./ui";

/** Selectable card grid of constitution personas. */
export function TemplateGrid({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {CONSTITUTION_TEMPLATES.map((t) => {
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

/** Standalone modal for (re)adding a constitution to an existing notebook. */
export function ConstitutionPickerModal({
  onPick,
  onClose,
}: {
  onPick: (t: ConstitutionTemplate) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(CONSTITUTION_TEMPLATES[0].id);
  const template =
    CONSTITUTION_TEMPLATES.find((t) => t.id === selected) ?? CONSTITUTION_TEMPLATES[0];
  return (
    <Modal title="Choose a constitution" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Seeded as {`BrewLM-Context.md`} in your sources — edit or rewrite it anytime, and the
          change applies to your next message.
        </p>
        <TemplateGrid selected={selected} onSelect={setSelected} />
        <div className="flex justify-end">
          <PrimaryButton onClick={() => onPick(template)}>Add {template.name}</PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
