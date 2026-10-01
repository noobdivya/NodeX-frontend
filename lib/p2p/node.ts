// The browser's NodeX P2P node (js-libp2p).
//
// It runs with the user's own identity key, joins the NodeX network through
// the configured nodes (WebSockets), publishes the user's signed handle
// record to the DHT, and looks up other users' handles. Every record is
// re-verified on this device (lib/p2p/record.ts) — nothing is trusted just
// because a node returned it. No central server is involved.
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { bootstrap } from "@libp2p/bootstrap";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { kadDHT, passthroughMapper, type KadDHT } from "@libp2p/kad-dht";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { ping } from "@libp2p/ping";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { normalizeHandle } from "../handle";
import { unlockPrivateKey, type StoredIdentity } from "../keystore";
import { createRecord, recordKey, RECORD_NAMESPACE, selectRecord, validateRecord } from "./record";

const DHT_PROTOCOL = "/nodex/kad/1.0.0";
const REPUBLISH_MS = 6 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 20_000;
const PUBLISH_RETRY_MS = [3_000, 10_000, 30_000, 60_000];

/** Nodes to join the network through (comma-separated multiaddrs). */
export const BOOTSTRAP_PEERS = (process.env.NEXT_PUBLIC_BOOTSTRAP_PEERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Optional STUN servers (comma-separated, e.g. "stun:stun.l.google.com:19302")
 * that help two browsers behind different home routers find a direct path.
 * STUN only tells a browser its public address; it never sees messages.
 * Not needed on the same machine or local network.
 */
const STUN_SERVERS = (process.env.NEXT_PUBLIC_STUN_SERVERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export type NetworkStatus = {
  state: "starting" | "connecting" | "online" | "offline" | "unconfigured";
  peers: number;
  /** True once this user's handle record is in the DHT. */
  published: boolean;
};

export type LookupResult = { handle: string; handleKey: string; peerId: string };

export type Node = Libp2p<{ dht: KadDHT }>;

/** Hooks run on every newly started node (e.g. the chat protocol handler). */
const onStartHooks: Array<(node: Node, identity: StoredIdentity) => void | Promise<void>> = [];
export function onNodeStart(hook: (node: Node, identity: StoredIdentity) => void | Promise<void>) {
  onStartHooks.push(hook);
}

let current: { peerId: string; promise: Promise<Node> } | null = null;
let status: NetworkStatus = { state: "starting", peers: 0, published: false };
const listeners = new Set<(s: NetworkStatus) => void>();
let republishTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(patch: Partial<NetworkStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

export function onStatus(listener: (s: NetworkStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

/**
 * Browsers may only dial the configured nodes (any address), public secure
 * websockets, or other peers *through* a configured node (relay / WebRTC
 * signalling).
 */
function makeGater() {
  const nodes = BOOTSTRAP_PEERS.map((a) => a.replace(/\/p2p\/[^/]+$/, ""));
  const allowed = new Set(nodes);
  return {
    denyDialMultiaddr: (ma: Multiaddr) => {
      const full = ma.toString();
      const s = full.replace(/\/p2p\/[^/]+$/, "");
      if (allowed.has(s)) return false;
      if (full.includes("/p2p-circuit") && nodes.some((n) => full.startsWith(n + "/p2p/"))) return false;
      return !/\/(wss|tls(\/sni\/[^/]+)?\/ws)(\/|$)/.test(s);
    },
  };
}

/**
 * Addresses to reach another browser: via a NodeX node's relay, upgraded to a
 * direct WebRTC connection (the relay only carries the WebRTC handshake).
 */
export function peerAddresses(peerId: string): { webrtc: string[]; relayed: string[] } {
  return {
    webrtc: BOOTSTRAP_PEERS.map((b) => `${b}/p2p-circuit/webrtc/p2p/${peerId}`),
    relayed: BOOTSTRAP_PEERS.map((b) => `${b}/p2p-circuit/p2p/${peerId}`),
  };
}

/**
 * Opens a protocol stream to another browser: reuses an existing connection,
 * else connects via WebRTC (relay carries only the handshake), else falls
 * back to a relayed connection. Always end-to-end encrypted.
 */
export async function openPeerStream(node: Node, peerId: string, protocol: string, timeoutMs = 20_000) {
  const pid = peerIdFromString(peerId);
  if (node.getConnections(pid).length > 0) {
    return node.dialProtocol(pid, protocol, { runOnLimitedConnection: true, signal: AbortSignal.timeout(timeoutMs) });
  }
  const addrs = peerAddresses(peerId);
  try {
    return await node.dialProtocol(
      addrs.webrtc.map((a) => multiaddr(a)),
      protocol,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    return node.dialProtocol(
      addrs.relayed.map((a) => multiaddr(a)),
      protocol,
      { runOnLimitedConnection: true, signal: AbortSignal.timeout(timeoutMs) },
    );
  }
}

/** The running node, if any. */
export function getNode(): Promise<Node> | null {
  return current?.promise ?? null;
}

/** Starts (or returns) the P2P node for this identity. */
export function startNetwork(identity: StoredIdentity): Promise<Node> {
  if (current?.peerId === identity.peerId) return current.promise;
  if (BOOTSTRAP_PEERS.length === 0) {
    setStatus({ state: "unconfigured" });
    return Promise.reject(new Error("No NodeX network nodes are configured (NEXT_PUBLIC_BOOTSTRAP_PEERS)."));
  }
  const promise = (async () => {
    setStatus({ state: "starting", peers: 0, published: false });
    const keyBytes = await unlockPrivateKey(identity);
    const privateKey = privateKeyFromProtobuf(keyBytes);
    keyBytes.fill(0);

    const node = await createLibp2p({
      privateKey,
      // Reserve a slot on a NodeX node's relay and accept WebRTC, so other
      // browsers can reach this one.
      addresses: { listen: ["/p2p-circuit", "/webrtc"] },
      transports: [
        webSockets(),
        webRTC({ rtcConfiguration: { iceServers: STUN_SERVERS.map((urls) => ({ urls })) } }),
        circuitRelayTransport(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: makeGater(),
      peerDiscovery: [bootstrap({ list: BOOTSTRAP_PEERS })],
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT({
          protocol: DHT_PROTOCOL,
          clientMode: true,
          peerInfoMapper: passthroughMapper,
          validators: {
            [RECORD_NAMESPACE]: async (key, value) => {
              await validateRecord(key, value);
            },
          },
          selectors: { [RECORD_NAMESPACE]: selectRecord },
        }),
      },
    });

    // "Online" means connected to at least one NodeX network node.
    const nodeIds = new Set(BOOTSTRAP_PEERS.map((a) => a.split("/p2p/").pop()));
    const updatePeers = () => {
      const peers = node.getPeers().filter((p) => nodeIds.has(p.toString())).length;
      setStatus({ peers, state: peers > 0 ? "online" : "connecting" });
    };
    node.addEventListener("peer:connect", updatePeers);
    node.addEventListener("peer:disconnect", updatePeers);
    setStatus({ state: "connecting" });
    updatePeers();

    for (const hook of onStartHooks) await hook(node, identity);
    void publishLoop(node, identity, privateKey, 0);
    return node;
  })();
  current = { peerId: identity.peerId, promise };
  promise.catch(() => {
    setStatus({ state: "offline" });
    if (current?.promise === promise) current = null;
  });
  return promise;
}

/** Publishes this user's handle record, retrying until a node stores it, then republishes periodically. */
async function publishLoop(
  node: Node,
  identity: StoredIdentity,
  privateKey: Parameters<typeof createRecord>[0]["privateKey"],
  attempt: number,
) {
  if (current?.peerId !== identity.peerId || node.status !== "started") return;
  let stored = 0;
  try {
    if (node.getPeers().length > 0) {
      const value = await createRecord({
        handle: identity.handle,
        peerId: identity.peerId,
        emailCommitment: identity.emailCommitment,
        privateKey,
      });
      for await (const ev of node.services.dht.put(recordKey(identity.handle), value, {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      })) {
        // put() first runs a closest-peers query; only PUT_VALUE replies mean a node stored the record.
        if (ev.name === "PEER_RESPONSE" && ev.messageName === "PUT_VALUE") stored++;
      }
    }
  } catch {
    // fall through to retry
  }
  if (stored > 0) {
    setStatus({ published: true });
    republishTimer = setTimeout(() => publishLoop(node, identity, privateKey, 0), REPUBLISH_MS);
  } else {
    const wait = PUBLISH_RETRY_MS[Math.min(attempt, PUBLISH_RETRY_MS.length - 1)];
    republishTimer = setTimeout(() => publishLoop(node, identity, privateKey, attempt + 1), wait);
  }
}

/**
 * Finds a user by handle (case-insensitive) in the DHT. The record is
 * verified on this device. Returns null if nobody has published that handle.
 */
export async function lookupHandle(identity: StoredIdentity, handle: string): Promise<LookupResult | null> {
  const handleKey = normalizeHandle(handle);
  if (!handleKey) throw new Error("Enter a full handle, like Rahul#7K3M9X.");
  const node = await startNetwork(identity);
  if (node.getPeers().length === 0) {
    throw new Error("Not connected to the NodeX network yet. Try again in a moment.");
  }

  const key = recordKey(handle);
  const values: Uint8Array[] = [];
  try {
    for await (const ev of node.services.dht.get(key, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })) {
      if (ev.name === "VALUE") values.push(ev.value);
    }
  } catch {
    // "not found" or timeout; decide below based on what arrived
  }
  if (values.length === 0) return null;

  // Re-verify locally: never trust a record just because a peer served it.
  const best = await selectRecord(key, values).catch(() => -1);
  if (best < 0) return null;
  const record = await validateRecord(key, values[best]);
  return { handle: record.handle, handleKey, peerId: record.peer_id };
}

/** Stops the node (on logout). */
export async function stopNetwork(): Promise<void> {
  clearTimeout(republishTimer);
  const prev = current;
  current = null;
  setStatus({ state: "starting", peers: 0, published: false });
  if (prev) {
    const node = await prev.promise.catch(() => null);
    await node?.stop();
  }
}
