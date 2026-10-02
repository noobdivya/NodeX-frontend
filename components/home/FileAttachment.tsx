"use client";

import { useEffect, useState } from "react";
import type { StoredIdentity } from "@/lib/keystore";
import { formatBytes, isPlayableVideo, type ChatMessage } from "@/lib/messages";
import type { TransferState } from "@/lib/p2p/file-transfer";

function useBlobUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/**
 * A video or document inside a message. Videos play in the chat once
 * downloaded; documents are never opened here, only saved to the device.
 */
export default function FileAttachment({ message, identity }: { message: ChatMessage; identity: StoredIdentity }) {
  const file = message.file!;
  const url = useBlobUrl(file.blob);
  const [transfer, setTransfer] = useState<TransferState>();
  const video = isPlayableVideo(file);

  // Follow this file's download progress.
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/p2p/file-transfer").then((ft) => {
      if (!alive) return;
      setTransfer(ft.getTransfer(message.id));
      unsubscribe = ft.onTransfer((s) => s.messageId === message.id && setTransfer(s));
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [message.id]);

  const start = () => void import("@/lib/p2p/file-transfer").then((ft) => ft.downloadFile(identity, message.id));
  const cancel = () => void import("@/lib/p2p/file-transfer").then((ft) => ft.cancelDownload(message.id));

  // Downloaded (or sent by me): show the video, or a card to save the document.
  if (file.blob && url) {
    return (
      <div className="file-box">
        {video && <video className="bubble-video" src={url} controls preload="metadata" aria-label={file.name} />}
        <div className="file-card">
          <span className="file-icon" aria-hidden="true">
            {video ? "🎬" : "📄"}
          </span>
          <div className="file-info">
            <span className="file-name">{file.name}</span>
            <span className="file-size">{formatBytes(file.size)}</span>
          </div>
          <a className="file-action" href={url} download={file.name}>
            Save
          </a>
        </div>
        {!video && message.direction === "in" && (
          <span className="file-warning">Only open files from people you trust.</span>
        )}
      </div>
    );
  }

  // Not downloaded yet.
  const downloading = transfer?.status === "downloading";
  const percent = transfer ? Math.floor((transfer.received / transfer.size) * 100) : 0;
  const partial = !!transfer && transfer.received > 0 && !downloading;
  return (
    <div className="file-box">
      <div className="file-card">
        <span className="file-icon" aria-hidden="true">
          {video ? "🎬" : "📄"}
        </span>
        <div className="file-info">
          <span className="file-name">{file.name}</span>
          <span className="file-size">
            {downloading
              ? `${formatBytes(transfer.received)} of ${formatBytes(file.size)} · ${percent}%`
              : formatBytes(file.size)}
          </span>
        </div>
        {downloading ? (
          <button type="button" className="file-action" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="file-action" onClick={start}>
            {partial ? "Resume" : transfer?.status === "failed" ? "Try again" : "Download"}
          </button>
        )}
      </div>
      {downloading && (
        <div
          className="file-progress"
          role="progressbar"
          aria-label={`Downloading ${file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {transfer?.status === "failed" && transfer.error && <span className="file-warning">{transfer.error}</span>}
      {!downloading && !transfer?.error && (
        <span className="file-warning">Downloads straight from the sender&apos;s device while they&apos;re online.</span>
      )}
    </div>
  );
}
