/**
 * Settings → Sync: sign in, plan and storage, then create, unlock and manage
 * the end-to-end encrypted vault (src/lib/sync.ts). Shown only when this build
 * has a sync server configured.
 */
import { Check, Copy, KeyRound } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState, type FormEvent } from "react";
import {
  type AccountInfo,
  cancelDeviceLink,
  cancelSignIn,
  changeSyncPassword,
  type DeviceLink,
  deviceLinkPending,
  getSyncStatus,
  linkThisDevice,
  MIN_PASSWORD,
  newSyncRecoveryKey,
  onSyncStatus,
  openBillingPortal,
  openCheckout,
  recoverSync,
  setSyncApiKeys,
  setUpSync,
  type SignIn,
  signOutOfSync,
  startDeviceLink,
  startSignIn,
  type SyncStatus,
  unlockSync,
  waitForSignIn,
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

/**
 * A one-time code for a new device: QR to scan (phones) or text to type. It
 * works once, for 10 minutes; closing this cancels it unless it was used.
 */
function AddDeviceModal({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<DeviceLink | null>(null);
  const [state, setState] = useState<"waiting" | "linked" | "expired">("waiting");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let made: DeviceLink | null = null;
    let done = false;
    let closed = false;
    startDeviceLink()
      .then((l) => {
        if (closed) return void cancelDeviceLink(l.id); // closed before it arrived
        made = l;
        setLink(l);
      })
      .catch((e) => setError(message(e)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      if (!made || done) return;
      const l = made;
      void deviceLinkPending(l.id)
        .then((pending) => {
          if (pending || done) return;
          done = true;
          setState(Date.now() >= l.expiresAt ? "expired" : "linked");
        })
        .catch(() => {});
    }, 2000);
    return () => {
      closed = true;
      clearInterval(tick);
      clearInterval(poll);
      if (made && !done) void cancelDeviceLink(made.id);
    };
  }, []);

  const left = link ? Math.max(0, link.expiresAt - now) : 0;
  const expired = state === "expired" || (link !== null && left === 0 && state === "waiting");
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <Modal title="Add a device" onClose={onClose}>
      <div className="flex flex-col items-center gap-4">
        {error ? (
          <p className="text-[13px] text-danger">{error}</p>
        ) : !link ? (
          <span className="my-10 inline-block h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
        ) : state === "linked" ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink">
              <Check size={20} strokeWidth={2.5} />
            </span>
            <p className="text-[14px] font-medium text-ink">Device linked</p>
            <p className="text-[12.5px] text-ink-3">It's downloading your library now.</p>
          </div>
        ) : expired ? (
          <p className="py-6 text-[13px] text-ink-2">This code expired. Close this and make a new one.</p>
        ) : (
          <>
            <p className="text-center text-[13px] leading-relaxed text-ink-2">
              On the new device, open Settings → Sync and choose “Use a code from your other device”. Scan this, or
              type the code below. It works once, for the next {clock}.
            </p>
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={link.uri} size={180} />
            </div>
            <div className="flex w-full items-center gap-2 rounded-xl border border-edge bg-canvas px-3 py-2.5">
              <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px] tracking-wide text-ink">
                {link.code}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(link.code).then(() => setCopied(true))}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-hover-soft"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
              Anyone with this code can join your library, so only show it to your own devices.
            </p>
          </>
        )}
        <div className="flex w-full justify-end">
          <GhostButton onClick={onClose}>{state === "linked" ? "Done" : "Cancel"}</GhostButton>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------- account -------------------------------- */

function SignInCard() {
  const [email, setEmail] = useState("");
  const [attempt, setAttempt] = useState<SignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => cancelSignIn(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await startSignIn(email);
      setAttempt(a);
      if (!(await waitForSignIn(a))) {
        setAttempt(null);
        setError("That sign-in link expired. Send a new one.");
      }
    } catch (err) {
      setAttempt(null);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={submit}>
        <Card>
          {attempt ? (
            <Row
              label="Check your email"
              desc={`We sent a sign-in link to ${email}. Open it, check the page shows this code, and press “Yes, sign in”.`}
              alignTop
            >
              <div className="flex w-72 flex-col items-end gap-2">
                <span className="font-mono text-[26px] font-bold tracking-[0.3em] text-ink">{attempt.code}</span>
                <span className="flex items-center gap-2 text-[12px] text-ink-3">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
                  Waiting for you to confirm…
                </span>
                <button
                  type="button"
                  onClick={() => {
                    cancelSignIn();
                    setAttempt(null);
                  }}
                  className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                >
                  Use a different email
                </button>
              </div>
            </Row>
          ) : (
            <>
              <Row
                label="Sign in"
                desc="Free for 14 days, no card needed. We'll email you a link — no password for your account."
                alignTop
              >
                <div className="w-72">
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className={inputClass}
                  />
                </div>
              </Row>
              <Row label="" alignTop>
                <PrimaryButton type="submit" disabled={busy || !email.includes("@")}>
                  {busy ? "Sending…" : "Email me a sign-in link"}
                </PrimaryButton>
              </Row>
            </>
          )}
        </Card>
      </form>
      {error && <Footnote>{error}</Footnote>}
    </>
  );
}

