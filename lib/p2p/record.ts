// Handle records published in the NodeX DHT.
//
// Key:   "/nodex/" + handleKey            e.g. "/nodex/rahul#bftrjn"
// Value: JSON {v, handle, peer_id, email_commitment, seq, sig}
//
// Accepted only if stored under its own (case-insensitive) handle key,
// signed by the Ed25519 key inside its Peer ID, and the handle's tag
// re-derives from (name, Peer ID, email commitment). Every peer checks this
// locally, so a result can be trusted without trusting whoever served it.
//
// Must stay byte-for-byte compatible with record.go in the NodeX-backend repository (p2p-node/).
import type { PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { fromBase64, toBase64 } from "../encoding";
import { parseHandle } from "../handle";
import { handleTag } from "../identity";

export const RECORD_NAMESPACE = "nodex";
const KEY_PREFIX = `/${RECORD_NAMESPACE}/`;
const MAX_RECORD_BYTES = 2048;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

export type HandleRecord = {
  v: 1;
  handle: string;
  peer_id: string;
  email_commitment: string;
  seq: number;
  sig: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** DHT key for a handle, using its canonical (lowercase) form. */
export function recordKey(handle: string): Uint8Array {
  const parsed = parseHandle(handle);
  if (!parsed) throw new Error("Invalid handle.");
  return enc.encode(KEY_PREFIX + parsed.key);
}

function signedMessage(handleKey: string, peerId: string, commitment: string, seq: number): Uint8Array {
  return enc.encode(`nodex-handle-record-v1\n${handleKey}\n${peerId}\n${commitment}\n${seq}`);
}

/** Builds and signs this user's record. */
export async function createRecord(params: {
  handle: string;
  peerId: string;
  emailCommitment: string;
  privateKey: PrivateKey;
}): Promise<Uint8Array> {
  const parsed = parseHandle(params.handle);
  if (!parsed) throw new Error("Invalid handle.");
  const seq = Date.now();
  const sig = await params.privateKey.sign(signedMessage(parsed.key, params.peerId, params.emailCommitment, seq));
  const record: HandleRecord = {
    v: 1,
    handle: params.handle,
    peer_id: params.peerId,
    email_commitment: params.emailCommitment,
    seq,
    sig: toBase64(sig),
  };
  return enc.encode(JSON.stringify(record));
}

const ALLOWED_FIELDS = new Set(["v", "handle", "peer_id", "email_commitment", "seq", "sig"]);

/** Throws unless the record is valid for this key. */
export async function validateRecord(key: Uint8Array, value: Uint8Array): Promise<HandleRecord> {
  if (value.length > MAX_RECORD_BYTES) throw new Error("record too large");
  let r: HandleRecord;
  try {
    r = JSON.parse(dec.decode(value));
  } catch {
    throw new Error("bad record json");
  }
  if (typeof r !== "object" || r === null || Object.keys(r).some((k) => !ALLOWED_FIELDS.has(k))) {
    throw new Error("bad record fields");
  }
  if (r.v !== 1) throw new Error("unsupported record version");

  const parsed = typeof r.handle === "string" ? parseHandle(r.handle) : null;
  if (!parsed) throw new Error("invalid handle");
  if (dec.decode(key) !== KEY_PREFIX + parsed.key) throw new Error("record stored under the wrong key");

  let peer;
  try {
    peer = peerIdFromString(r.peer_id);
  } catch {
    throw new Error("invalid peer id");
  }
  if (peer.type !== "Ed25519" || !peer.publicKey) throw new Error("peer id must embed an Ed25519 key");

  let commitment: Uint8Array;
  try {
    commitment = fromBase64(r.email_commitment);
  } catch {
    throw new Error("invalid email commitment");
  }
  if (commitment.length !== 32) throw new Error("invalid email commitment");
  if (!Number.isSafeInteger(r.seq) || r.seq <= 0 || r.seq > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error("invalid sequence number");
  }

  let sig: Uint8Array;
  try {
    sig = fromBase64(r.sig);
  } catch {
    throw new Error("invalid signature encoding");
  }
  const ok = await peer.publicKey.verify(signedMessage(parsed.key, r.peer_id, r.email_commitment, r.seq), sig);
  if (!ok) throw new Error("bad signature");

  const tag = await handleTag(parsed.name, r.peer_id, r.email_commitment);
  if (tag !== parsed.tag) throw new Error("handle is not bound to this peer id");
  return r;
}

/** Index of the newest valid record (highest seq). */
export async function selectRecord(key: Uint8Array, records: Uint8Array[]): Promise<number> {
  let best = -1;
  let bestSeq = -1;
  for (let i = 0; i < records.length; i++) {
    try {
      const r = await validateRecord(key, records[i]);
      if (r.seq > bestSeq) {
        best = i;
        bestSeq = r.seq;
      }
    } catch {
      // skip invalid
    }
  }
  if (best < 0) throw new Error("no valid record");
  return best;
}
