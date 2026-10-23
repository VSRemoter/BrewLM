<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="artwork/brewlm-wordmark-dark.png" />
    <img src="artwork/brewlm-wordmark-light.png" alt="BrewLM" width="460" />
  </picture>
</p>

<p align="center">
  <b>Your personal research copilot</b> — a local-first, NotebookLM-style desktop app for macOS, Windows, and Linux.
</p>

BrewLM turns your own materials — PDFs, web pages, YouTube videos, notes, images, audio — into a grounded workspace: ask questions with inline source citations, then spin what you learn into flashcards, quizzes, mind maps, study guides, research reports, and two-host podcast episodes, all powered by the model of your choice (cloud or local). Sketch and work problems in the built-in Drawings pad while an episode plays. Everything (notebooks, chats, Studio outputs, settings) lives in a local SQLite database on your machine, and your API keys never leave it.

---

## Who it's for

- **Students** — ingest course readings and lectures, drill yourself with flashcards, quizzes, mind maps and study guides generated from your sources, listen to a podcast of your notes, and work problems by hand in Drawings.
- **Researchers & analysts** — upload papers and links, ask cited questions, produce briefing docs, and run web-powered Deep Research reports with citations.
- **Writers & knowledge workers** — keep a folder of topic notebooks, chat with their contents, and move findings into markdown reports.
- **Privacy-minded users** — it's local-first: no account, no cloud sync, no telemetry. Bring your own API key, or run fully offline with a local model.

---

## Key features

### Notebook workspaces
- Notebooks group **sources** (left), **chat** (center), and **Studio outputs** (right).
- Sources: pasted text, fetched web pages (CORS-free via Tauri HTTP), **YouTube links (transcript, title and description)**, linked PDFs/Office files, PDFs, Office docs (`.docx`, `.xlsx`, `.pptx` — text extracted per document/sheet/slide), eBooks (`.epub`), RTF, images, audio, video, and plain-text files (UTF-8 or Windows-1252). Unreadable binaries are rejected with a clear message instead of being stored as junk — plus optional per-notebook **Constitution** documents that steer every answer.
- **Everything is model-readable**: images are described and OCR'd by a vision model, and audio/video is transcribed (OpenAI or OpenRouter key; up to 25 MB), once at upload. That text is what chat, retrieval and Studio use. The source viewer shows exactly "What the AI sees", and media added before a suitable key existed is processed automatically before the next question.
- Homepage with folders, grid/list views, sorting, search, cover images, starring (pinning), multi-select bulk actions (move / trash / restore / delete), and a Trash with restore & permanent delete.

### Grounded chat
- Answers cite **your sources by title inline** (e.g. "…the effect was significant (Source: Week 4 lecture.pdf)").
- **Retrieval over sources**: source text is chunked and indexed locally (embedded via OpenAI/OpenRouter or a local embedding model, with an offline BM25 fallback), so each reply draws on the most relevant passages of *all* sources — a 400-page PDF stays answerable without large-context token costs.
- **Save to Sources**: hover any AI reply and save it as a source with one click, so a great answer becomes part of the notebook.
- **@mention** sources or Studio outputs mid-prompt to focus the context; mentions persist across follow-ups.
- **/ground** toggles source grounding per notebook — off means free-form answers from the model's own knowledge (no sources sent, no retrieval cost).
- **/search <query>** — one-shot web answer inline with numbered source links (provider web search, billed per query).
- **Cost visibility**: prompt caching (Anthropic cache breakpoints, OpenRouter/OpenAI usage accounting) keeps repeated notebook context cheap, and `/details` shows tokens and cost under every reply.
- Rich replies: Markdown, LaTeX math, Mermaid diagrams, inline SVG, and wide tables that spread past the chat column and scroll instead of overflowing.
- Multiple chat threads per notebook with auto-titles, renaming, a `/queue` for lining up prompts and commands, a **stop** button, and a per-notebook **chat background image**.

### Images in chat
- **/image [ratio] <prompt>** generates a picture with your **Image model** (OpenRouter Image API) — only the prompt is sent, never your sources or chat, so each image costs just the image.
- **/edit**, **/remix** and **/more** change, riff on, or rerun the latest picture; hover any generated picture for the same actions.

