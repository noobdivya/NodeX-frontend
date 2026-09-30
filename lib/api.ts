// The only network calls NodeX makes to a server: the stateless email
// verifier used during registration (send code, check code). It stores
// nothing; identities, contacts, chat and profiles never go to a server.

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

async function post<T>(path: string, data: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the NodeX email verifier. Check your connection and try again.");
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const retry = Number(res.headers.get("Retry-After"));
    throw new ApiError(
      res.status,
      body?.error?.code ?? "unknown_error",
      body?.error?.message ?? "Something went wrong. Please try again.",
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  return body as T;
}

export type OtpSent = { otp_token: string; expires_in_seconds: number; resend_in_seconds: number };

export const api = {
  sendOtp: (email: string) => post<OtpSent>("/api/v1/otp/send", { email }),

  verifyOtp: (otpToken: string, otp: string) =>
    post<{ verified: true }>("/api/v1/otp/verify", { otp_token: otpToken, otp }),
};
