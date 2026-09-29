"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

export default function OtpStep({
  email,
  initialResendIn,
  onVerified,
  onChangeEmail,
}: {
  email: string;
  initialResendIn: number;
  onVerified: (registrationToken: string) => void;
  onChangeEmail: () => void;
}) {
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendIn, setResendIn] = useState(initialResendIn);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await api.verifyOtp(email, otp);
      onVerified(res.registration_token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setOtp("");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      const res = await api.requestOtp(email);
      setResendIn(res.resend_in_seconds);
      setInfo("A new code is on its way.");
    } catch (err) {
      if (err instanceof ApiError && err.retryAfter) setResendIn(err.retryAfter);
      setError(err instanceof ApiError ? err.message : "Couldn't resend the code.");
    } finally {
      setResending(false);
    }
  }

  return (
    <>
      <h1>Check your email</h1>
      <p className="lead">
        Enter the 6-digit code sent to <strong>{email}</strong>. It expires in 10 minutes.
      </p>

      <form onSubmit={submit} noValidate>
        {info && (
          <div className="alert" data-tone="info" role="status">
            {info}
          </div>
        )}
        <div className="field">
          <label htmlFor="otp">Verification code</label>
          <input
            id="otp"
            className="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            aria-invalid={!!error}
            aria-describedby={error ? "otp-error" : undefined}
            placeholder="••••••"
          />
          {error && (
            <span id="otp-error" className="hint" data-tone="error" role="alert">
              {error}
            </span>
          )}
        </div>
        <button className="btn" type="submit" disabled={loading || otp.length !== 6}>
          {loading ? "Verifying…" : "Verify email"}
        </button>
        <div className="row">
          <button type="button" className="link-btn" onClick={onChangeEmail}>
            Use a different email
          </button>
          <button type="button" className="link-btn" onClick={resend} disabled={resendIn > 0 || resending}>
            {resendIn > 0 ? `Resend in ${resendIn}s` : resending ? "Sending…" : "Resend code"}
          </button>
        </div>
      </form>
    </>
  );
}
