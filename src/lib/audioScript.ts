/**
 * Writes an Audio Overview script at the requested length. Short episodes are
 * one request; longer ones are outlined first and then written part by part,
 * each continuing from the end of the previous one — so even small models
 * reach 10–20 minutes without trailing off or repeating themselves.
 */
import {
  AUDIO_LENGTH_PARTS,
  buildAudioOutlinePrompt,
  buildAudioPrompt,
  buildAudioSectionPrompt,
  type AudioOptions,
} from "./studio";
import { parseScript, scriptLine, type ScriptTurn } from "./tts";

/**
 * One grounded model call. `focus` is what to retrieve from the sources for
 * this request (the part's topic), `prompt` what to ask.
 */
export type ScriptAsk = (prompt: string, focus: string) => Promise<string>;

/** "<title> — <what it covers>" lines from an outline reply. */
function parseOutline(raw: string, parts: number): string[] {
  return raw
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d+[.)]|part\s*\d+\s*[:.-])\s*/i, "")
        .replace(/\*\*/g, "")
        .trim()
    )
    .filter((l) => l.length > 3 && /[a-z]/i.test(l))
    .slice(0, parts);
}

export async function writeAudioScript(
  opts: AudioOptions,
  ask: ScriptAsk,
  onPhase: (phase: string) => void = () => {}
): Promise<ScriptTurn[]> {
  const parts = AUDIO_LENGTH_PARTS[opts.length];
  const overview = opts.description || "an overview of the most important ideas in all the sources";

  const single = async () => {
    onPhase("Writing script…");
    return parseScript(await ask(buildAudioPrompt(opts), overview));
  };
  if (parts <= 1) return single();

  onPhase("Planning the episode…");
  const outline = parseOutline(await ask(buildAudioOutlinePrompt(opts), overview), parts);
  // A plan the model fumbled is still better spent as one long request.
  if (outline.length < 2) return single();

  const turns: ScriptTurn[] = [];
  for (let i = 0; i < outline.length; i++) {
    onPhase(`Writing script — part ${i + 1} of ${outline.length}…`);
    const previous = turns.slice(-3).map(scriptLine).join("\n");
    turns.push(...parseScript(await ask(buildAudioSectionPrompt(opts, outline, i, previous), outline[i])));
  }
  return turns;
}
