/**
 * "Customize & generate" modals for the Studio tools (Flashcards, Quiz,
 * Mind map, Audio overview, Report). Each collects tool-specific options —
 * always including which sources to use — and hands a structured options
 * object back to StudioPanel, which builds the prompt and runs generation.
 * Deep Research needs no customize modal: opening it already asks for input.
 */

import { Check, Clock, Gauge, Layers, LayoutList, Mic, PenLine, Shapes } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  AMOUNT_LABELS,
  AUDIO_FORMAT_DESCS,
  AUDIO_FORMAT_LABELS,
  AUDIO_LENGTH_LABELS,
  AUDIO_LENGTH_MINUTES,
  AUDIO_MODE_DESCS,
  AUDIO_MODE_LABELS,
  DIFFICULTY_LABELS,
  FLASHCARD_COUNTS,
  QUIZ_COUNTS,
  REPORT_TYPE_LABELS,
  type Amount,
  type AudioFormat,
  type AudioLength,
  type AudioMode,
  type AudioOptions,
  type Difficulty,
  type FlashcardsOptions,
  type MindmapOptions,
  type QuizOptions,
  type ReportOptions,
  type ReportType,
} from "../lib/studio";
import type { InteractiveOptions } from "../lib/interactive";
import type { Source } from "../lib/types";
import { SOURCE_TYPE_ICON } from "./sourceIcons";
import {
  Divider,
  FormField,
  GhostButton,
  Modal,
  PrimaryButton,
  PropertyRow,
  Segmented,
  textareaClass,
} from "./ui";

const AMOUNTS: Amount[] = ["compact", "default", "more"];
const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const AUDIO_FORMATS: AudioFormat[] = ["deep-dive", "brief", "debate", "critique"];
const AUDIO_LENGTHS: AudioLength[] = ["short", "standard", "long"];
const AUDIO_MODES: AudioMode[] = ["conversation", "solo"];
const REPORT_TYPES: ReportType[] = ["study-guide", "briefing-doc", "analysis", "custom"];

/** Short labels so four report types fit one segmented row. */
const REPORT_TYPE_SHORT: Record<ReportType, string> = {
  "study-guide": "Study guide",
  "briefing-doc": "Briefing",
  analysis: "Analysis",
  custom: "Custom",
};

const ICON = { size: 14, strokeWidth: 1.8 } as const;

