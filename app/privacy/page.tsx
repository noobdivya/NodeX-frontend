import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What NodeX stores, where, and what it never collects.",
};

const CONTACT = "divya85870@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="shell">
      <article className="card card-wide policy">
        <Link href="/" className="brand">
          <img src="/icon.svg" alt="" />
          NodeX
        </Link>
        <h1>Privacy policy</h1>
        <p className="lead">Last updated: 3 October 2026</p>

        <p>
          NodeX is a peer-to-peer chat app. It is built so that your account, contacts and messages stay on your own
          device. This page explains what that means in practice.
        </p>

        <h2>The short version</h2>
        <ul>
          <li>We have no user database and no accounts on any server.</li>
          <li>Your messages, photos, files and contacts are never sent to or stored on a NodeX server.</li>
          <li>Your email address is used once, to send you a sign-up code, and is not stored.</li>
          <li>We don&apos;t use cookies for tracking, analytics or advertising, and we don&apos;t sell or share data.</li>
        </ul>

        <h2>What stays on your device</h2>
        <p>
          Your identity key (encrypted with a key that can&apos;t leave your browser), your handle, contacts, messages,
          photos, files, profile photo and settings are stored in your browser&apos;s storage on your device. Logging out
          removes your identity from that device. Your 12-word recovery phrase is shown to you once and is never stored
          or sent anywhere.
        </p>

        <h2>Messages and files</h2>
        <p>
          Messages, photos, videos and documents travel directly between your device and the other person&apos;s, end-to-end
          encrypted. When two devices can&apos;t connect directly, a NodeX network node relays the encrypted data without
          being able to read it, and doesn&apos;t keep it. Read messages are deleted from both devices 48 hours after
          they&apos;re read.
        </p>

        <h2>Your email address</h2>
        <p>
          When you sign up, your email address is sent to the NodeX email verifier so it can email you a 6-digit code.
          The verifier keeps no record of it beyond the few minutes the code is valid (to limit repeated requests). Your
          device keeps only a slow, salted hash of your email, which is also part of your public handle record (below).
        </p>

        <h2>Your public handle record</h2>
        <p>
          So that people can find you, your device publishes a signed record to the NodeX peer-to-peer network: your
          handle (for example <code>Rahul#7K3M9X</code>), your public key identifier, and the salted hash of your email.
          Network nodes keep it in memory for up to 48 hours and anyone who knows your exact handle can look it up. It
          contains no messages, contacts or your email address itself.
        </p>

        <h2>Your profile photo</h2>
        <p>
          If you add one, it is sent directly from your device to other people&apos;s devices: to everyone who finds or
          chats with you, or only to your saved contacts, as you choose in your profile.
        </p>

        <h2>Google (Gmail)</h2>
        <p>
          Sign-up codes are sent from NodeX&apos;s own Gmail account using the Gmail API, with permission only to send
          email. NodeX never asks for access to your Google account and doesn&apos;t receive, read or store any data from
          it. NodeX&apos;s use of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>

        <h2>Hosting providers</h2>
        <p>
          The website is hosted on Vercel, and the email verifier and a network node on Render. Like any web host, they
          may briefly log technical data such as IP addresses to operate and protect their services. If your device
          uses a STUN server to find a direct connection, that server sees your IP address, but never your messages.
        </p>

        <h2>Notifications</h2>
        <p>
          If you turn them on, notifications are created by your own browser when a message arrives. No push service
          or server is involved.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>Delete messages for yourself or for everyone, and block people, inside the app.</li>
          <li>Log out to remove your identity and data from a device; clearing your browser data removes it too.</li>
          <li>Stop using NodeX and your public handle record disappears from the network within 48 hours.</li>
        </ul>

        <h2>Children</h2>
        <p>NodeX is not directed at children under 13.</p>

        <h2>Changes and contact</h2>
        <p>
          If this policy changes, the new version will be posted on this page with a new date. Questions:{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>

        <p className="muted-foot">
          <Link href="/">Back to NodeX</Link>
        </p>
      </article>
    </main>
  );
}
