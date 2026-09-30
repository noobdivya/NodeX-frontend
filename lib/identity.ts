// NodeX cryptographic identity, derived entirely on the user's device.
//
//   12-word phrase ──BIP39──► Ed25519 key ──► Peer ID
//   email + Peer ID ──PBKDF2──► email commitment   (email itself never leaves the device)
//   display name + Peer ID + commitment ──PBKDF2──► 6-char tag
//   handle = "<DisplayName>#<TAG>"   e.g. "Rahul#7K3M9X"
//
// Handles are case-insensitive: they are compared via their canonical
// lowercase form (handleKey, e.g. "rahul#7k3m9x"), never as typed.
//
// The phrase recreates the same key, so the same handle can be re-derived
// and checked during recovery without any server. The tag binds the handle
// to the key (and email), so it can't be claimed by another key without
// brute-forcing a deliberately slow hash.
import {
  generateKeyPairFromSeed,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyToProtobuf,
} from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { fromBase64, toBase64 } from "./encoding";
import { DISPLAY_NAME_RE, handlesEqual, parseHandle, TAG_ALPHABET, TAG_LENGTH } from "./handle";

export { DISPLAY_NAME_RE, handlesEqual, normalizeHandle, parseHandle } from "./handle";

// BIP39 passphrase, used as a domain separator so a NodeX phrase never
// yields the same key as the same words used in another app.
const SEED_DOMAIN = "nodex-identity-v1";

const EMAIL_ITERATIONS = 200_000;
const TAG_ITERATIONS = 600_000;

export type PeerIdentity = {
  peerId: string;
  /** libp2p protobuf-encoded public key, base64. Safe to share. */
  publicKey: string;
  privateKey: Ed25519PrivateKey;
};

export type NodeXIdentity = PeerIdentity & {
  /** The handle as displayed, e.g. "Rahul#Z7NJR2". */
  handle: string;
  /** Canonical lowercase form used for every comparison, e.g. "rahul#z7njr2". */
  handleKey: string;
  /** base64 of the 32-byte email commitment. */
  emailCommitment: string;
};

export class IdentityError extends Error {
  constructor(
    public code: "phrase_invalid" | "handle_invalid" | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

/** Normalises user input: lowercase, single spaces. */
export function normalizeRecoveryPhrase(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(normalizeRecoveryPhrase(phrase), wordlist);
}

/** Deterministically recreates the Ed25519 key pair and Peer ID from a recovery phrase. */
export async function identityFromRecoveryPhrase(phrase: string): Promise<PeerIdentity> {
  const seed = await mnemonicToSeed(normalizeRecoveryPhrase(phrase), SEED_DOMAIN);
  const privateKey = await generateKeyPairFromSeed("Ed25519", seed.slice(0, 32));
  seed.fill(0);
  return {
    peerId: peerIdFromPrivateKey(privateKey).toString(),
    publicKey: toBase64(publicKeyToProtobuf(privateKey.publicKey)),
    privateKey,
  };
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return new Uint8Array(bits);
}

/** Slow salted hash of the email, bound to the Peer ID. The email itself is never shared. */
export async function emailCommitment(email: string, peerId: string): Promise<string> {
  const salt = new TextEncoder().encode(`nodex-email-v1|${peerId}`);
  return toBase64(await pbkdf2(email.trim().toLowerCase(), salt, EMAIL_ITERATIONS));
}

/** The 6-character tag for a display name, Peer ID and email commitment. */
export async function handleTag(displayName: string, peerId: string, commitmentB64: string): Promise<string> {
  const peer = new TextEncoder().encode(peerId);
  const commitment = fromBase64(commitmentB64);
  const salt = new Uint8Array(peer.length + commitment.length);
  salt.set(peer);
  salt.set(commitment, peer.length);

  const digest = await pbkdf2(`nodex-handle-v1|${displayName.toLowerCase()}`, salt, TAG_ITERATIONS);
  // Take 5 bits per character from the start of the digest.
  let bits = 0;
  let value = 0;
  let tag = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && tag.length < TAG_LENGTH) {
      tag += TAG_ALPHABET[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (tag.length === TAG_LENGTH) break;
  }
  return tag;
}

/** Creates a brand-new identity for a display name and verified email. */
export async function createIdentity(
  displayName: string,
  email: string,
): Promise<NodeXIdentity & { recoveryPhrase: string }> {
  const name = displayName.trim();
  if (!DISPLAY_NAME_RE.test(name)) {
    throw new IdentityError("handle_invalid", "Use 2–20 letters, numbers, or underscores.");
  }
  const recoveryPhrase = generateMnemonic(wordlist, 128);
  const identity = await identityFromRecoveryPhrase(recoveryPhrase);
  const commitment = await emailCommitment(email, identity.peerId);
  const tag = await handleTag(name, identity.peerId, commitment);
  const handle = `${name}#${tag}`;
  return { ...identity, handle, handleKey: handle.toLowerCase(), emailCommitment: commitment, recoveryPhrase };
}

/**
 * Restores an existing identity. The phrase recreates the key; the email and
 * handle must re-derive to exactly the handle entered, otherwise nothing is
 * restored. No new identity is ever generated here.
 */
export async function restoreIdentity(input: {
  email: string;
  handle: string;
  phrase: string;
}): Promise<NodeXIdentity> {
  const parsed = parseHandle(input.handle);
  if (!parsed) {
    throw new IdentityError("handle_invalid", "Enter your full handle, like Rahul#7K3M9X.");
  }
  if (!isValidRecoveryPhrase(input.phrase)) {
    throw new IdentityError("phrase_invalid", "That isn't a valid recovery phrase. Check each word and its order.");
  }
  const identity = await identityFromRecoveryPhrase(input.phrase);
  const commitment = await emailCommitment(input.email, identity.peerId);
  // The tag hash lowercases the name, so any capitalisation re-derives the same tag.
  const tag = await handleTag(parsed.name, identity.peerId, commitment);
  const derived = `${parsed.name}#${tag}`;
  if (!handlesEqual(derived, input.handle)) {
    throw new IdentityError(
      "mismatch",
      "The email, handle and recovery phrase don't match the same account. Check all three and try again.",
    );
  }
  return { ...identity, handle: derived, handleKey: parsed.key, emailCommitment: commitment };
}

export function exportPrivateKey(identity: PeerIdentity): Uint8Array {
  return privateKeyToProtobuf(identity.privateKey);
}

/** The Peer ID a protobuf-encoded private key belongs to, or null if it isn't a valid key. */
export function peerIdOfPrivateKey(privateKey: Uint8Array): string | null {
  try {
    return peerIdFromPrivateKey(privateKeyFromProtobuf(privateKey)).toString();
  } catch {
    return null;
  }
}
