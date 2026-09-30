"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import EmailStep from "./EmailStep";
import OtpStep from "./OtpStep";
import NameStep from "./NameStep";
import RecoveryPhraseStep from "./RecoveryPhraseStep";
import IdentityStep from "./IdentityStep";

type State =
  | { step: "email"; notice?: string }
  | { step: "otp"; email: string; otpToken: string; resendIn: number }
  | { step: "name"; email: string }
  | { step: "phrase"; handle: string; recoveryPhrase: string }
  | { step: "identity"; handle: string };

const ORDER = ["email", "otp", "name", "phrase", "identity"] as const;

export default function RegisterFlow() {
  const router = useRouter();
  const [state, setState] = useState<State>({ step: "email" });
  const current = ORDER.indexOf(state.step);

  // Someone already has an identity on this device.
  useEffect(() => {
    import("@/lib/keystore").then(({ getIdentity }) =>
      getIdentity().then((id) => {
        if (id && state.step === "email") router.replace("/home");
      }),
    );
    // Only on first load; later steps create the identity themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          onSent={(email, sent) =>
            setState({ step: "otp", email, otpToken: sent.otp_token, resendIn: sent.resend_in_seconds })
          }
        />
      )}
      {state.step === "otp" && (
        <OtpStep
          email={state.email}
          initialResendIn={state.resendIn}
          verify={async (otp) => {
            await api.verifyOtp(state.otpToken, otp);
            setState({ step: "name", email: state.email });
          }}
          resend={async () => {
            const sent = await api.sendOtp(state.email);
            setState({ ...state, otpToken: sent.otp_token });
            return sent;
          }}
          onChangeEmail={() => setState({ step: "email" })}
        />
      )}
      {state.step === "name" && (
        <NameStep
          email={state.email}
          onCreated={(identity, recoveryPhrase) =>
            setState({ step: "phrase", handle: identity.handle, recoveryPhrase })
          }
        />
      )}
      {state.step === "phrase" && (
        <RecoveryPhraseStep
          phrase={state.recoveryPhrase}
          onConfirmed={() => setState({ step: "identity", handle: state.handle })}
        />
      )}
      {state.step === "identity" && <IdentityStep handle={state.handle} />}

      {state.step === "email" && (
        <p className="muted-foot">
          Already have a NodeX identity? <Link href="/login">Log in</Link>
        </p>
      )}
    </div>
  );
}
