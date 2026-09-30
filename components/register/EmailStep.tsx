"use client";

import { useState } from "react";
import { api, ApiError, type OtpSent } from "@/lib/api";

export default function EmailStep({
  notice,
  onSent,
}: {
  notice?: string;
  onSent: (email: string, sent: OtpSent) => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    setError(null);
    setLoading(true);
    try {
      onSent(value, await api.sendOtp(value));
    } catch (err) {
      if (err instanceof ApiError && err.code === "otp_cooldown") {
        setError(`A code was just sent. You can request another in ${err.retryAfter ?? 60} seconds.`);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>Create your NodeX identity</h1>
      <p className="lead">We&apos;ll send a 6-digit code to verify your email.</p>

      <form onSubmit={submit} noValidate>
        {notice && (
          <div className="alert" data-tone="info" role="status">
            {notice}
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "email-error" : undefined}
            placeholder="you@example.com"
          />
          {error && (
            <span id="email-error" className="hint" data-tone="error" role="alert">
              {error}
            </span>
          )}
        </div>
        <button className="btn" type="submit" disabled={loading || !email.trim()}>
          {loading ? "Sending code…" : "Send verification code"}
        </button>
      </form>
    </>
  );
}
