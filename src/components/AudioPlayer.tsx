/**
 * App-wide Audio Overview playback. One player lives at the app root, so
 * listening carries on while the user closes the overview, opens Settings,
 * switches notebooks or keeps chatting. The overview modal and the floating
 * mini player both drive it.
 *
 * On phones and upright tablets the mini player docks into the page instead
 * of floating: a slim bar just above the notebook's tab bar (or along the
 * bottom of Home), so it never covers the tabs, the chat box or a sheet.
 *
 * Two engines: a synthesized m4a/mp3/wav plays through one <audio> element; a
 * script with no audio file is read with the system voices line by line
 * (seeking jumps between lines).
 */
import { Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SPEAKER_LABEL } from "../lib/tts";
import { BrewIcon } from "./BrewIcon";

export interface ScriptTurn {
  speaker: "Alex" | "Sam";
  text: string;
}

export interface Track {
  /** The audio artifact's id. */
  id: string;
  title: string;
  /** URL of the synthesized file (stored file or data: URL); null = read the script with system voices. */
  src: string | null;
  script: ScriptTurn[];
}

interface PlayerState {
  track: Track | null;
  playing: boolean;
  /** Seconds (audio) or the current line index (system voices). */
  position: number;
  /** Seconds (audio) or the number of lines (system voices). */
  length: number;
  /** Script line being read (system voices only). */
  line: number | null;
  /** Artifact whose overview modal is open — the mini player hides for it. */
  openId: string | null;
}

interface PlayerApi extends PlayerState {
  /** Load a track (if it isn't already) and start playing. */
  play: (track: Track) => void;
  toggle: () => void;
  /** Seconds for audio, a line index for system voices. */
  seek: (to: number) => void;
  /** Jump by `delta` seconds (audio) or lines (system voices). */
  skip: (delta: number) => void;
  stop: () => void;
  /** The overview modal tells the player it is showing `id` (null when it closes). */
  setOpenId: (id: string | null) => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

/** A place in the page the mini player can dock into (phones and upright tablets). */
interface Dock {
  el: HTMLElement;
  /** Higher wins: the open notebook's dock beats the app-wide one. */
  level: number;
  /** Runs along the screen's bottom edge, so the bar keeps clear of the home indicator. */
  edge: boolean;
}

const DockContext = createContext<((dock: Dock) => () => void) | null>(null);

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer needs an <AudioPlayerProvider> above it");
  return ctx;
}

const SPEECH_OK = typeof window !== "undefined" && "speechSynthesis" in window;

