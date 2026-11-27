/**
 * Replies longer than one response: when the model stops at its output limit
 * (llm.ts onCutOff), ask it to carry on from the exact point it stopped, and
 * join the parts — trimming any stretch it repeats at the seam, and any
 * preface or code fence it puts in front of a continuation. Used for
 * documents, whose length is up to the request (a 60-page report, a 100-slide
 * deck), not up to one response.
 */
import { complete, type LlmMessage, type StreamOptions } from "./llm";

/** Most parts one document is written in. */
export const MAX_PARTS = 8;

export const CONTINUE_PROMPT =
  "Your reply was cut off by the length limit. Continue exactly where it stopped: write the very next characters, as if the reply had never been interrupted. Don't repeat anything already written, don't add any preface or explanation, and don't open a code fence.";

/** Join a continuation onto what came before: no leading fence or preface, no repeated overlap. */
export function joinParts(before: string, next: string): string {
  let n = next.replace(/^\s*```[a-z]*[ \t]*\n/i, "");
  // A chatty opener ("Continuing:", "Here's the rest:") on its own line.
  n = n.replace(/^\s*(?:continuing|continued|here(?:'s| is) the rest)[^\n]{0,40}:\s*\n/i, "");
  // The model often restarts a few characters (or a line) back: drop the overlap.
  const max = Math.min(600, before.length, n.length);
  for (let k = max; k >= 12; k--) {
    if (before.endsWith(n.slice(0, k))) return before + n.slice(k);
  }
  // Or it restarts the word it was in the middle of ("Tw" then "Two"). Words only: with digits
  // ("1" then "15") there is no telling a restart from a continuation.
  const partial = /\p{L}+$/u.exec(before)?.[0];
  if (partial && n.startsWith(partial) && n.length > partial.length) return before.slice(0, -partial.length) + n;
  // Or it restarts the line it was on: drop the part of that line already written.
  const tail = before.slice(before.lastIndexOf("\n") + 1);
  if (tail.length >= 12 && n.startsWith(tail.trimStart())) return before + n.slice(tail.trimStart().length);
  return before + n;
}

/**
 * One reply, continued over up to MAX_PARTS requests while it keeps getting
 * cut off. `onPart` hears when a continuation starts (2, 3…).
 */
export async function writeInParts(request: StreamOptions, onPart?: (part: number) => void): Promise<string> {
  let text = "";
  let messages: LlmMessage[] = request.messages;
  for (let part = 1; part <= MAX_PARTS; part++) {
    if (part > 1) onPart?.(part);
    let cut = false;
    const reply = await complete({ ...request, messages, onCutOff: () => (cut = true) });
    text = part === 1 ? reply : joinParts(text, reply);
    if (!cut || !reply.trim()) break;
    messages = [...request.messages, { role: "assistant", content: text }, { role: "user", content: CONTINUE_PROMPT }];
  }
  return text;
}
