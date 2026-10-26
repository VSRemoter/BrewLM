/** Parsing the "Add links" box. */

/**
 * The links in a pasted list — one per line, or separated by spaces or
 * commas. Anything that doesn't look like a web address is skipped, and
 * repeats are dropped.
 */
export function parseLinkList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const t = raw.replace(/^[<("'\[]+|[>)"'\].;]+$/g, "");
    if (!/^(https?:\/\/)?[^\s/.]+\.[^\s]+$/i.test(t)) continue;
    const key = t.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
