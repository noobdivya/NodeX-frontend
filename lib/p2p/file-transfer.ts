// Videos and documents, transferred directly between two browsers.
//
// A file message (sent over /nodex/chat/1.0.0) carries only the file's
// description: name, type, size and SHA-256. The receiver then *pulls* the
// bytes from the sender's device over this protocol:
//
//   /nodex/file/1.0.0 — one stream per download attempt
//     receiver → { t: "get", id: <message uuid>, offset }
//     sender   → { t: "file", size, hash }  then the bytes from `offset`, in chunks
//                | { t: "gone" }             (message deleted / not for you)
//
// The sender serves a file only to the peer the message was sent to. If a
// transfer breaks, the next attempt continues from the bytes already
// received. The complete file must match the announced size and SHA-256
// before it is saved. Nothing passes through or is stored on a server.
import type { Connection, Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";
import type { StoredIdentity } from "../keystore";
import { AUTO_DOWNLOAD_BYTES, getMessage, MAX_FILE_BYTES, saveMessage, type ChatMessage } from "../messages";
import { sha256Hex } from "../profile";
import { isBlocked } from "./blocklist";
import { notifyMessageUpdated, onChatEvent } from "./chat";
import { getNode, onNodeStart, openPeerStream } from "./node";

export const FILE_PROTOCOL = "/nodex/file/1.0.0";
const CHUNK_BYTES = 60 * 1024;
const MAX_FRAME_BYTES = 96 * 1024;
const IO_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 5;
const FRAME_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

type GetFrame = { t: "get"; id: string; offset: number };
type FileFrame = { t: "file"; size: number; hash: string } | { t: "gone" };

export type TransferState = {
  messageId: string;
  /** Bytes received so far. */
  received: number;
  size: number;
  status: "downloading" | "done" | "failed" | "cancelled";
  error?: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const listeners = new Set<(s: TransferState) => void>();
/** Active and resumable downloads, by message id. */
const transfers = new Map<
  string,
  { chunks: Uint8Array<ArrayBuffer>[]; received: number; abort?: AbortController; running: boolean }
>();
const states = new Map<string, TransferState>();

export function onTransfer(listener: (s: TransferState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getTransfer(messageId: string): TransferState | undefined {
  return states.get(messageId);
}
function report(s: TransferState) {
  states.set(s.messageId, s);
  listeners.forEach((l) => l(s));
}

// --------------------------------------------------------------- serving

async function serve(stream: Stream, connection: Connection, identity: StoredIdentity) {
  const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
  try {
    if (isBlocked(connection.remotePeer.toString())) throw new Error("blocked");
    const req = JSON.parse(
      dec.decode((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray()),
    ) as GetFrame;
    if (req.t !== "get" || typeof req.id !== "string" || !FRAME_ID_RE.test(req.id) || !Number.isSafeInteger(req.offset)) {
      throw new Error("bad file request");
    }
    const message = await getMessage(`${identity.peerId}:${req.id}`);
    const from = connection.remotePeer.toString();
    const file = message?.file;
    // Only the person this message was sent to may download its file.
    const allowed =
      !!message && message.ownerPeerId === identity.peerId && message.direction === "out" && message.peerId === from;
    if (!allowed || !file?.blob || req.offset < 0 || req.offset > file.size) {
      await lp.write(enc.encode(JSON.stringify({ t: "gone" } satisfies FileFrame)), {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      });
      await stream.close();
      return;
    }

    await lp.write(enc.encode(JSON.stringify({ t: "file", size: file.size, hash: file.hash } satisfies FileFrame)), {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
    });
    // Read the file piece by piece from storage; never load it whole.
    for (let off = req.offset; off < file.size; off += CHUNK_BYTES) {
      const piece = new Uint8Array(await file.blob.slice(off, Math.min(off + CHUNK_BYTES, file.size)).arrayBuffer());
      await lp.write(piece, { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
    }
    await stream.close();
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
  }
}

onNodeStart(async (node, identity) => {
  await node.handle(FILE_PROTOCOL, (stream, connection) => void serve(stream, connection, identity), {
    runOnLimitedConnection: true,
    maxInboundStreams: 8,
  });
  // Small files download by themselves; big ones wait for a tap.
  const stopListening = onChatEvent((e) => {
    if (e.type !== "message") return;
    const m = e.message;
    if (m.ownerPeerId === identity.peerId && m.direction === "in" && m.file && !m.file.blob && m.file.size <= AUTO_DOWNLOAD_BYTES) {
      void downloadFile(identity, m.id);
    }
  });
  node.addEventListener("stop", stopListening, { once: true });
});

// ----------------------------------------------------------- downloading

/** One attempt: continues from the bytes already received. Resolves true when all bytes are in. */
async function attempt(
  message: ChatMessage,
  t: { chunks: Uint8Array<ArrayBuffer>[]; received: number },
  signal: AbortSignal,
): Promise<boolean> {
  const file = message.file!;
  const nodePromise = getNode();
  if (!nodePromise) throw new Error("Not connected to the NodeX network.");
  const node = await nodePromise;
  let stream: Stream | undefined;
  const onAbort = () => stream?.abort(new Error("cancelled"));
  signal.addEventListener("abort", onAbort);
  try {
    stream = await openPeerStream(node, message.peerId, FILE_PROTOCOL, IO_TIMEOUT_MS);
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
    const frameId = message.id.slice(message.id.indexOf(":") + 1);
    await lp.write(enc.encode(JSON.stringify({ t: "get", id: frameId, offset: t.received } satisfies GetFrame)), {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
    });
    const head = JSON.parse(
      dec.decode((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray()),
    ) as FileFrame;
    if (head.t === "gone") throw new GoneError();
    if (head.t !== "file" || head.size !== file.size || head.hash !== file.hash) throw new Error("file changed");

    let lastReport = 0;
    while (t.received < file.size) {
      if (signal.aborted) throw new Error("cancelled");
      const chunk = new Uint8Array((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
      if (chunk.length === 0 || t.received + chunk.length > file.size) throw new GoneError("bad file data");
      t.chunks.push(chunk);
      t.received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 150 || t.received === file.size) {
        lastReport = now;
        report({ messageId: message.id, received: t.received, size: file.size, status: "downloading" });
      }
    }
    await stream.close().catch(() => {});
    return true;
  } catch (err) {
    stream?.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The sender no longer has (or won't give) the file: retrying is pointless. */
class GoneError extends Error {
  constructor(message = "This file is no longer available from the sender.") {
    super(message);
  }
}

/**
 * Downloads a received message's file from the sender's device, resuming
 * after connection drops, then verifies and stores it with the message.
 */
export async function downloadFile(identity: StoredIdentity, messageId: string): Promise<void> {
  const message = await getMessage(messageId);
  const file = message?.file;
  if (!message || !file || file.blob || message.ownerPeerId !== identity.peerId || message.direction !== "in") return;
  if (file.size > MAX_FILE_BYTES) return;

  let t = transfers.get(messageId);
  if (t?.running) return;
  if (!t) {
    t = { chunks: [], received: 0, running: false };
    transfers.set(messageId, t);
  }
  t.running = true;
  t.abort = new AbortController();
  report({ messageId, received: t.received, size: file.size, status: "downloading" });

  try {
    for (let tries = 0; ; tries++) {
      try {
        await attempt(message, t, t.abort.signal);
        break;
      } catch (err) {
        if (t.abort.signal.aborted) throw new Error("cancelled");
        if (err instanceof GoneError || tries >= MAX_RETRIES) throw err;
        // Connection dropped: wait a little, then continue from t.received.
        await new Promise((r) => setTimeout(r, 1500 * (tries + 1)));
      }
    }

    const blob = new Blob(t.chunks, { type: file.type || "application/octet-stream" });
    if (blob.size !== file.size || (await sha256Hex(new Uint8Array(await blob.arrayBuffer()))) !== file.hash) {
      transfers.delete(messageId);
      throw new GoneError("The file didn't arrive intact. Try downloading it again.");
    }
    const current = await getMessage(messageId);
    if (!current || current.deleted) {
      // The message was deleted while its file was downloading.
      transfers.delete(messageId);
      return;
    }
    const updated: ChatMessage = { ...current, file: { ...file, blob } };
    await saveMessage(updated);
    transfers.delete(messageId);
    report({ messageId, received: file.size, size: file.size, status: "done" });
    notifyMessageUpdated(updated);
  } catch (err) {
    const cancelled = t.abort.signal.aborted;
    if (err instanceof GoneError) transfers.delete(messageId);
    report({
      messageId,
      received: t.received,
      size: file.size,
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? undefined : err instanceof Error ? err.message : "Download failed.",
    });
  } finally {
    t.running = false;
  }
}

/** Stops a download; the bytes received so far are kept so it can be resumed. */
export function cancelDownload(messageId: string): void {
  transfers.get(messageId)?.abort?.abort();
}
