"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

export default function EmailStep({
  notice,
  onSent,
}: {
  notice?: string;
  onSent: (email: string, resendIn: number) => void;
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
      const res = await api.requestOtp(value);
      onSent(value, res.resend_in_seconds);
    } catch (err) {
      // A code was sent moments ago; let the user enter it rather than block them.
      if (err instanceof ApiError && err.code === "otp_cooldown") {
        onSent(value, err.retryAfter ?? 60);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>Create your account</h1>
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
