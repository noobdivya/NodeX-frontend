<p align="center">
  <img src="app/icon.svg" alt="NodeX logo" width="88" height="88">
</p>

<h1 align="center">NodeX — Frontend</h1>

<p align="center">
  <strong>A decentralized, peer-to-peer chat app that runs in your browser.</strong><br>
  Your identity lives on your device, not on a server.
</p>

<p align="center">
  <img alt="Status" src="https://img.shields.io/badge/status-in%20development-orange">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js%2016%20%2B%20TypeScript-black">
  <img alt="P2P" src="https://img.shields.io/badge/P2P-libp2p-2dd4bf">
</p>

<p align="center">
  <a href="https://node-x-frontend-red.vercel.app"><strong>▶ Try NodeX: node-x-frontend-red.vercel.app</strong></a>
</p>

| Live | Address |
|---|---|
| **App** (Vercel) | <https://node-x-frontend-red.vercel.app> |
| Email verifier (Render) | <https://nodex-verifier.onrender.com> |
| P2P node (Render) | `/dns4/nodex-node.onrender.com/tcp/443/wss/p2p/12D3KooWPXJbYpESjgy7rxyTgS6szXv373DHJBjidVRbzgSRAfr3` |

> The backend runs on Render's free plan, so after a quiet spell the first visit can take about a minute while it wakes up; the app connects by itself once it does. To try chat, open the app in a normal and a private window, create two identities, and search for one from the other by its handle.