/** Pick two distinct voices (prefer English) — one per host. */
function pickVoices(): Promise<[SpeechSynthesisVoice | null, SpeechSynthesisVoice | null]> {
  return new Promise((resolve) => {
    const pick = () => {
      const all = window.speechSynthesis.getVoices();
      if (!all.length) return false;
      const en = all.filter((v) => v.lang.toLowerCase().startsWith("en"));
      const pool = en.length >= 2 ? en : all;
      resolve([pool[0] ?? null, pool[1] ?? pool[0] ?? null]);
      return true;
    };
    if (pick()) return;
    window.speechSynthesis.onvoiceschanged = () => pick();
    setTimeout(() => pick(), 1500);
  });
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Bumped to cancel an in-flight system-voice run. */
  const runRef = useRef(0);
  const trackRef = useRef<Track | null>(null);
  const [state, setState] = useState<PlayerState>({
    track: null,
    playing: false,
    position: 0,
    length: 0,
    line: null,
    openId: null,
  });
  const patch = useCallback((p: Partial<PlayerState>) => setState((s) => ({ ...s, ...p })), []);

  const docksRef = useRef<Dock[]>([]);
  const [dock, setDock] = useState<Dock | null>(null);
  const addDock = useCallback((d: Dock) => {
    const pick = () =>
      setDock(docksRef.current.reduce<Dock | null>((best, x) => (!best || x.level > best.level ? x : best), null));
    docksRef.current = [...docksRef.current, d];
    pick();
    return () => {
      docksRef.current = docksRef.current.filter((x) => x !== d);
      pick();
    };
  }, []);

  // One <audio> element for the app's lifetime.
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    const sync = () => patch({ position: a.currentTime, length: Number.isFinite(a.duration) ? a.duration : 0 });
    a.addEventListener("timeupdate", sync);
    a.addEventListener("loadedmetadata", sync);
    a.addEventListener("play", () => patch({ playing: true }));
    a.addEventListener("pause", () => patch({ playing: false }));
    a.addEventListener("ended", () => patch({ playing: false, position: a.duration || 0 }));
    audioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
    };
  }, [patch]);

  /* ----------------------------- system voices ----------------------------- */

  const speakFrom = useCallback(
    async (start: number) => {
      const track = trackRef.current;
      if (!SPEECH_OK || !track) return;
      window.speechSynthesis.cancel();
      const run = ++runRef.current;
      const [va, vb] = await pickVoices().catch((): [null, null] => [null, null]);
      if (runRef.current !== run) return;
      const { script } = track;
      let i = Math.max(0, Math.min(start, script.length - 1));
      const step = () => {
        if (runRef.current !== run) return;
        if (i >= script.length) {
          patch({ playing: false, line: null, position: script.length });
          return;
        }
        patch({ playing: true, line: i, position: i });
        const u = new SpeechSynthesisUtterance(script[i].text);
        const voice = script[i].speaker === "Alex" ? va : vb;
        if (voice) u.voice = voice;
        u.onend = () => {
          if (runRef.current === run) {
            i++;
            step();
          }
        };
        u.onerror = u.onend;
        window.speechSynthesis.speak(u);
      };
      step();
    },
    [patch]
  );

  const cancelSpeech = () => {
    runRef.current++;
    if (SPEECH_OK) window.speechSynthesis.cancel();
  };

  /* --------------------------------- api --------------------------------- */

  const stop = useCallback(() => {
    cancelSpeech();
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    trackRef.current = null;
    patch({ track: null, playing: false, position: 0, length: 0, line: null });
  }, [patch]);

  const play = useCallback(
    (track: Track) => {
      const a = audioRef.current;
      const fresh = trackRef.current?.id !== track.id;
      if (fresh) {
        cancelSpeech();
        a?.pause();
        trackRef.current = track;
        patch({ track, playing: false, position: 0, length: track.src ? 0 : track.script.length, line: null });
        if (track.src && a) a.src = track.src;
      }
      if (track.src) void a?.play();
      else void speakFrom(fresh ? 0 : (state.line ?? 0));
    },
    [patch, speakFrom, state.line]
  );

  const toggle = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    if (track.src) {
      const a = audioRef.current;
      if (!a) return;
      if (a.paused) {
        if (a.ended) a.currentTime = 0;
        void a.play();
      } else a.pause();
      return;
    }
    if (!SPEECH_OK) return;
    if (state.playing) {
      // Pause = stop after remembering the line; resume re-reads that line.
      cancelSpeech();
      patch({ playing: false });
    } else {
      const from = state.line ?? (state.position >= track.script.length ? 0 : state.position);
      void speakFrom(from);
    }
  }, [patch, speakFrom, state.playing, state.line, state.position]);

  const seek = useCallback(
    (to: number) => {
      const track = trackRef.current;
      if (!track) return;
      if (track.src) {
        const a = audioRef.current;
        if (!a) return;
        a.currentTime = Math.max(0, Math.min(to, a.duration || to));
        patch({ position: a.currentTime });
        return;
      }
      const line = Math.max(0, Math.min(Math.round(to), track.script.length - 1));
      if (state.playing) void speakFrom(line);
      else patch({ line, position: line });
    },
    [patch, speakFrom, state.playing]
  );

  const skip = useCallback(
    (delta: number) => seek((trackRef.current?.src ? audioRef.current?.currentTime ?? 0 : state.line ?? state.position) + delta),
    [seek, state.line, state.position]
  );

  const setOpenId = useCallback((id: string | null) => patch({ openId: id }), [patch]);

  // Lock screen, Control Center and headphone buttons (phones especially):
  // show what's playing and route play/pause/skip back to this player.
  const controlsRef = useRef({ toggle, skip, seek, stop, playing: state.playing });
  controlsRef.current = { toggle, skip, seek, stop, playing: state.playing };
  const title = state.track?.title;
  const hasFile = !!state.track?.src;
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (!title) {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title,
      artist: "BrewLM Audio Overview",
      artwork: [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    const step = hasFile ? 15 : 1;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => !controlsRef.current.playing && controlsRef.current.toggle()],
      ["pause", () => controlsRef.current.playing && controlsRef.current.toggle()],
      ["stop", () => controlsRef.current.stop()],
      ["seekbackward", (d) => controlsRef.current.skip(-(d.seekOffset ?? step))],
      ["seekforward", (d) => controlsRef.current.skip(d.seekOffset ?? step)],
    ];
    if (hasFile) handlers.push(["seekto", (d) => d.seekTime != null && controlsRef.current.seek(d.seekTime)]);
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // Not every browser knows every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [title, hasFile]);
  useEffect(() => {
    if ("mediaSession" in navigator && state.track) navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  }, [state.track, state.playing]);

  const api = useMemo<PlayerApi>(
    () => ({ ...state, play, toggle, seek, skip, stop, setOpenId }),
    [state, play, toggle, seek, skip, stop, setOpenId]
  );

  return (
    <PlayerContext.Provider value={api}>
      <DockContext.Provider value={addDock}>{children}</DockContext.Provider>
      <MiniPlayer dock={dock} />
    </PlayerContext.Provider>
  );
}

