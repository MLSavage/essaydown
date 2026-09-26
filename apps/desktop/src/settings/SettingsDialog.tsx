import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@essaydown/core";
import { credentialStoreMessage, loadSettings, saveSettings, type SettingsIO } from "./settings-sync";

export type SettingsDialogProps = {
  io: SettingsIO;
  onClose: () => void;
};

/**
 * The minimal settings dialog (task 2.7's description: opened with Cmd/Ctrl+,, wired in App.tsx).
 * `theme` has exactly one value (PRD §3: "No themes or theme switcher") so there is nothing to show
 * for it; the one control is `typewriterScroll`. When the OS credential store is not available,
 * the status line names it — but this dialog renders no coach configuration at all (no provider,
 * base URL, model or key field): "Does NOT render any coach UI" (acceptance).
 */
export default function SettingsDialog({ io, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [credentialMessage, setCredentialMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [loadedSettings, hasKey] = await Promise.all([loadSettings(io), io.hasCoachKey()]);
      if (cancelled) return;
      setSettings(loadedSettings);
      setCredentialMessage(credentialStoreMessage(hasKey.backend));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [io]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggleTypewriterScroll = (): void => {
    const next: Settings = { ...settings, typewriterScroll: !settings.typewriterScroll };
    setSettings(next);
    void saveSettings(io, next);
  };

  return (
    <div className="settings-overlay" data-testid="settings-dialog">
      <div className="settings-dialog">
        <h2>Settings</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            data-testid="typewriter-scroll-toggle"
            data-loaded={loaded}
            checked={settings.typewriterScroll}
            onChange={toggleTypewriterScroll}
          />
          Typewriter scrolling
        </label>
        {credentialMessage !== null && (
          <p className="settings-credential-status" data-testid="credential-status">
            {credentialMessage}
          </p>
        )}
        <div className="settings-buttons">
          <button type="button" data-testid="settings-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
