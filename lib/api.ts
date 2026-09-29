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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the NodeX server. Check your connection and try again.");
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

const post = <T>(path: string, data: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(data) });

export type RegisteredUser = {
  id: string;
  email: string;
  username: string;
  peer_id: string;
  created_at: string;
};

export const api = {
  requestOtp: (email: string) =>
    post<{ message: string; expires_in_seconds: number; resend_in_seconds: number }>("/api/v1/auth/register/otp", {
      email,
    }),

  verifyOtp: (email: string, otp: string) =>
    post<{ registration_token: string; expires_at: string }>("/api/v1/auth/register/verify", { email, otp }),

  usernameAvailable: (username: string, signal?: AbortSignal) =>
    request<{ username: string; available: boolean }>(
      `/api/v1/users/username-available?username=${encodeURIComponent(username)}`,
      { signal },
    ),

  completeRegistration: (data: {
    registration_token: string;
    username: string;
    password: string;
    confirm_password: string;
    peer_id: string;
    public_key: string;
    signature: string;
  }) => post<{ user: RegisteredUser }>("/api/v1/auth/register/complete", data),
};