const PLAN_LABEL: Record<AccountInfo["plan"], string> = {
  trial: "Free trial",
  sync: "Sync",
  plus: "Sync Plus",
  none: "No plan",
};

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function planLine(a: AccountInfo): string {
  if (a.plan === "trial") {
    const days = Math.max(0, Math.ceil((a.trialEndsAt - Date.now()) / 86_400_000));
    return `Free trial · ${days} day${days === 1 ? "" : "s"} left`;
  }
  if (a.plan === "none") return "Your free trial has ended";
  const end = a.periodEnd ? ` · ${a.cancelAtPeriodEnd ? "ends" : "renews"} ${day(a.periodEnd)}` : "";
  return `${PLAN_LABEL[a.plan]}${end}`;
}

/** Plans as sold (Polar's checkout shows the final price, with any tax). */
const PLANS = [
  { id: "sync" as const, name: "Sync", storage: "10 GB", month: "$5 / month", year: "$48 / year ($4 / month)" },
  { id: "plus" as const, name: "Sync Plus", storage: "100 GB", month: "$10 / month", year: "$96 / year ($8 / month)" },
];

function PlanModal({ onClose }: { onClose: () => void }) {
  const [interval, setBilling] = useState<"year" | "month">("year");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (plan: "sync" | "plus") => {
    setBusy(plan);
    setError(null);
    try {
      await openCheckout(plan, interval);
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title="Choose a plan" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-1 self-start rounded-full border border-edge p-0.5 text-[12.5px]">
          {(["year", "month"] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setBilling(i)}
              className={`rounded-full px-3 py-1 ${interval === i ? "bg-hover font-medium text-ink" : "text-ink-3"}`}
            >
              {i === "year" ? "Yearly — save 20%" : "Monthly"}
            </button>
          ))}
        </div>
        {PLANS.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-4 rounded-xl border border-edge px-4 py-3">
            <div>
              <div className="text-[14px] font-semibold text-ink">{p.name}</div>
              <div className="text-[12.5px] text-ink-3">
                {p.storage} · {interval === "year" ? p.year : p.month}
              </div>
            </div>
            <PrimaryButton onClick={() => void choose(p.id)} disabled={busy !== null}>
              {busy === p.id ? "Opening…" : "Choose"}
            </PrimaryButton>
          </div>
        ))}
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          Checkout opens in your browser (payments by Polar, our reseller, who handles tax). Your plan updates here
          within a minute of paying.
        </p>
        {error && <p className="text-[12px] text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

function AccountCard({ account }: { account: AccountInfo }) {
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = Math.min(1, account.usedBytes / Math.max(1, account.limitBytes));
  const paid = account.plan === "sync" || account.plan === "plus";
  return (
    <>
      <Card>
        <Row label={account.email} desc={planLine(account)}>
          {paid ? (
            <GhostButton onClick={() => void openBillingPortal().catch((e) => setError(message(e)))}>
              Manage billing…
            </GhostButton>
          ) : (
            <PrimaryButton onClick={() => setChoosing(true)}>Choose a plan…</PrimaryButton>
          )}
        </Row>
        <Row label="Storage" desc={`${formatBytes(account.usedBytes)} of ${formatBytes(account.limitBytes)} used`}>
          <div className="h-2 w-44 overflow-hidden rounded-full bg-edge">
            <div
              className={`h-full rounded-full ${used > 0.9 ? "bg-danger" : "bg-accent"}`}
              style={{ width: `${Math.max(2, used * 100)}%` }}
            />
          </div>
        </Row>
      </Card>
      {!account.canSync && (
        <Footnote>
          Sync is paused: this computer still downloads changes from your other devices, but won't upload until you
          choose a plan.
        </Footnote>
      )}
      {error && <Footnote>{error}</Footnote>}
      {choosing && <PlanModal onClose={() => setChoosing(false)} />}
    </>
  );
}

/* ---------------------------------- vault --------------------------------- */

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
  const [mode, setMode] = useState<"password" | "recovery" | "link">("password");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
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
      else if (mode === "link") await linkThisDevice(code);
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
          {mode === "link" ? (
            <Row
              label="Code from your other device"
              desc="On a device that's already syncing: Settings → Sync → Add a device."
              alignTop
            >
              <div className="w-72">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-…"
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                />
              </div>
            </Row>
          ) : mode === "password" ? (
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
            <div className="flex flex-col items-end gap-2">
              <PrimaryButton
                type="submit"
                disabled={busy || (mode === "password" ? !pw : mode === "link" ? !code : !recovery || !newPw)}
              >
                {busy ? "Unlocking…" : mode === "link" ? "Link this device" : "Unlock"}
              </PrimaryButton>
              <div className="flex gap-3">
                {(["password", "link", "recovery"] as const)
                  .filter((m) => m !== mode)
                  .map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMode(m);
                        setError(null);
                      }}
                      className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                    >
                      {m === "password"
                        ? "Use your password"
                        : m === "link"
                          ? "Use a code from your other device"
                          : "Forgot it? Use your recovery key"}
                    </button>
                  ))}
              </div>
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
  const [adding, setAdding] = useState(false);

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
        <Row label="Add a device" desc="Show a one-time code to scan or type on your new device, instead of your password.">
          <GhostButton onClick={() => setAdding(true)}>Add a device…</GhostButton>
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
        <Row
          label="Sign out on this computer"
          desc={`Stops syncing here and forgets the key${status.account ? ", and signs this computer out of your account" : ""}. Your notebooks stay on this computer.`}
        >
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
      {adding && <AddDeviceModal onClose={() => setAdding(false)} />}
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
      {status.state === "signed-out" && <SignInCard />}
      {status.account && <AccountCard account={status.account} />}
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
