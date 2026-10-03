import Link from "next/link";

export default function Home() {
  return (
    <main className="shell">
      <div className="card">
        <Link href="/" className="brand">
          <img src="/icon.svg" alt="" />
          NodeX
        </Link>
        <h1>Chat privately, stay connected</h1>
        <p className="lead">Talk directly with the people you care about. Your conversations stay yours, always.</p>
        <Link href="/register" className="btn">
          Create your NodeX identity
        </Link>
        <p className="muted-foot">
          Already have a NodeX identity? <Link href="/login">Log in</Link>
        </p>
        <p className="muted-foot">
          <Link href="/privacy">Privacy policy</Link>
        </p>
      </div>
    </main>
  );
}
