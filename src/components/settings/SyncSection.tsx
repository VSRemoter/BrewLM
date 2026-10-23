/**
 * Settings → Sync: create, unlock and manage the end-to-end encrypted vault
 * (src/lib/sync.ts). Shown only when this build has a sync server configured.
 */
import { Check, Copy, KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  changeSyncPassword,
  getSyncStatus,
  MIN_PASSWORD,
  newSyncRecoveryKey,
  onSyncStatus,
  recoverSync,
  setSyncApiKeys,
  setUpSync,
  signOutOfSync,
  type SyncStatus,
  unlockSync,
} from "../../lib/sync";
import { formatTime } from "../../lib/source";
import { GhostButton, Modal, PrimaryButton } from "../ui";
import { Card, Footnote, Row, SectionTitle, Toggle } from "./controls";

const inputClass =
  "w-full rounded-lg border border-edge bg-panel px-3 py-2 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-ink-3";

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState(getSyncStatus);
  useEffect(() => onSyncStatus(setS), []);
  return s;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** New password + confirmation, checked before `onSubmit` runs. */
function PasswordFields({
  value,
  confirm,
  onChange,
  onConfirm,
  label = "Sync password",
}: {
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirm: (v: string) => void;
  label?: string;
}) {
  return (
    <div className="flex w-72 flex-col gap-2">
      <input
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${label} (${MIN_PASSWORD}+ characters)`}
        className={inputClass}
      />
      <input
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
        placeholder="Type it again"
        className={inputClass}
      />
    </div>
  );
}

function checkNewPassword(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw !== confirm) return "The two passwords don't match.";
  return null;
}

/** Shows a recovery key once, and won't close until the user says they saved it. */
function RecoveryKeyModal({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <Modal title="Save your recovery key" onClose={() => saved && onDone()}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-ink-2">
          If you forget your sync password, this key is the only way back into your synced library. BrewLM can't
          recover it for you. Write it down or keep it in a password manager.
        </p>
        <div className="flex items-center gap-2 rounded-xl border border-edge bg-canvas px-3 py-3">
          <KeyRound size={15} className="shrink-0 text-ink-3" />
          <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px] tracking-wide text-ink">
            {recoveryKey}
          </code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(recoveryKey).then(() => setCopied(true))}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-hover-soft"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I've saved my recovery key somewhere safe
        </label>
        <div className="flex justify-end">
          <PrimaryButton onClick={onDone} disabled={!saved}>
            Done
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}

function SetUpCard() {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = checkNewPassword(pw, confirm);
    if (bad) return setError(bad);
    setBusy(true);
    setError(null);
    try {
      setRecoveryKey(await setUpSync(pw));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={submit}>
        <Card>
          <Row
            label="Create a sync password"
            desc="Your library is encrypted with it before it leaves this computer. You'll enter it once on each new device."
            alignTop
          >
            <PasswordFields value={pw} confirm={confirm} onChange={setPw} onConfirm={setConfirm} />
          </Row>
          <Row label="" alignTop>
            <PrimaryButton type="submit" disabled={busy || !pw}>
              {busy ? "Turning on…" : "Turn on sync"}
            </PrimaryButton>
          </Row>
        </Card>
      </form>
      {error && <Footnote>{error}</Footnote>}
      {recoveryKey && <RecoveryKeyModal recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />}
    </>
  );
}

function UnlockCard() {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [pw, setPw] = useState("");
  const [recovery, setRecovery] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "recovery") {
      const bad = checkNewPassword(newPw, confirm);
      if (bad) return setError(bad);
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "password") await unlockSync(pw);
      else await recoverSync(recovery, newPw);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={submit}>
        <Card>
          {mode === "password" ? (
            <Row label="Enter your sync password" desc="The one you chose when you turned on sync." alignTop>
              <div className="w-72">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="Sync password"
                  className={inputClass}
                />
              </div>
            </Row>
          ) : (
            <>
              <Row label="Recovery key" desc="40 characters, like 7K3QX-…" alignTop>
                <div className="w-72">
                  <input
                    value={recovery}
                    onChange={(e) => setRecovery(e.target.value)}
                    placeholder="XXXXX-XXXXX-XXXXX-…"
                    spellCheck={false}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </Row>
              <Row label="New sync password" desc="Replaces the forgotten one on all your devices." alignTop>
                <PasswordFields
                  value={newPw}
                  confirm={confirm}
                  onChange={setNewPw}
                  onConfirm={setConfirm}
                  label="New password"
                />
              </Row>
            </>
          )}
          <Row label="" alignTop>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "password" ? "recovery" : "password");
                  setError(null);
                }}
                className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              >
                {mode === "password" ? "Forgot it? Use your recovery key" : "Use your password instead"}
              </button>
              <PrimaryButton type="submit" disabled={busy || (mode === "password" ? !pw : !recovery || !newPw)}>
                {busy ? "Unlocking…" : "Unlock"}
              </PrimaryButton>
            </div>
          </Row>
        </Card>
      </form>
      {error && <Footnote>{error}</Footnote>}
    </>
  );
}

function OnCard({ status }: { status: SyncStatus }) {
  const [changing, setChanging] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [confirmNewKey, setConfirmNewKey] = useState(false);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setNote(message(err));
    } finally {
      setBusy(null);
    }
  };

  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    const bad = checkNewPassword(pw, confirm);
    if (bad) return setNote(bad);
    void run("password", async () => {
      await changeSyncPassword(pw);
      setChanging(false);
      setPw("");
      setConfirm("");
      setNote("Sync password changed. Other devices keep syncing; use the new one on your next device.");
    });
  };

  return (
    <>
      <Card>
        <Row
          label="Status"
          desc={
            status.error
              ? `Couldn't sync: ${status.error}`
              : status.lastSyncAt
                ? `Up to date · last synced ${formatTime(status.lastSyncAt)}`
                : "Syncing…"
          }
        >
          <span className={`inline-block h-2 w-2 rounded-full ${status.error ? "bg-danger" : "bg-accent"}`} />
        </Row>
        <Row
          label="Sync API keys"
          desc="Your AI provider keys, encrypted like everything else, so other devices work without re-entering them."
        >
          <Toggle checked={status.syncApiKeys} onChange={(v) => void setSyncApiKeys(v)} label="Sync API keys" />
        </Row>
        <Row label="Sync password" desc="Change it on every device at once." alignTop={changing}>
          {changing ? (
            <form onSubmit={savePassword} className="flex flex-col items-end gap-2">
              <PasswordFields value={pw} confirm={confirm} onChange={setPw} onConfirm={setConfirm} label="New password" />
              <div className="flex gap-2">
                <GhostButton onClick={() => setChanging(false)}>Cancel</GhostButton>
                <PrimaryButton type="submit" disabled={busy === "password" || !pw}>
                  {busy === "password" ? "Saving…" : "Save"}
                </PrimaryButton>
              </div>
            </form>
          ) : (
            <GhostButton onClick={() => setChanging(true)}>Change…</GhostButton>
          )}
        </Row>
        <Row label="Recovery key" desc="Lost it? Make a new one; the old one stops working.">
          <GhostButton onClick={() => setConfirmNewKey(true)} disabled={busy !== null}>
            New recovery key…
          </GhostButton>
        </Row>
        <Row label="Sign out on this computer" desc="Stops syncing here and forgets the key. Your notebooks stay on this computer.">
          <GhostButton onClick={() => void run("signout", signOutOfSync)} disabled={busy !== null}>
            Sign out
          </GhostButton>
        </Row>
      </Card>
      {note && <Footnote>{note}</Footnote>}
      {confirmNewKey && (
        <Modal title="Make a new recovery key?" onClose={() => setConfirmNewKey(false)}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            Your current recovery key will stop working. You'll see the new one once, so have somewhere ready to save it.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setConfirmNewKey(false)}>Cancel</GhostButton>
            <PrimaryButton
              onClick={() => {
                setConfirmNewKey(false);
                void run("recovery", async () => setRecoveryKey(await newSyncRecoveryKey()));
              }}
            >
              Make a new key
            </PrimaryButton>
          </div>
        </Modal>
      )}
      {recoveryKey && <RecoveryKeyModal recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />}
    </>
  );
}

export default function SyncSection() {
  const status = useSyncStatus();
  return (
    <div>
      <SectionTitle
        title="Sync"
        desc="Use BrewLM on your other devices, even when this computer is off. Everything is encrypted on your device first: the sync server only ever stores data it can't read."
      />
      {status.state === "setup" && <SetUpCard />}
      {status.state === "locked" && <UnlockCard />}
      {status.state === "on" && <OnCard status={status} />}
      {status.state !== "on" && status.error && <Footnote>{status.error}</Footnote>}
      <Footnote>
        Your sync password never leaves this device. If you lose both it and your recovery key, the synced copy can't be
        recovered — the notebooks on your devices are unaffected.
      </Footnote>
    </div>
  );
}
