<p align="center">
  <img src="public/BrewLM-Logo-Wide.png" alt="BrewLM" width="420" />
</p>

<p align="center">
  <b>Your personal research copilot</b> — a local-first, NotebookLM-style desktop app for macOS, Windows, and Linux.
</p>

BrewLM turns your own materials — PDFs, web pages, notes, images, audio — into a grounded workspace: ask questions with inline source citations, then spin what you learn into flashcards, quizzes, mind maps, study guides, and even two-host podcast audio, all powered by the LLM of your choice. Everything (notebooks, chats, studio outputs, settings) lives in a local SQLite database on your machine. Your API keys never leave it.

> **Formerly OpenMind.** The app and repository were renamed BrewLM.

---

## Who it's for

- **Students** — ingest course readings and lectures, then drill yourself with flashcards, quizzes, mind maps, and study guides generated straight from your sources.
- **Researchers & analysts** — upload papers and links, ask cited questions, produce briefing docs, and run web-powered /research reports with inline citations.
- **Writers & knowledge workers** — keep a folder of topic notebooks, chat with their contents, and move findings into markdown reports.
- **Privacy-minded users** — it's local-first: no account, no cloud sync, no telemetry. Bring your own API key and pick your provider.

---

## Key features

### Notebook workspaces
- Notebooks group **sources** (left), **chat** (center), and **Studio outputs** (right).
- Sources: pasted text, fetched webpages (CORS-free via Tauri HTTP), PDFs, images, audio, and generic files — plus optional "Constitution" reference docs.
- Homepage with folders, grid/list views, sorting, search, cover images on cards, starring (pinning), multi-select bulk actions (move / trash / restore / delete), and a Trash with restore & permanent delete.

### Grounded chat
- Answers cite **your sources inline** (e.g., “…the effect was significant [1]”) — one click takes you to the source.
- **Retrieval over sources**: source text is chunked and indexed locally (embedded via OpenAI/OpenRouter when available, with an offline BM25 fallback — stale BM25 indexes auto-upgrade once a working key is present), so each reply draws on the most relevant passages of *all* sources — a 400-page PDF stays fully answerable without large-context token costs. The prompt also says explicitly which sources weren't covered.
- **Prompt caching & cost controls**: Anthropic cache breakpoints and OpenAI/OpenRouter usage accounting keep repeated notebook context cheap (cache reads ~10% price); generated images are downscaled before saving and pixels never re-enter chat history — each reply shows its token usage (in / out / cache hit).
- **@mention** sources mid-prompt to focus the context; mentions persist across follow-ups.
- **/ground** toggles source grounding per notebook — off means free-form answers from the model's own knowledge (no sources sent, no retrieval cost); @mentions still pull a source back in for one answer.
- **/search <query>** — one-shot web answer inline with numbered source links (provider web search, billed per query); `/research <topic>` remains the deep, report-style version saved to Studio.
- Multiple chat threads per notebook with auto-titles, renaming, and a queue: `/queue` stacks prompts/commands to run in order when the current reply finishes.
- Streaming responses with a **stop** button, activity-aware chat titles, and a per-notebook **chat background image** with a dim slider.

### The Studio (generation tools)
Every output is saved to the Studio panel and can be viewed, revised, downloaded, or deleted. On notebooks too large for a context window, every tool (flashcards, quiz, mind map, audio, report) runs over a **cached whole-notebook condensation** — one exhaustive map-reduce pass, shared by all tools until the sources change:
- **Flashcards** — active-recall decks (count / difficulty / focus).
- **Quiz** — multiple-choice with explanations and grading.
- **Mind map** — hierarchical idea outlines (mermaid-rendered).
- **Audio** — two-host podcast: deep-dive, brief, debate, or critique — with script generation and TTS. Voices, model, and instructions are configurable.
- **Report** — summary, study-guide, briefing, FAQ, timeline, analysis, or fully custom prompts.
- **Research** — web-powered, cited reports on any topic (3–5 auto-generated search angles).
- **Revise** any output: instruct changes and either replace or save a revised copy.