### The Studio
Every output is saved to the Studio panel and can be viewed, revised, downloaded, pinned or deleted. **Several tools can run at once** — start an audio episode, a report and a deep research together; each shows at the top of *Saved* with live progress and a cancel button, and keeps running if you leave the notebook. On notebooks too large for a context window, the tools share one **cached whole-notebook condensation**.
- **Flashcards** — active-recall decks (count / difficulty / focus).
- **Quiz** — multiple-choice with explanations and grading.
- **Mind map** — hierarchical outlines (Mermaid-rendered).
- **Audio overview** — a podcast between a **Host** and **Co-Host** (or a solo narrator): deep-dive, brief, debate or critique, **~5, ~10 or ~20 minutes**. Longer episodes are outlined first and written part by part, so even small models produce coherent long episodes. Voiced by system voices, OpenAI, ElevenLabs, or **any OpenRouter text-to-speech model** (e.g. Voxtral).
- **Report** — summary, study guide, briefing, FAQ, timeline, thorough analysis, or a fully custom prompt.
- **Deep research** — plans searches, reads the web, and writes a cited report on any topic; pages it reads are imported as sources.
- **Drawings** — a full-window [Excalidraw](https://excalidraw.com) sketchpad (pen, shapes, arrows, text, eraser, images) for quick notes, diagrams and working problems by hand. Autosaves, exports to PNG, follows light/dark themes, works offline — and drawings are **never sent to the AI**.
- **Revise** any AI output with an instruction, replacing it or saving a revised copy.
- One-click generation follows your **Studio Defaults**; the sliders icon on each card opens a customize dialog (sources, length, difficulty, focus…).

### Listening
- Audio overviews play in an **app-wide player**: minimize it and a **mini player** keeps going while you chat, change notebooks, open Settings or draw — with play/pause, ±15 s, seeking and stop.

### Models & voices
- **Providers**: OpenRouter, OpenAI, Anthropic, or **Local** — any OpenAI-compatible server such as **Ollama, LM Studio or llama.cpp**, with a local embedding model and context-window setting for fully offline use.
- **Separate models per job**, each with its own saved list in Settings and slash commands: the main **chat model** (`/model`), an **Image model** (`/imagemodel`), and a **Research model** for Deep Research and `/search` (`/researchmodel`, defaults to your main model).
- **Voices**: a saved voice library per TTS provider (OpenAI and OpenRouter voice names, or ElevenLabs voice IDs with friendly names). Pick the Host and Co-Host voices in Settings → Audio Voices or with `/voicehost`, `/voicecohost` and `/voice swap`.

### Customization & organization
- **Clone & Template**: `/clone "<title>" [yes|no]` duplicates a notebook exactly (sources + chats + Studio). **Use as template** on the homepage makes a sources-only starter copy.
- **Folders** with `/move`, **star** pinning, renaming of chats and notebooks, per-notebook covers and chat backgrounds.
- **12 themes** — Brew (default), Daylight, Midnight, Forest, Ocean, Copper, Wine, Rose, Matrix, Lilac, Sunset and Candy — and **6 interface fonts** (System, Serif, Rounded, Mono, Avenir, Typewriter), switchable instantly with `/theme` and `/font`.
- **Settings**: Appearance (theme, font, text size, smooth scrolling, response details), AI Model (provider, keys, models, image & research models, temperature), Studio Defaults, Audio Voices (TTS provider, TTS models, saved voices), Usage & Cost (per-model token ledger with cost estimates), Data & Storage (backup export/import, Trash auto-empty, factory reset), Phone Pairing, and About & Updates. Everything saves instantly.

### Pair your phone
- **Settings → Phone Pairing** (or the phone icon in a notebook header) shows a QR code + 6-digit PIN, valid for ~20 minutes. Scan it from anywhere — cellular included — and a secure cloudflared tunnel pairs the device. No app to install, no account.
- **Choose the scope when pairing**: *Full access* (chat, generation, writes) or *read-only* (browse chats & sources, listen to audio).
- From the phone: **chat** with cited answers, run **flashcards/quizzes**, **generate** Studio outputs (podcast audio included), **add notes/links**, manage notebooks, and stream **audio overviews** with lock-screen controls.
- Safety: every linked device is listed with **one-tap revoke** and a **recent activity log** (per-device revocable keys, rate limits on AI actions, soft-delete everywhere) — and **your API keys never leave your computer**.
- The phone talks to BrewLM on your computer, so the computer must be on, awake and running BrewLM with sharing started. The tunnel address changes each time sharing starts, so the phone re-pairs after a restart.

### Local-first, bring your own keys
- Everything — notebooks, sources, chats, Studio outputs, settings and API keys — lives in one SQLite file, `brewlm.db`, in the app data folder (on macOS: `~/Library/Application Support/com.brewlm.app/`), with media (audio overviews, images, covers) as files in `blobs/` beside it. Schema migrations run automatically at startup; **Data & Storage → Export backup** saves both as one `.zip` (older `.db` backups still import).
- AI calls go straight from your computer to the provider you chose; nothing is proxied through a BrewLM server.

---

## Getting started

### Option 1 — Download an installer (no toolchain needed)

Grab the latest build from [**GitHub Releases**](https://github.com/VSRemoter/BrewLM/releases):

| Platform | Download | Notes |
|---|---|---|
| **macOS** | `BrewLM_…_universal.dmg` | Intel + Apple Silicon in one image. Unsigned, so first launch: **right-click → Open → Open**. If macOS reports the app as "damaged", run `xattr -cr /Applications/BrewLM.app` once. |
| **Windows** | `BrewLM_…_x64-setup.exe` (or the `.msi`) | SmartScreen warns on unsigned installers: **More info → Run anyway**. |
| **Linux** | `BrewLM_…_amd64.AppImage` or `…_amd64.deb` | AppImage: `chmod +x` then run. Debian/Ubuntu: `sudo apt install ./BrewLM_*.deb`. |

Then add an API key (or connect a local model) in **Settings** on first launch — see *First launch* below.

### Option 2 — Build from source

#### Requirements
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (Tauri 2 toolchain)
- An API key for OpenRouter, OpenAI or Anthropic — or a local model server (Ollama, LM Studio, llama.cpp). TTS keys are optional.

#### Run in development
```bash
git clone https://github.com/VSRemoter/BrewLM.git
cd BrewLM
npm install
npm run tauri dev
```
The app opens as a desktop window (Vite dev server on port 1420). `npm install` also copies Excalidraw's fonts into `public/excalidraw/` so Drawings work offline.

### First launch
1. **Pick a model** — Settings (⚙) → AI Model → choose a provider and paste a key (or choose **Local** and connect your server), then pick a model. The OpenRouter default is `openai/gpt-4o-mini`.
2. **Create a notebook** from the homepage (title, description, folder, optional cover).
3. **Add sources**: drag files onto the chat, use the Sources panel, `/note <text>`, or `/url <link>`.
4. **Chat** — and try the slash commands below. `/help` prints the full in-app guide.

### Build for release
```bash
npm run tauri build
```
Produces a native bundle for your OS in `src-tauri/target/release/bundle/` (`.dmg` on macOS, `.msi`/`.exe` on Windows, `.AppImage`/`.deb` on Linux).

**Maintainers:** phone pairing tunnels run through [cloudflared](https://github.com/cloudflare/cloudflared) (BSD-3-Clause © Cloudflare), bundled as a Tauri sidecar. Run `bash scripts/fetch-sidecars.sh` once before `tauri build` (the CI release workflow does this automatically). In dev (`tauri dev`) any `cloudflared` on PATH works — e.g. `brew install cloudflared`; Windows builds currently fall back to PATH (see the script header). Pushing a tag like `v0.x.y` runs the *Release* workflow (`.github/workflows/release.yml`), which builds macOS, Windows and Linux installers in CI and attaches them to a draft GitHub Release. Review the draft, then publish.

---

## Slash commands (all in-app)

Type `/` in chat to open the palette with autocomplete.

**App & models** (run locally — no AI tokens)

| Command | What it does |
|---|---|
| `/help` | Full in-app guide |
| `/model <id>` · `/model add <id>` · `/model remove <id>` | Switch the chat model, or edit your saved list (OpenRouter ids are checked; paste an id or an openrouter.ai link) |
| `/imagemodel <id>` · `add` · `remove` | Switch or edit the models `/image` draws with |
| `/researchmodel <id>` · `add` · `remove` · `main` | Switch or edit the model Deep Research and `/search` run on; `main` goes back to your chat model |
| `/voice` | Show the Host and Co-Host voices and your saved voices |
| `/voicehost <name>` · `/voicecohost <name>` | Switch the Host's or Co-Host's voice (autocompletes your voices) |
| `/voice swap` | Trade the Host and Co-Host voices |
| `/voice add <name> [voice ID]` · `/voice remove <name>` | Save or delete a voice (ElevenLabs: a name + its voice ID; OpenRouter: the model's voice name, e.g. `voice_3150`) |
| `/theme <name>` · `/font <name>` | Switch the app theme or interface font instantly |
| `/details [on\|off]` | Show or hide token counts and cost under AI replies |
| `/ground` | Toggle source grounding for this notebook |
| `/move <folder>` | File the notebook into a folder (`/move out` lifts it to the root) |
| `/star` | Star or un-star the notebook |
| `/new` | Fresh chat thread (the old one stays in the Chats panel) |
| `/rename <title>` | Rename this chat thread |
| `/clear` | Delete this chat thread and start fresh |
| `/clone "<title>" [yes\|no]` | Exact copy of the notebook — quoted title required; `yes` jumps to the copy |
| `/remove <sources\|chats\|studios> [type]` | Bulk delete, optionally narrowed (e.g. `/remove sources links`, `/remove studios drawings`) |
| `/note <text>` · `/url <link>` | Save pasted text, or fetch a web page, into your sources |
| `/return` | Back to the homepage |
| `/queue <prompt or command>` | Line up work to run when the current task finishes |

**AI actions** (use your provider)

| Command | What it does |
|---|---|
| `/summarize` | Summarize the whole notebook here in chat |
| `/search <query>` | One-shot web answer with numbered source links (billed per query) |
| `/image [16:9] <prompt>` | Generate a picture with your image model — no chat context sent |
| `/edit <change>` · `/remix <idea>` · `/more` | Change, riff on, or rerun the latest picture |
| `/flashcards [8\|12\|24] [easy\|medium\|hard] [focus]` | Flashcard deck → Studio |
| `/quiz [4\|8\|15] [easy\|medium\|hard] [focus]` | Multiple-choice quiz → Studio |
| `/mindmap [focus]` | Mind map → Studio |
| `/audio [deep-dive\|brief\|debate\|critique] [short\|standard\|long] [focus]` | Podcast episode (~5 / ~10 / ~20 min) → Studio |
| `/report [summary\|study-guide\|briefing\|faq\|timeline\|analysis\|custom]` | Markdown document → Studio |
| `/research <topic>` | Web-powered cited report → Studio |

**Trivia:** quoting matters in `/clone`. `/clone "Project yes" no` clones a notebook named *Project yes* and stays put — the `no` outside the quotes is the real flag.

---

## Architecture at a glance

- **Tauri 2 + React 19 + TypeScript + Vite** frontend; Tailwind CSS 4 design system.
- **SQLite** (`@tauri-apps/plugin-sql`) as the data store — notebooks, folders, sources, chats, artifacts, settings, paired devices, and Trash (`trashed_at`) soft-delete. Media lives in a content-addressed file store (`src-tauri/src/blobs.rs`, `src/lib/blobs.ts`) served to the webview over a `brewblob://` scheme; rows hold `brewblob:<sha256>.<ext>` references. Audio overviews are stored as AAC `.m4a` (`src/lib/audioEncode.ts`). Triggers record row changes in `sync_meta`/`sync_outbox` for the upcoming BrewLM Sync.
- **AI calls** happen in the webview via `fetch` with your keys (never proxied); Tauri plugins supply native file dialogs, filesystem access and CORS-free page fetching.
- **Studio**: pipelines in `src/lib/studio.ts` (prompts), `audioScript.ts` (part-by-part podcast scripts), `tts.ts`, `research.ts` and `rag.ts`; running generations are tracked in `studioJobs.ts` so several run at once. Playback lives in `src/components/AudioPlayer.tsx`; Drawings use Excalidraw, lazily loaded from `DrawingCanvas.tsx`.
- **Phone sharing**: a small embedded web server (`src-tauri/src/server.rs`, axum) serves a pairing/mobile client (`src-tauri/mobile.html`) and a device-key-authenticated API over the local DB; a `cloudflared` quick tunnel makes it reachable anywhere. Phone-issued chat/generate requests land in a `jobs` table that the desktop webview drains (`src/lib/jobRunner.ts`) using the same pipelines as the in-app Studio.
- Slash commands and the queue live in `src/components/ChatPanel.tsx`; settings and model/voice lists in `src/lib/settings.ts`.

---

## License

BrewLM is released under the **Apache License 2.0**. See `LICENSE` for the full text. Drawings are powered by [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT).

---

## Contributing

Issues and PRs are welcome. The codebase is small and single-purpose: sources → chat → Studio. If you add a slash command, also add it to the palette registry and the `/help` guide in `src/components/ChatPanel.tsx`.
