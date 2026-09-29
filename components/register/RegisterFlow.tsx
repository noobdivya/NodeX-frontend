"use client";

import Link from "next/link";
import { useState } from "react";
import type { RegisteredUser } from "@/lib/api";
import EmailStep from "./EmailStep";
import OtpStep from "./OtpStep";
import AccountStep from "./AccountStep";
import IdentityCreated from "./IdentityCreated";

type State =
  | { step: "email"; notice?: string }
  | { step: "otp"; email: string; resendIn: number }
  | { step: "account"; email: string; token: string }
  | { step: "done"; user: RegisteredUser };

const ORDER = ["email", "otp", "account", "done"] as const;

export default function RegisterFlow() {
  const [state, setState] = useState<State>({ step: "email" });
  const current = ORDER.indexOf(state.step);

  return (
    <div className="card">
      <Link href="/" className="brand">
        <img src="/icon.svg" alt="" />
        NodeX
      </Link>

      <div className="steps" aria-label={`Step ${current + 1} of ${ORDER.length}`}>
        {ORDER.map((s, i) => (
          <span key={s} data-active={i <= current} />
        ))}
      </div>

      {state.step === "email" && (
        <EmailStep
          notice={state.notice}
          onSent={(email, resendIn) => setState({ step: "otp", email, resendIn })}
        />
      )}
      {state.step === "otp" && (
        <OtpStep
          email={state.email}
          initialResendIn={state.resendIn}
          onVerified={(token) => setState({ step: "account", email: state.email, token })}
          onChangeEmail={() => setState({ step: "email" })}
        />
      )}
      {state.step === "account" && (
        <AccountStep
          email={state.email}
          registrationToken={state.token}
          onRegistered={(user) => setState({ step: "done", user })}
          onSessionExpired={() =>
            setState({ step: "email", notice: "Your verification expired. Please verify your email again." })
          }
        />
      )}
      {state.step === "done" && <IdentityCreated user={state.user} />}
    </div>
  );
}
