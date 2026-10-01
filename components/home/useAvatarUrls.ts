"use client";

import { useEffect, useState } from "react";
import { getAvatars } from "@/lib/profile";

/**
 * Object URLs for the stored profile photos of `peerIds`, kept up to date
 * as photos arrive peer to peer. URLs are revoked when no longer needed.
 */
export function useAvatarUrls(peerIds: string[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const key = [...peerIds].sort().join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    let alive = true;
    let current = new Map<string, string>();
    let unsubscribe: (() => void) | undefined;

    const load = async () => {
      const blobs = await getAvatars(ids).catch(() => new Map<string, Blob>());
      if (!alive) return;
      const next = new Map<string, string>();
      for (const [id, blob] of blobs) next.set(id, URL.createObjectURL(blob));
      const old = current;
      current = next;
      setUrls(next);
      old.forEach((u) => URL.revokeObjectURL(u));
    };

    void load();
    void import("@/lib/p2p/profile-share").then(({ onAvatarEvent }) => {
      if (!alive) return;
      unsubscribe = onAvatarEvent((peerId) => {
        if (ids.includes(peerId)) void load();
      });
    });
    return () => {
      alive = false;
      unsubscribe?.();
      current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [key]);

  return urls;
}