/* ------------------------------- controls ------------------------------- */

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const iconBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-hover hover:text-ink";

/**
 * Play/pause, back/forward, a seek bar and the time — for the loaded track.
 * Used by both the overview modal and the mini player.
 */
export function PlayerControls({ compact = false }: { compact?: boolean }) {
  const p = usePlayer();
  if (!p.track) return null;
  const audio = !!p.track.src;
  const max = audio ? p.length : Math.max(p.track.script.length - 1, 0);
  const value = audio ? p.position : Math.min(p.line ?? p.position, max);
  const step = audio ? 15 : 1;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <button onClick={() => p.skip(-step)} className={iconBtn} title={audio ? "Back 15 seconds" : "Previous line"}>
        <RotateCcw size={13} strokeWidth={2} />
      </button>
      <button
        onClick={p.toggle}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity hover:opacity-90"
        title={p.playing ? "Pause" : "Play"}
        aria-label={p.playing ? "Pause" : "Play"}
      >
        {p.playing ? <Pause size={14} strokeWidth={2.4} /> : <Play size={14} strokeWidth={2.4} className="ml-0.5" />}
      </button>
      <button onClick={() => p.skip(step)} className={iconBtn} title={audio ? "Forward 15 seconds" : "Next line"}>
        <RotateCw size={13} strokeWidth={2} />
      </button>
      <SeekBar className={`mx-1 ${compact ? "h-1" : ""}`} />
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">
        {audio ? `${fmtTime(p.position)} / ${fmtTime(p.length)}` : `Line ${Math.min(value + 1, p.track.script.length)} / ${p.track.script.length}`}
      </span>
    </div>
  );
}

/** Seek slider for the loaded track: seconds (audio) or lines (system voices). */
function SeekBar({ className = "" }: { className?: string }) {
  const p = usePlayer();
  if (!p.track) return null;
  const audio = !!p.track.src;
  const max = audio ? p.length : Math.max(p.track.script.length - 1, 0);
  const value = audio ? p.position : Math.min(p.line ?? p.position, max);
  return (
    <input
      type="range"
      min={0}
      max={max || 1}
      step={audio ? 0.1 : 1}
      value={value}
      onChange={(e) => p.seek(Number(e.target.value))}
      aria-label="Seek"
      className={`min-w-0 flex-1 accent-accent ${className}`}
    />
  );
}

/**
 * Where the mini player docks on a narrow screen. Renders nothing itself; the
 * bar appears inside it while a track is loaded. With no dock mounted (wide
 * screens) the player floats in the corner.
 */
