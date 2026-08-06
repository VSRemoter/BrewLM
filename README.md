# BrewLM

Your personal research copilot — a local-first, NotebookLM-style desktop app for macOS, Windows, and Linux.

BrewLM turns your own materials — PDFs, web pages, notes, images, audio — into a grounded workspace: ask questions with inline source citations, then spin what you learn into flashcards, quizzes, mind maps, study guides, and even two-host podcast audio, all powered by the LLM of your choice. Everything (notebooks, chats, studio outputs, settings) lives in a local SQLite database on your machine. Your API keys never leave it.

> **Formerly OpenMind.** The app was renamed BrewLM; the repository name is unchanged.

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
- **@mention** sources mid-prompt to focus the context; mentions persist across follow-ups.
- Multiple chat threads per notebook with auto-titles, renaming, and a queue: `/queue` stacks prompts/commands to run in order when the current reply finishes.
- Streaming responses with a **stop** button, activity-aware chat titles, and a per-notebook **chat background image** with a dim slider.

### The Studio (generation tools)
Every output is saved to the Studio panel and can be viewed, revised, downloaded, or deleted:
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

### Local-first, bring-your-own-keys
- Provider choice: **OpenRouter**, **OpenAI**, or **Anthropic** — keys stored locally in `~/.brewlm` (app support dir). Optional separate TTS provider (system voices, OpenAI, OpenRouter, ElevenLabs).
- One SQLite file (`brewlm.db`) holds everything; schema migrations run automatically at startup.

---

## Getting started

### Requirements
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (Tauri 2 toolchain)
- An API key for OpenRouter, OpenAI, or Anthropic (for generation; TTS is optional)

### Run in development
```bash
git clone https://github.com/VSRemoter/OpenMind.git
cd OpenMind
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
Produces a signed-native bundle for your OS in `src-tauri/target/release/bundle/`.

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
- **SQLite** (`@tauri-apps/plugin-sql`) as the sole data store — notebooks, folders, sources, chats, artifacts, settings, and trash (`trashed_at`) soft-delete.
- **LLM calls** happen in the webview via `fetch` with your keys (never proxied); Tauri plugins supply native file dialogs, filesystem access, and CORS-free page fetching.
- Slash commands and the FIFO queue live in `src/components/ChatPanel.tsx`; generation pipelines in `src/lib/studio.ts`, `research.ts`, `llm.ts`, `tts.ts`.

---

## License

BrewLM is released under the **Apache License 2.0**. See `LICENSE` for the full text.

---

## Contributing

Issues and PRs are welcome. The codebase is small and single-purpose: sources → chat → studio. If you add a slash command, also add it to the palette registry and the `/help` guide in `src/components/ChatPanel.tsx`.