/* ------------------------------ shared pieces ------------------------------ */

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
    <FormField
      label="Sources"
      note={`${selected.length} of ${sources.length}`}
      aside={
        sources.length > 1 && (
          <button
            type="button"
            onClick={() => onChange(allSelected ? [] : sources.map((s) => s.id))}
            className="rounded px-1 text-[12.5px] text-ink-3 transition-colors hover:text-ink"
          >
            {allSelected ? "Clear" : "Select all"}
          </button>
        )
      }
    >
      <div className="-mx-2 flex flex-col">
        {sources.map((s) => {
          const checked = selected.includes(s.id);
          const Icon = SOURCE_TYPE_ICON[s.type];
          return (
            <button
              type="button"
              key={s.id}
              onClick={() =>
                onChange(checked ? selected.filter((id) => id !== s.id) : [...selected, s.id])
              }
              className="group flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left transition-colors hover:bg-hover"
              role="checkbox"
              aria-checked={checked}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                  checked ? "border-accent bg-accent text-accent-ink" : "border-ink-3/50 group-hover:border-ink-3"
                }`}
              >
                {checked && <Check size={11} strokeWidth={3} />}
              </span>
              <Icon size={14} strokeWidth={1.8} className="shrink-0 text-ink-3" />
              <span
                className={`min-w-0 flex-1 truncate text-[13px] transition-colors ${checked ? "text-ink" : "text-ink-3"}`}
              >
                {s.title}
              </span>
            </button>
          );
        })}
      </div>
    </FormField>
  );
}

/**
 * Shared scaffold: settings as rows (name first), then long-form fields,
 * then the source list, with Generate pinned in the footer.
 */
function CustomizeFrame({
  title,
  name,
  onNameChange,
  sources,
  selected,
  onSourcesChange,
  onClose,
  onGenerate,
  generateLabel,
  disabled,
  rows,
  children,
}: {
  title: string;
  /** Saved-artifact name (prefilled with the tool default). */
  name: string;
  onNameChange: (v: string) => void;
  sources: Source[];
  selected: string[];
  onSourcesChange: (ids: string[]) => void;
  onClose: () => void;
  onGenerate: () => void;
  generateLabel: string;
  disabled?: boolean;
  /** Short settings, shown as label/control rows under Name. */
  rows?: ReactNode;
  /** Long-form fields (descriptions, instructions), full width. */
  children?: ReactNode;
}) {
  const none = selected.length === 0;
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className={`mr-auto text-[12.5px] ${none ? "text-warn" : "text-ink-3"}`}>
            {none
              ? "Pick at least one source"
              : `From ${selected.length} ${selected.length === 1 ? "source" : "sources"}`}
          </span>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={onGenerate} disabled={disabled || none}>
            {generateLabel}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2.5">
          <PropertyRow label="Name" icon={<PenLine {...ICON} />}>
            <input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              maxLength={80}
              aria-label="Name"
              // Reads as text until hovered or focused, like a Notion property.
              className="-mx-2 h-8 w-[calc(100%+1rem)] rounded-md border border-transparent bg-transparent px-2 text-[13.5px] font-medium text-ink outline-none transition-colors hover:bg-hover focus:border-accent/70 focus:bg-panel focus:ring-3 focus:ring-accent/15"
            />
          </PropertyRow>
          {rows}
        </div>
        {children}
        <Divider />
        <SourcePicker sources={sources} selected={selected} onChange={onSourcesChange} />
      </div>
    </Modal>
  );
}

function DescriptionField({
  value,
  onChange,
  placeholder,
  label = "Focus",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <FormField label={label} note="Optional">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className={textareaClass}
      />
    </FormField>
  );
}

function useSourceSelection(sources: Source[]) {
  return useState<string[]>(() => sources.map((s) => s.id));
}

/* -------------------------------- flashcards ------------------------------- */

export function FlashcardsModal({
  sources,
  defaults,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  /** Settings → Studio Defaults seed the initial selections. */
  defaults?: { amount: Amount; difficulty: Difficulty };
  onClose: () => void;
  onGenerate: (opts: FlashcardsOptions) => void;
}) {
  const [amount, setAmount] = useState<Amount>(defaults?.amount ?? "default");
  const [difficulty, setDifficulty] = useState<Difficulty>(defaults?.difficulty ?? "medium");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");
  const [name, setName] = useState("Flashcards");

  return (
    <CustomizeFrame
      title="Customize flashcards"
      name={name}
      onNameChange={setName}
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() =>
        onGenerate({ amount, difficulty, sourceIds, description: description.trim(), title: name.trim() || "Flashcards" })
      }
      generateLabel="Generate"
      rows={
        <>
          <PropertyRow label="Cards" icon={<Layers {...ICON} />} hint={`About ${FLASHCARD_COUNTS[amount]} cards`}>
            <Segmented
              options={AMOUNTS.map((id) => ({ id, label: AMOUNT_LABELS[id] }))}
              value={amount}
              onChange={setAmount}
            />
          </PropertyRow>
          <PropertyRow label="Difficulty" icon={<Gauge {...ICON} />}>
            <Segmented
              options={DIFFICULTIES.map((id) => ({ id, label: DIFFICULTY_LABELS[id] }))}
              value={difficulty}
              onChange={setDifficulty}
            />
          </PropertyRow>
        </>
      }
    >
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="e.g. key definitions from chapters 3–4"
      />
    </CustomizeFrame>
  );
}

/* ---------------------------------- quiz ----------------------------------- */

export function QuizModal({
  sources,
  defaults,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  /** Settings → Studio Defaults seed the initial selections. */
  defaults?: { amount: Amount; difficulty: Difficulty };
  onClose: () => void;
  onGenerate: (opts: QuizOptions) => void;
}) {
  const [amount, setAmount] = useState<Amount>(defaults?.amount ?? "default");
  const [difficulty, setDifficulty] = useState<Difficulty>(defaults?.difficulty ?? "medium");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");
  const [name, setName] = useState("Quiz");

  return (
    <CustomizeFrame
      title="Customize quiz"
      name={name}
      onNameChange={setName}
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() =>
        onGenerate({ amount, difficulty, sourceIds, description: description.trim(), title: name.trim() || "Quiz" })
      }
      generateLabel="Generate"
      rows={
        <>
          <PropertyRow label="Questions" icon={<Layers {...ICON} />} hint={`About ${QUIZ_COUNTS[amount]} questions`}>
            <Segmented
              options={AMOUNTS.map((id) => ({ id, label: AMOUNT_LABELS[id] }))}
              value={amount}
              onChange={setAmount}
            />
          </PropertyRow>
          <PropertyRow label="Difficulty" icon={<Gauge {...ICON} />}>
            <Segmented
              options={DIFFICULTIES.map((id) => ({ id, label: DIFFICULTY_LABELS[id] }))}
              value={difficulty}
              onChange={setDifficulty}
            />
          </PropertyRow>
        </>
      }
    >
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="e.g. mostly the transformer architecture"
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
  const [name, setName] = useState("Mind map");

  return (
    <CustomizeFrame
      title="Customize mind map"
      name={name}
      onNameChange={setName}
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() => onGenerate({ sourceIds, description: description.trim(), title: name.trim() || "Mind map" })}
      generateLabel="Generate"
    >
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="e.g. how the concepts relate to each other"
      />
    </CustomizeFrame>
  );
}

/* ---------------------------------- audio ---------------------------------- */

export function AudioModal({
  sources,
  defaults,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  /** Settings → Studio Defaults seed the initial selections. */
  defaults?: { mode: AudioMode; format: AudioFormat; length: AudioLength };
  onClose: () => void;
  onGenerate: (opts: AudioOptions) => void;
}) {
  const [mode, setMode] = useState<AudioMode>(defaults?.mode ?? "conversation");
  const [format, setFormat] = useState<AudioFormat>(defaults?.format ?? "deep-dive");
  const [length, setLength] = useState<AudioLength>(defaults?.length ?? "standard");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [description, setDescription] = useState("");
  const [name, setName] = useState("Audio overview");

  return (
    <CustomizeFrame
      title="Customize audio overview"
      name={name}
      onNameChange={setName}
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() => onGenerate({ format, length, mode, sourceIds, description: description.trim(), title: name.trim() || "Audio overview" })}
      generateLabel="Generate"
      rows={
        <>
          <PropertyRow label="Hosts" icon={<Mic {...ICON} />} hint={AUDIO_MODE_DESCS[mode]}>
            <Segmented
              options={AUDIO_MODES.map((id) => ({ id, label: AUDIO_MODE_LABELS[id] }))}
              value={mode}
              onChange={setMode}
            />
          </PropertyRow>
          <PropertyRow label="Format" icon={<Shapes {...ICON} />} hint={AUDIO_FORMAT_DESCS[format]}>
            <Segmented
              options={AUDIO_FORMATS.map((id) => ({ id, label: AUDIO_FORMAT_LABELS[id] }))}
              value={format}
              onChange={setFormat}
            />
          </PropertyRow>
          <PropertyRow label="Length" icon={<Clock {...ICON} />} hint={`About ${AUDIO_LENGTH_MINUTES[length]} minutes`}>
            <Segmented
              options={AUDIO_LENGTHS.map((id) => ({ id, label: AUDIO_LENGTH_LABELS[id] }))}
              value={length}
              onChange={setLength}
            />
          </PropertyRow>
        </>
      }
    >
      <DescriptionField
        value={description}
        onChange={setDescription}
        placeholder="e.g. focus on the practical implications"
      />
    </CustomizeFrame>
  );
}

/* ---------------------------------- report --------------------------------- */

export function ReportModal({
  sources,
  defaults,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  /** Settings → Studio Defaults seeds the initial report type. */
  defaults?: { type: ReportType };
  onClose: () => void;
  onGenerate: (opts: ReportOptions) => void;
}) {
  const [type, setType] = useState<ReportType>(defaults?.type ?? "study-guide");
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [customPrompt, setCustomPrompt] = useState("");
  const [name, setName] = useState(REPORT_TYPE_LABELS[defaults?.type ?? "study-guide"]);

  /** Switch report type; the saved name follows unless the user renamed it. */
  const changeType = (t: ReportType) => {
    setName((cur) => (REPORT_TYPES.some((rt) => REPORT_TYPE_LABELS[rt] === cur) ? REPORT_TYPE_LABELS[t] : cur));
    setType(t);
  };

  return (
    <CustomizeFrame
      title="Customize report"
      name={name}
      onNameChange={setName}
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() =>
        onGenerate({ type, customPrompt: customPrompt.trim(), sourceIds, title: name.trim() || REPORT_TYPE_LABELS[type] })
      }
      generateLabel="Generate"
      disabled={type === "custom" && !customPrompt.trim()}
      rows={
        <PropertyRow label="Type" icon={<LayoutList {...ICON} />}>
          <Segmented
            options={REPORT_TYPES.map((id) => ({ id, label: REPORT_TYPE_SHORT[id] }))}
            value={type}
            onChange={changeType}
          />
        </PropertyRow>
      }
    >
      {type === "custom" && (
        <FormField label="Instructions">
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Describe the report you want — sections, focus, audience…"
            rows={4}
            autoFocus
            className={textareaClass}
          />
        </FormField>
      )}
    </CustomizeFrame>
  );
}

/* ------------------------------- interactive ------------------------------- */

export function InteractiveModal({
  sources,
  onClose,
  onGenerate,
}: {
  sources: Source[];
  onClose: () => void;
  onGenerate: (opts: InteractiveOptions) => void;
}) {
  const [sourceIds, setSourceIds] = useSourceSelection(sources);
  const [topic, setTopic] = useState("");
  const [name, setName] = useState("Interactive");

  return (
    <CustomizeFrame
      title="Create interactive"
      name={name}
      onNameChange={setName}
      sources={sources}
      selected={sourceIds}
      onSourcesChange={setSourceIds}
      onClose={onClose}
      onGenerate={() => onGenerate({ topic: topic.trim(), sourceIds, title: name.trim() || "Interactive" })}
      generateLabel="Generate"
    >
      <FormField label="What do you want to make?" note="Optional">
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          placeholder="A web app, animation, game or simulation. Leave blank and the AI picks."
          className={textareaClass}
        />
        <p className="mt-1.5 text-[12px] leading-snug text-ink-3">
          Writes a whole web page, so it uses more of your model&apos;s output than other tools (roughly 15–45k tokens). Works best on a strong model.
        </p>
      </FormField>
    </CustomizeFrame>
  );
}
