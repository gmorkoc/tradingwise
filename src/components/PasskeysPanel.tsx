import { useEffect, useState } from "react";
import { addPasskey, listPasskeys, removePasskey, passkeysAvailable, PASSKEY_CANCELLED, type PasskeyItem } from "../services/passkeys";

// Profile → Security: manage passkeys (Face ID / Touch ID sign-in).
// Passkeys are an extra way in — password, magic link, Google and Apple
// all keep working alongside them.
export function PasskeysPanel() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [items, setItems] = useState<PasskeyItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const refresh = () => listPasskeys().then(setItems);

  useEffect(() => {
    passkeysAvailable().then((ok) => {
      setSupported(ok);
      if (ok) refresh();
    });
  }, []);

  const handleAdd = async () => {
    setBusy(true); setError(""); setInfo("");
    const err = await addPasskey();
    setBusy(false);
    if (err === PASSKEY_CANCELLED) return;
    if (err) { setError(err); return; }
    setInfo("Passkey added. Next time you can sign in with Face ID or Touch ID.");
    refresh();
  };

  const handleRemove = async (id: string) => {
    setError(""); setInfo("");
    const err = await removePasskey(id);
    if (err) setError(err);
    else refresh();
  };

  if (supported === false) return null;

  return (
    <div className="pp-passkeys">
      <h4 className="pp-passkeys-title">Passkeys</h4>
      <p className="pp-pane-sub">
        Sign in with Face ID, Touch ID or your device PIN instead of a password. Your password keeps working too.
      </p>

      {items.length > 0 && (
        <ul className="pp-passkeys-list">
          {items.map((p) => (
            <li key={p.id} className="pp-passkeys-item">
              <span className="pp-passkeys-name">{p.friendly_name || "Passkey"}</span>
              <span className="pp-passkeys-date">Added {new Date(p.created_at).toLocaleDateString()}</span>
              <button type="button" className="pp-passkeys-remove" onClick={() => handleRemove(p.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="pp-msg pp-msg--error">{error}</p>}
      {info && <p className="pp-msg pp-msg--success">{info}</p>}

      <div className="pp-actions">
        <button className="pp-btn pp-btn--primary" onClick={handleAdd} disabled={busy}>
          {busy ? "Waiting for Face ID…" : items.length ? "Add another passkey" : "Add a passkey"}
        </button>
      </div>
    </div>
  );
}
