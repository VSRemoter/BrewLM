/**
 * "Customize & generate" modals for the Studio tools (Flashcards, Quiz,
 * Mind map, Audio overview, Report). Each collects tool-specific options —
 * always including which sources to use — and hands a structured options
 * object back to StudioPanel, which builds the prompt and runs generation.
 * Deep Research needs no customize modal: opening it already asks for input.
 */

import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  AMOUNT_LABELS,
  AUDIO_FORMAT_DESCS,
  AUDIO_FORMAT_LABELS,
  AUDIO_LENGTH_LABELS,
  DIFFICULTY_LABELS,
  FLASHCARD_COUNTS,
  QUIZ_COUNTS,
  type Amount,
  type AudioFormat,
  type AudioLength,
  type AudioOptions,
  type Difficulty,
  type FlashcardsOptions,
  type MindmapOptions,
  type QuizOptions,
  type ReportOptions,
  type ReportType,
} from "../lib/studio";
import type { Source } from "../lib/types";
import { Modal, PrimaryButton, Segmented } from "./ui";

const AMOUNTS: Amount[] = ["compact", "default", "more"];
const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const AUDIO_FORMATS: AudioFormat[] = ["deep-dive", "brief", "debate", "critique"];
const AUDIO_LENGTHS: AudioLength[] = ["short", "standard", "long"];
const REPORT_TYPES: ReportType[] = ["study-guide", "briefing-doc", "analysis", "custom"];

/** Short labels so four report types fit one segmented row. */
const REPORT_TYPE_SHORT: Record<ReportType, string> = {
  "study-guide": "Study Guide",
  "briefing-doc": "Briefing",
  analysis: "Analysis",
  custom: "Custom",
};

const textareaClass =
  "w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-ink-3 focus:border-ink-3";

/* ------------------------------ shared pieces ------------------------------ */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {label}
      </label>
      {children}
    </div>
  );
}

