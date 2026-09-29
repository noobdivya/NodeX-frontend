"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type RegisteredUser } from "@/lib/api";

const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

type Availability = "idle" | "checking" | "available" | "taken" | "error";

export default function AccountStep({
  email,
  registrationToken,
  onRegistered,
  onSessionExpired,
}: {
  email: string;
  registrationToken: string;
  onRegistered: (user: RegisteredUser) => void;
  onSessionExpired: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [availability, setAvailability] = useState<Availability>("idle");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const usernameValid = USERNAME_RE.test(username);
  const passwordLength = [...password].length;
  const passwordValid = passwordLength >= PASSWORD_MIN && passwordLength <= PASSWORD_MAX && password.trim() !== "";
  const passwordsMatch = password === confirm;

  // Debounced live uniqueness check; the server re-checks on submit.
  useEffect(() => {
    if (!usernameValid) {
      setAvailability("idle");
      return;
    }
    setAvailability("checking");
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await api.usernameAvailable(username, ctrl.signal);
        setAvailability(res.available ? "available" : "taken");
      } catch {
        if (!ctrl.signal.aborted) setAvailability("error");
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [username, usernameValid]);

  const canSubmit = usernameValid && availability !== "taken" && passwordValid && passwordsMatch && !status;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);

    // Loaded on demand so the crypto code stays out of the initial bundle.
    const [{ generatePeerIdentity, signRegistration, exportPrivateKey }, keystore] = await Promise.all([
      import("@/lib/identity"),
      import("@/lib/keystore"),
    ]);

    let savedPeerId: string | null = null;
    try {
      setStatus("Generating your peer identity…");
      const identity = await generatePeerIdentity();
      const signature = await signRegistration(identity, username, registrationToken);

      // Persist the encrypted private key before registering so a successful
      // registration can never leave the user without their key.
      setStatus("Securing your private key on this device…");
      const privateKeyBytes = exportPrivateKey(identity);
      await keystore.saveIdentity({
        peerId: identity.peerId,
        username,
        publicKey: identity.publicKey,
        privateKey: privateKeyBytes,
        password,
      });
      privateKeyBytes.fill(0);
      savedPeerId = identity.peerId;

      setStatus("Creating your account…");
      const { user } = await api.completeRegistration({
        registration_token: registrationToken,
        username,
        password,
        confirm_password: confirm,
        peer_id: identity.peerId,
        public_key: identity.publicKey,
        signature,
      });
      onRegistered(user);
    } catch (err) {
      if (savedPeerId) await keystore.deleteIdentity(savedPeerId).catch(() => {});
      if (err instanceof ApiError) {
        if (err.code === "session_invalid") {
          onSessionExpired();
          return;
        }
        if (err.code === "username_taken") setAvailability("taken");
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      }
      setStatus(null);
    }
  }

  const usernameHint = (() => {
    if (!username) return { text: "3–24 characters: letters, numbers, underscores.", tone: undefined };
    if (!usernameValid) return { text: "Use 3–24 letters, numbers, or underscores.", tone: "error" };
    switch (availability) {
      case "checking":
        return { text: "Checking availability…", tone: undefined };
      case "available":
        return { text: `“${username}” is available.`, tone: "ok" };
      case "taken":
        return { text: `“${username}” is already taken.`, tone: "error" };
      case "error":
        return { text: "Couldn't check availability right now.", tone: undefined };
      default:
        return { text: "", tone: undefined };
    }
  })();

  return (
    <>
      <h1>Choose your identity</h1>
      <p className="lead">
        Email verified: <strong>{email}</strong>
      </p>

      <form onSubmit={submit} noValidate>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            maxLength={24}
            value={username}
            onChange={(e) => setUsername(e.target.value.trim())}
            aria-invalid={(!!username && !usernameValid) || availability === "taken"}
            aria-describedby="username-hint"
          />
          <span id="username-hint" className="hint" data-tone={usernameHint.tone} aria-live="polite">
            {usernameHint.text}
          </span>
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!password && !passwordValid}
            aria-describedby="password-hint"
          />
          <span id="password-hint" className="hint" data-tone={password && !passwordValid ? "error" : undefined}>
            At least {PASSWORD_MIN} characters. It also encrypts your private key on this device.
          </span>
        </div>

        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={!!confirm && !passwordsMatch}
            aria-describedby="confirm-hint"
          />
          {confirm && !passwordsMatch && (
            <span id="confirm-hint" className="hint" data-tone="error">
              Passwords do not match.
            </span>
          )}
        </div>

        <button className="btn" type="submit" disabled={!canSubmit}>
          {status ?? "Create account"}
        </button>
      </form>
    </>
  );
}
