/**
 * /provider — show or change OpenRouter provider routing from chat (no AI
 * tokens). Same settings as Settings → AI Model → Provider routing.
 */
import {
  baseSlug,
  findProvider,
  lastServedBy,
  loadModelEndpoints,
  loadProviders,
  matchEndpoint,
  type OpenRouterRouting,
  pinFor,
  type RoutingSort,
  SORT_LABELS,
  withPin,
} from "./routing";
import { loadSettings, patchSettings } from "./settings";

/** What people type → a priority. */
const SORT_WORDS: Record<string, RoutingSort> = {
  default: "",
  balanced: "",
  cheapest: "price",
  cheap: "price",
  price: "price",
  fastest: "throughput",
  fast: "throughput",
  throughput: "throughput",
  quickest: "latency",
  quick: "latency",
  latency: "latency",
};

const code = (list: string[]) => list.map((x) => `\`${x}\``).join(", ");

/** "a, b" or "a > b", or space-separated names when no separator is used. */
function splitNames(raw: string): string[] {
  const parts = /[,>→]/.test(raw) ? raw.split(/\s*[,>→]\s*/) : [raw];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The status reply: what's in effect for `model` right now. */
function describe(r: OpenRouterRouting, model: string): string {
  const pin = pinFor(r, model);
  const privacy = [r.noTraining && "no providers that train on your data", r.zdr && "zero data retention only"].filter(Boolean);
  const served = lastServedBy(model);
  return [
    `**Provider routing** for \`${model}\`:`,
    `- Priority: **${SORT_LABELS[r.sort]}**${pin && r.sort ? " (not used for this model: its pinned providers come first)" : ""}`,
    `- Pinned for this model: ${pin ? `${pin.order.map((s) => `\`${s}\``).join(" → ")}${pin.only ? " (only these)" : ", then any other"}` : "none"}`,
    `- Privacy: ${privacy.length ? privacy.join(", ") : "OpenRouter's default"}`,
    `- Blocked: ${r.ignore.length ? code(r.ignore) : "none"}`,
    served ? `\nThe last reply from this model came from **${served}**.` : "",
    "\nChange it with `/provider cheapest`, `fastest`, `quickest` or `default`; `/provider pin <provider>` (or `only <provider>`) for this model; `/provider private`, `/provider zdr`, `/provider block <provider>`, or `/provider off`. Also in Settings → AI Model → Provider routing.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Run `/provider …` for the active `model`; returns the reply to post. */
export async function runProviderCommand(text: string, model: string): Promise<string> {
  const arg = text.replace(/^\/provider\s*/i, "").trim();
  const [word = "", ...rest] = arg.split(/\s+/);
  const verb = word.toLowerCase();
  const tail = rest.join(" ").trim();
  const r = (await loadSettings()).openrouterRouting;
  const save = (next: OpenRouterRouting) => patchSettings({ openrouterRouting: next });

  if (!verb) return describe(r, model);

  if (Object.prototype.hasOwnProperty.call(SORT_WORDS, verb)) {
    const sort = SORT_WORDS[verb];
    await save({ ...r, sort });
    const what = {
      "": "OpenRouter balances between providers, mostly the cheapest that's up",
      price: "the cheapest provider answers first",
      throughput: "the provider that writes fastest answers first",
      latency: "the provider that starts answering soonest goes first",
    }[sort];
    const pinned = pinFor(r, model) ? ` \`${model}\` has pinned providers, which still come first for it.` : "";
    return `Priority set to **${SORT_LABELS[sort]}**: ${what}.${pinned}`;
  }

  if (verb === "private" || verb === "zdr") {
    const field = verb === "private" ? "noTraining" : "zdr";
    const on = /^on$/i.test(tail) ? true : /^off$/i.test(tail) ? false : !r[field];
    await save({ ...r, [field]: on });
    if (verb === "private")
      return on
        ? "**No training on** your data: providers that may store your prompts or train on them are skipped. Some free models have no provider left with this on."
        : "Providers that may train on your data are allowed again (OpenRouter's default).";
    return on
      ? "**Zero data retention on**: only providers that keep nothing after answering. Far fewer models qualify."
      : "Zero data retention off: providers that keep data for a while are allowed again.";
  }

  if (verb === "pin" || verb === "only") {
    if (!tail)
      return `Which provider? e.g. \`/provider ${verb} groq\`, or several in order: \`/provider ${verb} groq, deepinfra\`. Type \`/provider\` to see the current routing.`;
    const endpoints = await loadModelEndpoints(model);
    let names = splitNames(tail);
    // "groq deepinfra" without commas: try each word when the whole doesn't match.
    if (endpoints && names.length === 1 && !matchEndpoint(endpoints, names[0]) && /\s/.test(names[0])) names = names[0].split(/\s+/);
    const order: string[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const slug = endpoints ? matchEndpoint(endpoints, n) : n.toLowerCase();
      if (!slug) missing.push(n);
      else if (!order.includes(slug)) order.push(slug);
    }
    if (missing.length) {
      const offered = endpoints?.length ? ` Providers for it: ${code([...new Set(endpoints.map((e) => baseSlug(e.slug)))])}.` : "";
      return `${code(missing)} ${missing.length === 1 ? "doesn't" : "don't"} serve \`${model}\` on OpenRouter, so nothing was pinned.${offered}`;
    }
    const only = verb === "only";
    await save(withPin(r, model, { order, only }));
    const blocked = order.filter((s) => r.ignore.includes(baseSlug(s)));
    return [
      `Pinned ${order.map((s) => `\`${s}\``).join(" → ")} for \`${model}\`. ${
        only
          ? "Only these providers are used; if none can answer, the request fails instead of going elsewhere."
          : "They're tried first, in order; OpenRouter falls back to others if none can answer. Use `/provider only …` to allow nothing else."
      }`,
      blocked.length ? ` ${code(blocked)} is on your block list, but a pin wins for this model.` : "",
      endpoints ? "" : " (Couldn't reach OpenRouter to check these names.)",
    ].join("");
  }

  if (verb === "unpin") {
    if (!pinFor(r, model)) return `\`${model}\` has no pinned providers.`;
    await save(withPin(r, model, null));
    return `Unpinned \`${model}\`: it follows your Priority (**${SORT_LABELS[r.sort]}**) again.`;
  }

  if (verb === "block" || verb === "unblock") {
    if (!tail) return `Which provider? e.g. \`/provider ${verb} deepinfra\`.`;
    const providers = await loadProviders();
    if (verb === "unblock") {
      const match = findProvider(providers, tail)?.slug ?? r.ignore.find((s) => s === tail.toLowerCase());
      if (!match || !r.ignore.includes(match)) return `\`${tail}\` isn't blocked. Blocked: ${r.ignore.length ? code(r.ignore) : "none"}.`;
      await save({ ...r, ignore: r.ignore.filter((s) => s !== match) });
      return `Unblocked \`${match}\`.`;
    }
    const match = findProvider(providers, tail);
    if (!match && providers.length) return `There's no provider called \`${tail}\` on OpenRouter.`;
    const slug = match?.slug ?? baseSlug(tail.toLowerCase());
    if (r.ignore.includes(slug)) return `\`${slug}\` is already blocked.`;
    await save({ ...r, ignore: [...r.ignore, slug] });
    return `Blocked **${match?.name ?? slug}** (\`${slug}\`): it won't be used for any model, except one you've pinned it for.`;
  }

  if (verb === "off" || verb === "reset") {
    const others = Object.keys(withPin(r, model, null).pins);
    await save({ ...withPin(r, model, null), sort: "", noTraining: false, zdr: false, ignore: [] });
    return `Provider routing is back to OpenRouter's default for \`${model}\`: default priority, no privacy filters, nothing blocked or pinned.${
      others.length ? ` Pins on other models are kept: ${code(others)}.` : ""
    }`;
  }

  return `\`${word}\` isn't a /provider option. Type \`/provider\` to see the current routing and what you can change.`;
}
