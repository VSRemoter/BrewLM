import {
  AMOUNT_LABELS,
  AUDIO_FORMAT_LABELS,
  AUDIO_LENGTH_LABELS,
  AUDIO_LENGTH_MINUTES,
  AUDIO_MODE_LABELS,
  DIFFICULTY_LABELS,
  FLASHCARD_COUNTS,
  QUIZ_COUNTS,
  REPORT_TYPE_LABELS,
} from "../../lib/studio";
import type {
  Amount,
  AudioFormat,
  AudioLength,
  AudioMode,
  Difficulty,
  ReportType,
  Settings,
} from "../../lib/types";
import { Segmented } from "../ui";
import { Card, Footnote, Row, SectionTitle } from "./controls";

export default function StudioSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const amounts = (counts: Record<Amount, number>) =>
    (Object.keys(AMOUNT_LABELS) as Amount[]).map((id) => ({
      id,
      label: AMOUNT_LABELS[id],
      hint: String(counts[id]),
    }));
  const difficulties = (Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map((id) => ({
    id,
    label: DIFFICULTY_LABELS[id],
  }));

  return (
    <div>
      <SectionTitle
        title="Studio Defaults"
        desc="Starting points for the customize modals and the /flashcards, /quiz, and /audio commands. You can still change any of them per generation."
      />

      <SectionTitle title="Flashcards" />
      <Card>
        <Row label="Number of cards">
          <Segmented
            options={amounts(FLASHCARD_COUNTS)}
            value={settings.defFlashcardsAmount}
            onChange={(v) => patch({ defFlashcardsAmount: v })}
          />
        </Row>
        <Row label="Difficulty">
          <Segmented
            options={difficulties}
            value={settings.defFlashcardsDifficulty}
            onChange={(v) => patch({ defFlashcardsDifficulty: v })}
          />
        </Row>
      </Card>

      <SectionTitle title="Quiz" />
      <Card>
        <Row label="Number of questions">
          <Segmented
            options={amounts(QUIZ_COUNTS)}
            value={settings.defQuizAmount}
            onChange={(v) => patch({ defQuizAmount: v })}
          />
        </Row>
        <Row label="Difficulty">
          <Segmented
            options={difficulties}
            value={settings.defQuizDifficulty}
            onChange={(v) => patch({ defQuizDifficulty: v })}
          />
        </Row>
      </Card>

      <SectionTitle title="Audio overview" />
      <Card>
        <Row label="Mode">
          <Segmented
            options={(Object.keys(AUDIO_MODE_LABELS) as AudioMode[]).map((id) => ({
              id,
              label: AUDIO_MODE_LABELS[id],
            }))}
            value={settings.defAudioMode}
            onChange={(v) => patch({ defAudioMode: v })}
          />
        </Row>
        <Row label="Format">
          <Segmented
            options={(Object.keys(AUDIO_FORMAT_LABELS) as AudioFormat[]).map((id) => ({
              id,
              label: AUDIO_FORMAT_LABELS[id],
            }))}
            value={settings.defAudioFormat}
            onChange={(v) => patch({ defAudioFormat: v })}
          />
        </Row>
        <Row label="Length">
          <Segmented
            options={(Object.keys(AUDIO_LENGTH_LABELS) as AudioLength[]).map((id) => ({
              id,
              label: AUDIO_LENGTH_LABELS[id],
              hint: `~${AUDIO_LENGTH_MINUTES[id]} min`,
            }))}
            value={settings.defAudioLength}
            onChange={(v) => patch({ defAudioLength: v })}
          />
        </Row>
      </Card>

      <SectionTitle title="Report" />
      <Card>
        <Row label="Default type" desc="Custom is only useful with a per-report prompt, so it isn't offered here.">
          <Segmented
            options={(Object.keys(REPORT_TYPE_LABELS) as ReportType[])
              .filter((id) => id !== "custom")
              .map((id) => ({ id, label: REPORT_TYPE_LABELS[id] }))}
            value={settings.defReportType === "custom" ? "study-guide" : settings.defReportType}
            onChange={(v) => patch({ defReportType: v })}
          />
        </Row>
      </Card>
      <Footnote>Mind maps have no tunable options.</Footnote>
    </div>
  );
}
