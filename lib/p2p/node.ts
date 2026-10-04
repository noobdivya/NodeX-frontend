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
import type { Connection, Libp2p, PeerId } from "@libp2p/interface";
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
import { isBlocked } from "./blocklist";
import { createRecord, recordKey, RECORD_NAMESPACE, selectRecord, validateRecord } from "./record";

const DHT_PROTOCOL = "/nodex/kad/1.0.0";
const REPUBLISH_MS = 6 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 20_000;
const PUBLISH_RETRY_MS = [3_000, 10_000, 30_000, 60_000];
/** Waits between attempts to reach a NodeX node while disconnected. */
const CONNECT_RETRY_MS = [3_000, 5_000, 10_000, 20_000, 30_000];
/** Long enough for a sleeping hosted node to wake up and answer. */
const CONNECT_TIMEOUT_MS = 75_000;
/** How often to check the connection is still there. */
const CONNECTED_CHECK_MS = 30_000;
/** How long a background attempt at a direct browser-to-browser connection may take. */
const DIRECT_TIMEOUT_MS = 20_000;
/** After a failed direct attempt, wait this long before trying that peer again. */
const DIRECT_RETRY_MS = 60_000;

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
    // Blocked people can't connect to this device, and it doesn't connect to them.
    denyDialPeer: (peerId: PeerId) => isBlocked(peerId.toString()),
    denyInboundEncryptedConnection: (peerId: PeerId) => isBlocked(peerId.toString()),
    denyInboundUpgradedConnection: (peerId: PeerId) => isBlocked(peerId.toString()),
    denyOutboundUpgradedConnection: (peerId: PeerId) => isBlocked(peerId.toString()),
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

/** The open connection to use for a peer: a direct one if there is one, else a relayed one. */
function bestConnection(node: Node, peerId: string): Connection | undefined {
  const open = node.getConnections(peerIdFromString(peerId)).filter((c) => c.status === "open");
  return open.find((c) => c.limits == null) ?? open[0];
}

/** Peers a direct connection is being tried for, and when the last try failed. */
const upgrading = new Set<string>();
const upgradeFailedAt = new Map<string, number>();

/**
 * Tries, in the background, to add a direct WebRTC connection to a peer
 * reached through the relay. Nothing waits for it: between different
 * networks it often can't be established, and the relay keeps working.
 */
function upgradeToDirect(node: Node, peerId: string) {
  if (upgrading.has(peerId) || Date.now() - (upgradeFailedAt.get(peerId) ?? 0) < DIRECT_RETRY_MS) return;
  upgrading.add(peerId);
  node
    .dial(
      peerAddresses(peerId).webrtc.map((a) => multiaddr(a)),
      { signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) },
    )
    .then(
      () => upgradeFailedAt.delete(peerId),
      () => upgradeFailedAt.set(peerId, Date.now()),
    )
    .finally(() => upgrading.delete(peerId));
}

/**
 * Connects to another browser. The relay is used first because it connects
 * within a second or two; a direct WebRTC connection is then set up in the
 * background and takes over once it's ready. Always end-to-end encrypted.
 */
export async function connectPeer(node: Node, peerId: string, timeoutMs = 20_000): Promise<Connection> {
  const connection =
    bestConnection(node, peerId) ??
    (await node.dial(
      peerAddresses(peerId).relayed.map((a) => multiaddr(a)),
      { signal: AbortSignal.timeout(timeoutMs) },
    ));
  if (connection.limits != null) upgradeToDirect(node, peerId);
  return connection;
}

/**
 * Opens a protocol stream to another browser, on the existing connection if
 * there is one. (libp2p's own dialProtocol ignores relayed connections and
 * would dial again for every stream, so the connection is picked here.)
 */
export async function openPeerStream(node: Node, peerId: string, protocol: string, timeoutMs = 20_000) {
  const connection = await connectPeer(node, peerId, timeoutMs);
  return connection.newStream(protocol, { runOnLimitedConnection: true, signal: AbortSignal.timeout(timeoutMs) });
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
    let lastPeers = 0;
    let everConnected = false;
    const updatePeers = () => {
      const peers = node.getPeers().filter((p) => nodeIds.has(p.toString())).length;
      if (peers === 0) {
        // Whatever we published may be gone by the time we're back.
        setStatus({ peers, state: "connecting", published: false });
      } else {
        setStatus({ peers, state: "online" });
        // Back after losing every node: a node that restarted (or woke from
        // sleep) has lost the handle records it held in memory, so publish again.
        if (lastPeers === 0 && everConnected) {
          clearTimeout(republishTimer);
          void publishLoop(node, identity, privateKey, 0);
        }
        everConnected = true;
      }
      lastPeers = peers;
    };
    node.addEventListener("peer:connect", updatePeers);
    node.addEventListener("peer:disconnect", updatePeers);
    setStatus({ state: "connecting" });
    updatePeers();

    for (const hook of onStartHooks) await hook(node, identity);
    keepConnected(node, nodeIds);
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

/**
 * Stays connected to the NodeX network nodes. The first connection can fail
 * (a hosted node may take a minute to wake up) and connections can drop (a
 * node restarts), so keep retrying, quickly at first, and check regularly.
 */
function keepConnected(node: Node, nodeIds: Set<string | undefined>) {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connected = () => node.getPeers().some((p) => nodeIds.has(p.toString()));
  const tick = async () => {
    if (node.status !== "started") return;
    if (!connected()) {
      setStatus({ state: "connecting" });
      try {
        await Promise.any(
          BOOTSTRAP_PEERS.map((a) => node.dial(multiaddr(a), { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })),
        );
        attempt = 0;
      } catch {
        attempt++;
      }
    }
    if (node.status !== "started") return;
    const wait = connected() ? CONNECTED_CHECK_MS : CONNECT_RETRY_MS[Math.min(attempt, CONNECT_RETRY_MS.length - 1)];
    timer = setTimeout(() => void tick(), wait);
  };
  // Give the built-in first dial a moment before checking.
  timer = setTimeout(() => void tick(), CONNECT_RETRY_MS[0]);
  node.addEventListener("stop", () => clearTimeout(timer), { once: true });
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
  try {
    for await (const ev of node.services.dht.get(key, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })) {
      if (ev.name !== "VALUE") continue;
      // Re-verify locally: never trust a record just because a peer served it.
      // The first record that passes is enough, so don't wait for the rest of
      // the query (which can take many seconds asking unreachable peers).
      const record = await validateRecord(key, ev.value).catch(() => null);
      if (record) return { handle: record.handle, handleKey, peerId: record.peer_id };
    }
  } catch {
    // "not found" or timeout
  }
  return null;
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