This repository is the **NodeX web app** (Next.js). It needs two small services from the **[NodeX-backend](https://github.com/noobdivya/NodeX-backend)** repository: a **P2P node** that browsers join the network through, and an **email verifier** used once at sign-up.

---

## What is NodeX?

NodeX is a messaging app built on a simple principle: **no central server owns your account.**

- **Your identity is created on your device:** a cryptographic key pair with a handle like **`Rahul#7K3M9X`**.
- **Your private key never leaves your device.** A 12-word recovery phrase restores it, and that phrase is never stored.
- **Logging in and recovery happen on your device**, with zero network requests.
- **Finding people is peer-to-peer:** handles are published, signed, into a distributed hash table (DHT), and every result is verified on your device.
- **Chat is direct and end-to-end encrypted:** messages go straight from browser to browser over WebRTC. No server stores or forwards them.
- **Contacts, messages and photos stay on your device.**
- **The only server** is a tiny email verifier used once at sign-up. It has no database and stores no users.

---

## Features

| | Feature | Details |
|---|---|---|
| ✅ | **Email verification** | A 6-digit code sent to your email during sign-up |
| ✅ | **Cryptographic identity** | Ed25519 key pair and libp2p Peer ID, generated on your device |
| ✅ | **Handle** | `DisplayName#TAG`, e.g. `Rahul#7K3M9X`, case-insensitive. It's your only username. |
| ✅ | **12-word recovery phrase** | BIP39; restores the exact same identity on any device |
| ✅ | **Passwordless local login** | Email + handle + recovery phrase, checked on your device |
| ✅ | **Secure key storage** | Private key encrypted with a non-exportable browser key |
| ✅ | **Find people by handle (P2P)** | Signed records in a libp2p DHT, verified on your device |
| ✅ | **Real-time P2P chat** | Browser to browser over WebRTC, end-to-end encrypted |
| ✅ | **Ticks and read receipts** | 🕓 waiting · ✓ delivered · ✓✓ read; unread counts |
| ✅ | **Offline queue** | Messages to an offline friend wait on your device and go out when they're back |
| ✅ | **Disappearing messages** | Deleted from both devices 48 hours after being read |
| ✅ | **Photos, videos, documents** | Photos compressed on device; files up to 50 MB with progress, cancel and resume |
| ✅ | **Emoji picker** | Built in; emoji-only messages shown large |
| ✅ | **Reply, forward, edit, delete** | Quote replies, forward to another chat, edit your messages, delete for me / for everyone |
| ✅ | **Typing indicator and last seen** | "typing…" and "last seen today at 11:05", from your own device's connections |
| ✅ | **Profile photo (P2P)** | Shared device to device; visible to everyone or "My contacts only" |
| ✅ | **Notifications** | While NodeX is open in the background; unread count in the tab title |
| ✅ | **Block a user** | Your device refuses their connections and requests; they aren't told |

---

## How it works

### Your identity

Everything below runs in your browser:

```
12-word recovery phrase ──BIP39──►  Ed25519 private key ──► Peer ID (12D3KooW…)
        email + Peer ID ──PBKDF2 (200k)──► email commitment
display name + Peer ID + commitment ──PBKDF2 (600k)──► 6-character tag

handle  =  DisplayName # TAG          →   Rahul#7K3M9X
```

- **The same 12 words always recreate the same key and Peer ID**, which is what makes recovery possible without a server.
- **The tag is tied to your key and email**, so nobody can produce your handle without brute-forcing a deliberately slow hash.
- **Tags use unambiguous characters** (`0-9 A-Z` without `I L O U`); `I`/`L` are read as `1` and `O` as `0`.

### Finding people

```
You (browser) ──publish signed record──►  NodeX DHT  ◄──lookup "rahul#7k3m9x"── Someone else (browser)
```

1. **Publish:** your browser publishes a **handle record** signed with your key (`key = /nodex/<lowercase handle>`, `value = { handle, peer_id, email_commitment, seq, sig }`), and republishes it every 6 hours while the app is open.
2. **Search:** type a full handle in any capitalisation; your browser asks the DHT.
3. **Verify on your device:** the signature must match the key in its Peer ID, it must be stored under its own handle, and the tag must re-derive from that Peer ID.

Search is by **exact handle** (a DHT can't do partial search) and sends no HTTP requests.

### Chat

```
Asha's browser ──WebRTC (direct, encrypted)──► Bob's browser
        │                                         │
        └──── handshake only, via a NodeX node ───┘
```

- **Connecting:** the NodeX node relays only the WebRTC handshake; then the connection is direct. If no direct path is found, the node's relay carries it, still end-to-end encrypted.
- **Protocols** (length-prefixed JSON frames over libp2p streams):

| Protocol | Used for |
|---|---|
| `/nodex/chat/1.0.0` | Messages, photos (60 KB chunks), acks, read receipts, typing, edits, deletions |
| `/nodex/file/1.0.0` | Videos and documents: the receiver pulls the bytes, with resume and SHA-256 check |
| `/nodex/profile/1.0.0` | Profile photos: fetch and live updates |

- **Who sent it:** connections are authenticated with the sender's key, so their Peer ID is proven; the handle is checked against your contacts or the DHT.
- **Only the author can edit or delete** a message, and read receipts are accepted only from the person a message was sent to.
- **Storage:** IndexedDB on the two devices only.

> **Both people need the app open at the same time** for a message to move. There's no server to hold messages for offline users.

### Sign up, log in, log out

- **Sign up:** email → 6-digit code → display name → identity created on device → save 12 words → see your handle.
- **Log in / recover:** email + handle + 12 words. Your device recreates the key and re-derives the handle; if anything doesn't match, nothing is restored. No request is sent anywhere.
- **Log out** removes the identity from the device.

---

## Privacy: what is stored where

| Data | Where it lives | Sent to a server? |
|---|---|---|
| 12-word recovery phrase | Only with you (written down) | ❌ Never |
| Private key | Your device, encrypted with a non-exportable device key | ❌ Never |
| Email | Not stored; the verifier sees it only to send the code | Only during sign-up |
| Handle record | The P2P network's DHT, so others can find you | Public by design |
| Contacts, messages, block list | Your device | ❌ Never |
| Profile photo | Your device, and devices of people allowed to see it | ❌ Never |

> The email commitment in your public handle record is a **slow, salted hash** of your email, needed so anyone can check your handle belongs to your key. Someone who already suspects your exact email could test that guess, so treat your handle as linked to your email.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- The **[NodeX-backend](https://github.com/noobdivya/NodeX-backend)** services running (P2P node and email verifier); see that repository's README.

### Run locally

```bash
git clone https://github.com/noobdivya/NodeX-frontend.git
cd NodeX-frontend
cp .env.example .env.local     # paste the P2P node address into it
npm install
npm run dev
```

Open **http://localhost:3000** and create your identity. The home screen shows *Online · discoverable on the NodeX network* once your handle is published. To try chat, create a second identity in a private/InPrivate window and look it up by its handle.

### Configuration (`.env.local`)

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | Address of the email verifier |
| `NEXT_PUBLIC_BOOTSTRAP_PEERS` | – | P2P node address(es) to join the network through, as printed by the node (comma-separated) |
| `NEXT_PUBLIC_STUN_SERVERS` | – | Optional STUN servers (e.g. `stun:stun.l.google.com:19302`) so browsers on different networks can connect directly. STUN never sees messages. |

---

## Deploying on Vercel

1. Deploy the backend first (see the NodeX-backend README) and copy the node's `NEXT_PUBLIC_BOOTSTRAP_PEERS` value from its logs.
2. **Vercel → Add New → Project**, import this repository (framework: Next.js, root directory: the repository root).
3. Add the environment variables:
   - `NEXT_PUBLIC_BOOTSTRAP_PEERS` = the node's `/dns4/…/tcp/443/wss/p2p/…` address
   - `NEXT_PUBLIC_API_URL` = the verifier's address, e.g. `https://nodex-verifier.onrender.com`
4. **Deploy**, then set the verifier's `CORS_ORIGINS` to your Vercel address.

Every page is static, so the app is served from Vercel's CDN; all networking happens in the browser.

---

## Project structure

```
app/                       Pages: /, /register, /login, /home
components/
├── register/              Email → code → name → phrase → identity
├── login/                 Log in / recover
└── home/                  Chat list, chat screen, search, profile, menu
lib/
├── identity.ts            Keys, recovery phrase, handle derivation
├── handle.ts              Handle parsing, case-insensitive comparison
├── keystore.ts            Encrypted identity vault (IndexedDB)
├── contacts.ts            Local contacts, last seen, block flag
├── messages.ts            Local message storage (IndexedDB)
├── profile.ts             Profile photos and photo privacy
├── image.ts               Photo crop, resize and compression
├── notifications.ts       Background notifications
├── api.ts                 Email verifier calls
└── p2p/
    ├── node.ts            Browser libp2p node: join, publish, look up, WebRTC
    ├── record.ts          Create/validate handle records (mirrors the node's record.go)
    ├── chat.ts            Chat protocol: messages, acks, receipts, edits, deletes, typing
    ├── file-transfer.ts   Video/document transfer with resume
    ├── profile-share.ts   Profile photo sharing
    └── blocklist.ts       Blocked people, enforced on this device
```

### Tech stack

| Layer | Technology |
|---|---|
| App | Next.js 16, React 19, TypeScript |
| Cryptography | `@libp2p/crypto`, `@libp2p/peer-id`, `@scure/bip39`, Web Crypto (PBKDF2, AES-GCM, SHA-256) |
| P2P | `libp2p`, `@libp2p/kad-dht`, `@libp2p/websockets`, `@libp2p/webrtc`, `@libp2p/circuit-relay-v2`, Noise, Yamux |
| Storage | IndexedDB |

---

## Testing

End-to-end tests run in real browsers (Playwright, two or three users at once) against a local P2P node. They cover sign-up, recovery and case-insensitive login; P2P search including a forged record being rejected; real-time chat over a confirmed direct WebRTC connection; offline delivery; read receipts and disappearing messages; photos, videos and documents arriving byte-for-byte identical (including cancel and resume); reply, forward, edit and delete; last seen, typing, notifications, blocking and photo privacy; and that none of this makes HTTP requests to any server.

```bash
npx tsc --noEmit     # type-check
npm run build        # production build
```

---

## Security notes

- **Keep your 12 words safe.** With them plus your email and handle, anyone can restore your identity. Lose them and your device, and the identity can't be recovered.
- **No password:** anyone with access to your unlocked browser profile is logged in.
- **Handle tags are 6 characters.** The tag hash is deliberately slow, but a very determined attacker could in principle find a different key with a matching handle. Contacts you've added are tied to the real Peer ID.
- **Disappearing messages, "delete for everyone" and edits rely on the other device's NodeX app.** A modified app or a screenshot can keep a message.
- **"Last seen" is what your own device observed**, not a global status.
- **Notifications need NodeX open**; a closed browser can't be notified without a push server.
- **Blocking is enforced by your device**; a blocked person can still look up your public handle.
- **Across different networks**, browsers may need STUN for a direct path; otherwise chat goes through the node's relay (encrypted, but time- and size-limited).

---

## Roadmap

- [x] Identity, recovery phrase, local login
- [x] P2P search, real-time chat, receipts, disappearing messages
- [x] Photos, videos, documents, emoji
- [x] Reply, forward, edit, delete, last seen, typing
- [x] Notifications, blocking, photo privacy
- [ ] Group chats
- [ ] Voice messages, voice and video calls
- [ ] Use one account on several devices

## Contributing

Issues and pull requests are welcome. Please open an issue first to discuss larger changes.

## License

No license has been chosen yet. Until one is added, all rights are reserved by the author.