### Customization & organization
- **Clone & Template**: `/clone "<title>" [yes|no]` duplicates a notebook exactly (sources + chats + studio). **Use as template** on the homepage makes a sources-only starter copy.
- **Folders** with `/move`, **star** pinning, **rename** chats and notebooks, per-notebook covers and chat backgrounds.
- **Themes** — 8 built-in (Original, Midnight, Forest, Ocean, Copper, Wine, Rose, Matrix); switch instantly with `/theme <name>`.
- Model switching per provider with autocomplete and custom model lists.

### Pair your phone
- **Settings → Pair a device** (or the phone icon in a notebook header) shows a QR code + 6-digit PIN. Scan it from anywhere — cellular included — and a secure tunnel from your Mac pairs the device. No app to install, no account.
- From the phone: **chat** with cited answers, run **flashcards/quizzes** with grading, **generate** any Studio output (podcast audio included), **add notes/link sources**, create/rename/trash notebooks, and stream **audio overviews** with lock-screen controls.
- Safety: per-device revocable keys, read-only or full-access scopes, rate limits on LLM actions, soft-delete everywhere, an activity log — and **your API keys never leave the Mac**. Requires BrewLM running on the Mac.

### Local-first, bring-your-own-keys
- Provider choice: **OpenRouter**, **OpenAI**, or **Anthropic** — keys stored locally in `~/.brewlm` (app support dir). Optional separate TTS provider (system voices, OpenAI, OpenRouter, ElevenLabs).
- One SQLite file (`brewlm.db`) holds everything; schema migrations run automatically at startup.

---

## Getting started

### Option 1 — Download an installer (no toolchain needed)

