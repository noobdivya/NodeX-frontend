import type { Metadata } from "next";
import RegisterFlow from "@/components/register/RegisterFlow";

export const metadata: Metadata = {
  title: "Create account",
};

export default function RegisterPage() {
  return (
    <main className="shell">
      <RegisterFlow />
    </main>
  );
}