function SourcePicker({
  sources,
  selected,
  onChange,
}: {
  sources: Source[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const allSelected = selected.length === sources.length;
  return (
    <Field label={`Sources · ${selected.length}/${sources.length}`}>
      <div className="max-h-36 overflow-y-auto rounded-lg border border-edge bg-canvas p-1">
        <button
          type="button"
          onClick={() => onChange(allSelected ? [] : sources.map((s) => s.id))}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-ink-3 transition-colors hover:bg-hover-soft hover:text-ink"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
        {sources.map((s) => {
          const checked = selected.includes(s.id);
          return (
            <button
              type="button"
              key={s.id}
              onClick={() =>
                onChange(checked ? selected.filter((id) => id !== s.id) : [...selected, s.id])
              }
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover-soft"
              role="checkbox"
              aria-checked={checked}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  checked ? "border-accent bg-accent text-accent-ink" : "border-edge bg-panel"
                }`}
              >
                {checked && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title}</span>
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-3">
                {s.type}
              </span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** Shared modal scaffold: fields + source picker + generate button. */
function CustomizeFrame({
  title,
  sources,
  selected,
  onSourcesChange,
  onClose,
  onGenerate,
  generateLabel,
  disabled,
  children,
}: {
  title: string;
  sources: Source[];
  selected: string[];
  onSourcesChange: (ids: string[]) => void;
  onClose: () => void;
  onGenerate: () => void;
  generateLabel: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        {children}
        <SourcePicker sources={sources} selected={selected} onChange={onSourcesChange} />
        {selected.length === 0 && (
          <p className="-mt-2 text-[11px] leading-snug text-ink-3">
            Select at least one source to generate from.
          </p>
        )}
        <div className="flex justify-end pt-0.5">
          <PrimaryButton
            onClick={onGenerate}
            disabled={disabled || selected.length === 0}
          >
            {generateLabel}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}

function DescriptionField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <Field label="Description (optional)">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className={textareaClass}
      />
    </Field>
  );
}

function useSourceSelection(sources: Source[]) {
  return useState<string[]>(() => sources.map((s) => s.id));
}

/* -------------------------------- flashcards ------------------------------- */

export function FlashcardsModal({
  sources,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  onClose: () => void;
  onGenerate: (opts: FlashcardsOptions) => void;
}) {
  const [amount, setAmount] = useState<Amount>("default");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");

  return (
    <CustomizeFrame
      title="Customize flashcards"
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() =>
        onGenerate({ amount, difficulty, sourceIds, description: description.trim() })
      }
      generateLabel="Generate flashcards"
    >
      <Field label={`Number of cards · ${FLASHCARD_COUNTS[amount]}`}>
        <Segmented
          options={AMOUNTS.map((id) => ({ id, label: AMOUNT_LABELS[id] }))}
          value={amount}
          onChange={setAmount}
        />
      </Field>
      <Field label="Difficulty">
        <Segmented
          options={DIFFICULTIES.map((id) => ({ id, label: DIFFICULTY_LABELS[id] }))}
          value={difficulty}
          onChange={setDifficulty}
        />
      </Field>
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="What should the cards focus on? e.g. key definitions from chapters 3–4"
      />
    </CustomizeFrame>
  );
}

/* ---------------------------------- quiz ----------------------------------- */

export function QuizModal({
  sources,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  onClose: () => void;
  onGenerate: (opts: QuizOptions) => void;
}) {
  const [amount, setAmount] = useState<Amount>("default");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");

  return (
    <CustomizeFrame
      title="Customize quiz"
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() =>
        onGenerate({ amount, difficulty, sourceIds, description: description.trim() })
      }
      generateLabel="Generate quiz"
    >
      <Field label={`Number of questions · ${QUIZ_COUNTS[amount]}`}>
        <Segmented
          options={AMOUNTS.map((id) => ({ id, label: AMOUNT_LABELS[id] }))}
          value={amount}
          onChange={setAmount}
        />
      </Field>
      <Field label="Difficulty">
        <Segmented
          options={DIFFICULTIES.map((id) => ({ id, label: DIFFICULTY_LABELS[id] }))}
          value={difficulty}
          onChange={setDifficulty}
        />
      </Field>
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="What topics should the questions cover? e.g. mostly the transformer architecture"
      />
    </CustomizeFrame>
  );
}

/* --------------------------------- mind map -------------------------------- */

export function MindmapModal({
  sources,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  onClose: () => void;
  onGenerate: (opts: MindmapOptions) => void;
}) {
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");

  return (
    <CustomizeFrame
      title="Customize mind map"
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() => onGenerate({ sourceIds, description: description.trim() })}
      generateLabel="Generate mind map"
    >
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="What should the map emphasize? e.g. how the concepts relate to each other"
      />
    </CustomizeFrame>
  );
}

/* ---------------------------------- audio ---------------------------------- */

export function AudioModal({
  sources,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  onClose: () => void;
  onGenerate: (opts: AudioOptions) => void;
}) {
  const [format, setFormat] = useState<AudioFormat>("deep-dive");
  const [length, setLength] = useState<AudioLength>("standard");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");

  return (
    <CustomizeFrame
      title="Customize audio overview"
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() => onGenerate({ format, length, sourceIds, description: description.trim() })}
      generateLabel="Generate audio"
    >
      <Field label="Format">
        <Segmented
          options={AUDIO_FORMATS.map((id) => ({ id, label: AUDIO_FORMAT_LABELS[id] }))}
          value={format}
          onChange={setFormat}
        />
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">
          {AUDIO_FORMAT_DESCS[format]}
        </p>
      </Field>
      <Field label="Length">
        <Segmented
          options={AUDIO_LENGTHS.map((id) => ({ id, label: AUDIO_LENGTH_LABELS[id] }))}
          value={length}
          onChange={setLength}
        />
      </Field>
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="What should the episode discuss? e.g. focus on the practical implications"
      />
    </CustomizeFrame>
  );
}

/* ---------------------------------- report --------------------------------- */

export function ReportModal({
  sources,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  onClose: () => void;
  onGenerate: (opts: ReportOptions) => void;
}) {
  const [type, setType] = useState<ReportType>("study-guide");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [customPrompt, setCustomPrompt] = useState("");

  return (
    <CustomizeFrame
      title="Customize report"
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() => onGenerate({ type, customPrompt: customPrompt.trim(), sourceIds })}
      generateLabel="Generate report"
      disabled={type === "custom" && !customPrompt.trim()}
    >
      <Field label="Report type">
        <Segmented
          options={REPORT_TYPES.map((id) => ({ id, label: REPORT_TYPE_SHORT[id] }))}
          value={type}
          onChange={setType}
        />
      </Field>
      {type === "custom" && (
        <Field label="Custom instructions">
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Describe the report you want — sections, focus, audience…"
            rows={4}
            autoFocus
            className={textareaClass}
          />
        </Field>
      )}
    </CustomizeFrame>
  );
}