Grab the latest build from [**GitHub Releases**](https://github.com/VSRemoter/BrewLM/releases):

| Platform | Download | Notes |
|---|---|---|
| **macOS** | `BrewLM_…_universal.dmg` | Intel + Apple Silicon in one image. Unsigned, so first launch: **right-click → Open → Open**. If macOS reports the app as "damaged", run `xattr -cr /Applications/BrewLM.app` once. |
| **Windows** | `BrewLM_…_x64-setup.exe` (or the `.msi`) | SmartScreen warns on unsigned installers: **More info → Run anyway**. |
| **Linux** | `BrewLM_…_amd64.AppImage` or `…_amd64.deb` | AppImage: `chmod +x` then run. Debian/Ubuntu: `sudo apt install ./BrewLM_*.deb`. |

Then add an API key in **Settings** on first launch (see *First launch* below).

### Option 2 — Build from source

#### Requirements
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (Tauri 2 toolchain)
- An API key for OpenRouter, OpenAI, or Anthropic (for generation; TTS is optional)

### Run in development
```bash
git clone https://github.com/VSRemoter/BrewLM.git
cd BrewLM
npm install
npm run tauri dev
```
The app opens as a desktop window (Vite dev server on port 1420).

### First launch
1. **Add your API key** — Settings (⚙) → pick provider → paste key → choose a model. Defaults are friendly (`openai/gpt-4o-mini` on OpenRouter).
2. **Create a notebook** from the homepage (title, description, folder, optional cover).
3. **Add sources**: drag files onto the chat, use the Sources panel, `/note <text>`, or `/url <link>`.
4. **Chat** — and try the slash commands below. `/help` reprints the full in-app guide.

### Build for release
```bash
npm run tauri build
```
Produces a native bundle for your OS in `src-tauri/target/release/bundle/` (`.dmg` on macOS, `.msi`/`.exe` on Windows, `.AppImage`/`.deb` on Linux).

**Maintainers:** phone pairing tunnels run through [cloudflared](https://github.com/cloudflare/cloudflared) (BSD-3-Clause © Cloudflare), bundled as a Tauri sidecar. Run `bash scripts/fetch-sidecars.sh` once before `tauri build` (the CI release workflow does this automatically). In dev (`tauri dev`) any `cloudflared` on PATH works — e.g. `brew install cloudflared`; Windows builds currently fall back to PATH (see the script header). Pushing a tag like `v0.x.y` runs the *Release* workflow (`.github/workflows/release.yml`), which builds macOS, Windows, and Linux installers in CI and attaches them to a draft GitHub Release. Review the draft, then publish.

---

## Slash commands (all in-app)

Type `/` in chat to open the palette with autocomplete.

| Command | What it does |
|---|---|
| `/help` | Full in-app guide |
| `/model <id>` | Switch the active model (autocompletes your list; new ids are saved) |
| `/theme <name>` | Instantly switch the app theme (autocompletes) |
| `/move <folder>` | File notebook into a folder (`/move out` lifts to root; inline folder creation) |
| `/new` | Fresh chat thread (old one stays in the Chats panel) |
| `/clone "<title>" [yes no]` | Exact copy of the notebook — quoted title required; `yes` jumps to the copy |
| `/remove <sources chats studios> [type]` | Bulk delete by scope, optionally narrowed (e.g. `/remove sources links`, `/remove studios audios`) |
| `/return` | Back to the homepage |
| `/clear` | Delete this chat thread and start fresh |
| `/star` | Pin/unpin the notebook on the homepage |
| `/note <text>` | Save pasted text as a source |
| `/url <link>` | Fetch a webpage into sources |
| `/summarize` | Summarize the notebook here in chat |
| `/flashcards [8 12 24] [easy medium hard] [focus]` | Flashcard deck → Studio |
| `/quiz [4 8 15] [easy medium hard] [focus]` | MC quiz → Studio |
| `/mindmap [focus]` | Mind map → Studio |
| `/audio [deep-dive brief debate critique] [short standard long] [focus]` | Two-host podcast → Studio |
| `/report [summary study-guide briefing faq timeline analysis custom]` | Markdown document → Studio |
| `/research <topic>` | Web-powered cited report → Studio |
| `/queue <prompt or command>` | Line up work to run when the current task finishes |
| `/rename <title>` | Rename the current chat thread |

**Trivia:** quoting matters in `/clone`. `/clone "Project yes" no` clones a notebook named *Project yes* and stays put — the `no` outside the quotes is the real flag.

---

## Architecture at a glance

- **Tauri 2 + React 19 + TypeScript + Vite** frontend; Tailwind CSS 4 design system.
- **SQLite** (`@tauri-apps/plugin-sql`) as the sole data store — notebooks, folders, sources, chats, artifacts, settings, paired devices, and trash (`trashed_at`) soft-delete.
- **LLM calls** happen in the webview via `fetch` with your keys (never proxied); Tauri plugins supply native file dialogs, filesystem access, and CORS-free page fetching.
- **Phone sharing**: a small embedded web server (`src-tauri/src/server.rs`, axum) serves a pairing/mobile client (`src-tauri/mobile.html`) and a device-key-authenticated API over the local DB; a `cloudflared` quick tunnel makes it reachable anywhere. Phone-issued chat/generate requests land in a `jobs` table that the desktop webview drains (`src/lib/jobRunner.ts`) using the same pipelines as the in-app Studio.
- Slash commands and the FIFO queue live in `src/components/ChatPanel.tsx`; generation pipelines in `src/lib/studio.ts`, `research.ts`, `llm.ts`, `tts.ts`.

---

## License

BrewLM is released under the **Apache License 2.0**. See `LICENSE` for the full text.

---

## Contributing

Issues and PRs are welcome. The codebase is small and single-purpose: sources → chat → studio. If you add a slash command, also add it to the palette registry and the `/help` guide in `src/components/ChatPanel.tsx`.
