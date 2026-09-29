import type { RegisteredUser } from "@/lib/api";

export default function IdentityCreated({ user }: { user: RegisteredUser }) {
  return (
    <>
      <h1>Account created successfully</h1>
      <p className="lead">Welcome to NodeX, {user.username}.</p>
    </>
  );
}
