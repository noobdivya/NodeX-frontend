import { generateKeyPair, privateKeyToProtobuf, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { toBase64 } from "./encoding";

export type PeerIdentity = {
  peerId: string;
  /** libp2p protobuf-encoded public key, base64. Safe to share. */
  publicKey: string;
  privateKey: Ed25519PrivateKey;
};

/** Generates a libp2p Ed25519 key pair and its Peer ID entirely on this device. */
export async function generatePeerIdentity(): Promise<PeerIdentity> {
  const privateKey = await generateKeyPair("Ed25519");
  const peerId = peerIdFromPrivateKey(privateKey).toString();
  return {
    peerId,
    publicKey: toBase64(publicKeyToProtobuf(privateKey.publicKey)),
    privateKey,
  };
}

/** Must match identity.RegistrationMessage in the Go backend byte-for-byte. */
export function registrationMessage(username: string, peerId: string, sessionToken: string): string {
  return `NodeX identity registration v1\nusername:${username}\npeer_id:${peerId}\nsession:${sessionToken}`;
}

/** Signs the registration message to prove possession of the private key. */
export async function signRegistration(identity: PeerIdentity, username: string, sessionToken: string) {
  const msg = new TextEncoder().encode(registrationMessage(username, identity.peerId, sessionToken));
  return toBase64(await identity.privateKey.sign(msg));
}

export function exportPrivateKey(identity: PeerIdentity): Uint8Array {
  return privateKeyToProtobuf(identity.privateKey);
}
