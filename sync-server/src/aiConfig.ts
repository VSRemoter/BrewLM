/**
 * BrewLM AI's remote config (GET /v1/ai/config): which OpenRouter model does
 * each job for plan subscribers. Changing a model here and running
 * `npm run deploy` switches every app within the hour (no app release).
 *
 * The embedding model is the exception: chunks embedded by one model can't be
 * compared with another's, so changing it means bumping `embedding.version`,
 * and the app re-embeds each notebook in the background before using the new
 * one. Don't change it casually.
 */

export const AI_CONFIG_VERSION = 1;

export const AI_CONFIG = {
  version: AI_CONFIG_VERSION,
  /** What users pick between (model names stay hidden in the app). */
  tiers: {
    fast: { label: "Fast", model: "z-ai/glm-5.3-flash" },
    smart: { label: "Smart", model: "deepseek/deepseek-v4.1-flash-1017" },
    best: { label: "Best", model: "openai/gpt-6.1-sol" },
  },
  /** The tier new subscribers start on. */
  defaultTier: "fast",
  /**
   * Settings → AI Model → More models: other capable chat models, none
   * pricier than Best. The app shows each one's cost next to Fast's from
   * OpenRouter's public prices. Checked against the catalog 2026-11-06.
   */
  more: [
    { label: "GPT-6 Luna", model: "openai/gpt-6-luna" },
    { label: "Qwen3.8 Flash", model: "qwen/qwen3.8-flash" },
    { label: "Mistral Large 4", model: "mistralai/mistral-large-4-0" },
    { label: "Gemini 3.8 Flash", model: "google/gemini-3.8-flash" },
    { label: "GPT-6.1 Terra", model: "openai/gpt-6.1-terra" },
    { label: "Grok 4.7", model: "x-ai/grok-4.7" },
    { label: "Gemini 4 Argon", model: "google/gemini-4-argon" },
    { label: "Kimi K3.1 Pro", model: "moonshotai/kimi-k3.1-pro" },
  ],
  /** Fixed jobs; users don't choose these. */
  roles: {
    /** Titles, chunk summaries, condensing: always cheap, whatever tier is picked. */
    background: "z-ai/glm-5.3-flash",
    research: { planner: "deepseek/deepseek-v4.1-flash-1017", reader: "z-ai/glm-5.3-flash" },
    // HeyGen voices: nadine, tabitha, noelle, meredith, sabrina, bram, gareth, lucian, weston, vincent.
    tts: { model: "heygen/heygen-voice-1-turbo", voices: { host: "nadine", cohost: "gareth" } },
    transcribe: "google/gemini-3.5-flash-lite",
    // Recraft takes no reference picture, so BrewLM AI can't /edit or /remix pictures.
    image: "recraft/recraft-v4.1-flash",
    embedding: { model: "openai/text-embedding-3-small", dims: 512, version: 1 },
  },
} as const;

/**
 * Rough cost of one of each thing, in US dollars of OpenRouter credit, for the
 * "≈ N left" estimates (prices checked 2026-11-07, cheapest providers first,
 * rounded up to stay on the safe side). Never sent to the app: it shows
 * counts and a percentage, not dollars.
 */
export const AI_ESTIMATES = {
  chats: 0.001, // a Fast (GLM 5.3 Flash) reply with ~20k tokens of sources
  audioOverviews: 0.05, // ~10 minutes: ~9,000 characters of HeyGen voice ($4/M) plus the script
  researchRuns: 0.08, // mostly web-search fees
  transcriptionHours: 0.07,
  images: 0.01, // Recraft V4.1 Flash, $0.007
} as const;

/** Monthly AI allowance per plan, in dollars of OpenRouter credit. */
export const AI_MONTHLY: Record<string, number> = { pro: 4, max: 10 };
/** During a plan's (card-backed) Polar trial, whatever the plan. */
export const AI_TRIAL = 0.5;
/** What one AI top-up (POLAR_PRODUCT_AI_TOPUP, sold for $7) adds. Unused top-ups carry over while the plan lasts. */
export const AI_TOPUP_CREDIT = 5;