export function MiniPlayerDock({ level = 0, edge = false }: { level?: number; edge?: boolean }) {
  const addDock = useContext(DockContext);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => (el && addDock ? addDock({ el, level, edge }) : undefined), [el, addDock, level, edge]);
  return <div ref={setEl} className="shrink-0" />;
}

/** Shown while a track is loaded and its overview isn't open: docked on narrow screens, floating otherwise. */
function MiniPlayer({ dock }: { dock: Dock | null }) {
  const p = usePlayer();
  if (!p.track || p.openId === p.track.id) return null;
  if (dock) return createPortal(<DockedPlayer edge={dock.edge} />, dock.el);
  return (
    <div
      className="mini-player anim-fade-up fixed bottom-4 right-4 z-[60] w-[min(380px,calc(100vw-2rem))] rounded-2xl border border-edge bg-panel px-3 py-2.5 shadow-2xl"
      role="region"
      aria-label="Audio overview player"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <BrewIcon size={13} strokeWidth={2} animateSteam={p.playing} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={p.track.title}>
          {p.track.title}
        </span>
        {p.line != null && p.track.script[p.line] && (
          <span className="shrink-0 text-[10.5px] text-ink-3">{SPEAKER_LABEL[p.track.script[p.line].speaker]}</span>
        )}
        <button onClick={p.stop} className={iconBtn} title="Stop listening" aria-label="Stop listening">
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>
      <PlayerControls compact />
    </div>
  );
}

/**
 * The phone mini player: a slim bar in the page with big touch targets. The
 * progress line along its top shows how far in you are; tap the title for the
 * seek bar.
 */
function DockedPlayer({ edge }: { edge: boolean }) {
  const p = usePlayer();
  const [seeking, setSeeking] = useState(false);
  if (!p.track) return null;
  const audio = !!p.track.src;
  const total = audio ? p.length : p.track.script.length;
  const done = audio ? p.position : p.line ?? p.position;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const speaker = p.line != null ? p.track.script[p.line]?.speaker : undefined;
  const step = audio ? 15 : 1;
  const btn = "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-2 active:bg-hover";
  return (
    <div
      className={`anim-fade-up relative border-t border-edge-soft bg-panel ${edge ? "safe-bottom" : ""}`}
      role="region"
      aria-label="Audio overview player"
    >
      <div className="absolute inset-x-0 top-0 h-0.5 bg-hover" aria-hidden>
        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-1 py-1.5 pl-3.5 pr-1.5">
        <button
          onClick={() => setSeeking((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={seeking}
          aria-label={seeking ? "Hide the seek bar" : "Show the seek bar"}
        >
          <BrewIcon size={16} strokeWidth={2} animateSteam={p.playing} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-tight text-ink">{p.track.title}</span>
            <span className="block truncate font-mono text-[10.5px] tabular-nums leading-tight text-ink-3">
              {audio
                ? `${fmtTime(p.position)} / ${fmtTime(p.length)}`
                : `Line ${Math.min((p.line ?? p.position) + 1, p.track.script.length)} / ${p.track.script.length}${speaker ? ` · ${SPEAKER_LABEL[speaker]}` : ""}`}
            </span>
          </span>
        </button>
        <button onClick={() => p.skip(-step)} className={btn} aria-label={audio ? "Back 15 seconds" : "Previous line"}>
          <RotateCcw size={17} strokeWidth={2} />
        </button>
        <button
          onClick={p.toggle}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink active:opacity-80"
          aria-label={p.playing ? "Pause" : "Play"}
        >
          {p.playing ? <Pause size={17} strokeWidth={2.4} /> : <Play size={17} strokeWidth={2.4} className="ml-0.5" />}
        </button>
        <button onClick={() => p.skip(step)} className={btn} aria-label={audio ? "Forward 15 seconds" : "Next line"}>
          <RotateCw size={17} strokeWidth={2} />
        </button>
        <button onClick={p.stop} className={btn} aria-label="Stop listening">
          <X size={17} strokeWidth={2.2} />
        </button>
      </div>
      {seeking && (
        <div className="flex px-3.5 pb-2.5">
          <SeekBar />
        </div>
      )}
    </div>
  );
}
