import { getVersion } from "@tauri-apps/api/app";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Settings } from "../../lib/types";
import { checkForUpdate, type UpdateInfo } from "../../lib/updates";
import { GhostButton } from "../ui";
import { Card, Row, SectionTitle, Toggle } from "./controls";

export default function AboutSection({
  settings,
  patch,
  updateInfo,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  updateInfo: UpdateInfo | null;
}) {
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(updateInfo);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  const check = async () => {
    setChecking(true);
    setChecked(false);
    const info = await checkForUpdate();
    setResult(info);
    setChecking(false);
    setChecked(true);
  };

  return (
    <div>
      <SectionTitle title="About & Updates" />

      <Card>
        <Row label="BrewLM" desc="Your personal research copilot — local-first, no account, no telemetry.">
          <span className="font-mono text-[12.5px] text-ink-2">v{version || "…"}</span>
        </Row>
        <Row
          label="Check for updates on launch"
          desc="One anonymous request to GitHub Releases; compares version numbers only."
        >
          <Toggle
            label="Check for updates on launch"
            checked={settings.updateCheckOnLaunch}
            onChange={(v) => patch({ updateCheckOnLaunch: v })}
          />
        </Row>
        <Row label="Update status">
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-ink-3">
              {checking
                ? "Checking…"
                : !checked && !result
                  ? "Not checked yet"
                  : !result
                    ? "Couldn't check — offline?"
                    : result.isNewer
                      ? `v${result.latest} available (you have v${result.current})`
                      : `Up to date (v${result.current})`}
            </span>
            {result?.isNewer && (
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[12.5px] text-link hover:underline"
              >
                Download <ExternalLink size={11} />
              </a>
            )}
            <GhostButton onClick={() => void check()} disabled={checking}>
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw size={12} /> Check now
              </span>
            </GhostButton>
          </div>
        </Row>
      </Card>

      <SectionTitle title="Links" />
      <Card>
        {[
          { label: "GitHub repository", href: "https://github.com/VSRemoter/BrewLM" },
          { label: "Releases & installers", href: "https://github.com/VSRemoter/BrewLM/releases" },
          { label: "Apache License 2.0", href: "https://github.com/VSRemoter/BrewLM/blob/main/LICENSE" },
        ].map((l) => (
          <Row key={l.href} label={l.label}>
            <a
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[12.5px] text-link hover:underline"
            >
              Open <ExternalLink size={11} />
            </a>
          </Row>
        ))}
      </Card>
    </div>
  );
}
