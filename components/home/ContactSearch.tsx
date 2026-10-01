"use client";

import { useEffect, useState } from "react";
import { normalizeHandle } from "@/lib/handle";
import type { StoredIdentity } from "@/lib/keystore";
import type { LookupResult, NetworkStatus } from "@/lib/p2p/node";
import Avatar from "./Avatar";
import { AddPersonIcon, BackIcon, CheckIcon, CloseIcon, SearchIcon } from "./icons";
import { useAvatarUrls } from "./useAvatarUrls";

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "found"; result: LookupResult }
  | { status: "not_found"; handle: string }
  | { status: "error"; message: string };

/**
 * "New contact": find someone by their exact handle over the P2P network.
 * The lookup goes to the DHT; the record is verified on this device.
 */
export default function ContactSearch({
  identity,
  network,
  savedPeerIds,
  onAdd,
  onRemove,
  onMessage,
  onBack,
}: {
  identity: StoredIdentity;
  network: NetworkStatus;
  savedPeerIds: Set<string>;
  onAdd: (result: LookupResult) => Promise<void>;
  onRemove: (peerId: string) => Promise<void>;
  /** Opens a chat with this person (saving them as a contact). */
  onMessage: (result: LookupResult) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const key = normalizeHandle(query);
  const resultAvatars = useAvatarUrls(state.status === "found" ? [state.result.peerId] : []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!key || state.status === "searching") return;
    if (key === identity.handleKey) {
      setState({
        status: "found",
        result: { handle: identity.handle, handleKey: identity.handleKey, peerId: identity.peerId },
      });
      return;
    }
    setState({ status: "searching" });
    try {
      const { lookupHandle } = await import("@/lib/p2p/node");
      const result = await lookupHandle(identity, query);
      setState(result ? { status: "found", result } : { status: "not_found", handle: query.trim() });
      // Ask the person's device for their profile photo (shown when it arrives).
      if (result && result.peerId !== identity.peerId) {
        void import("@/lib/p2p/profile-share").then((p) => p.fetchAvatar(identity, result.peerId));
      }
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Search failed." });
    }
  }

  const hint =
    query && !key
      ? "Enter a full handle: name, #, and the 6-character tag (e.g. Rahul#7K3M9X)."
      : state.status === "searching"
        ? "Searching the NodeX network…"
        : state.status === "not_found"
          ? `No one with the handle “${state.handle}” is on the NodeX network right now.`
          : state.status === "error"
            ? state.message
            : !query
              ? "Find people by their NodeX handle. Capital letters don't matter."
              : "";

  return (
    <>
      <header className="app-bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
        <div className="app-title">
          <span>New contact</span>
        </div>
      </header>

      <form className="search-bar" onSubmit={search} role="search">
        <SearchIcon size={20} />
        <label htmlFor="search" className="sr-only">
          Search by handle
        </label>
        <input
          id="search"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          maxLength={27}
          placeholder="Search by handle, e.g. Rahul#7K3M9X"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (state.status !== "searching") setState({ status: "idle" });
          }}
          aria-describedby="search-hint"
        />
        {query && (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Clear search" onClick={() => setQuery("")}>
            <CloseIcon size={18} />
          </button>
        )}
        <button type="submit" className="search-go" disabled={!key || state.status === "searching"}>
          Search
        </button>
      </form>

      {network.state !== "online" && network.state !== "unconfigured" && (
        <p className="search-hint">Connecting to the NodeX network…</p>
      )}
      {hint && (
        <p
          id="search-hint"
          className="search-hint"
          data-tone={state.status === "error" || (query && !key) ? "error" : undefined}
          aria-live="polite"
        >
          {hint}
        </p>
      )}

      {state.status === "found" && (
        <>
          <p className="list-label">On NodeX</p>
          <ul className="chat-list" aria-label="Search results">
            <li className="chat-row">
              {state.result.peerId === identity.peerId ? (
                <>
                  <Avatar name={state.result.handle} src={resultAvatars.get(state.result.peerId)} />
                  <div className="chat-main">
                    <span className="chat-name">{state.result.handle}</span>
                    <span className="chat-sub">This is you</span>
                  </div>
                </>
              ) : (
                // Tapping the person opens the chat, like WhatsApp.
                <button
                  type="button"
                  className="result-open"
                  aria-label={`Message ${state.result.handle}`}
                  onClick={() => onMessage(state.result)}
                >
                  <Avatar name={state.result.handle} src={resultAvatars.get(state.result.peerId)} />
                  <div className="chat-main">
                    <span className="chat-name">{state.result.handle}</span>
                    <span className="chat-sub">
                      {savedPeerIds.has(state.result.peerId) ? "In your contacts" : "Verified on the NodeX network"}
                      {" · tap to message"}
                    </span>
                  </div>
                </button>
              )}
              {state.result.peerId !== identity.peerId && (
                <button type="button" className="search-go" onClick={() => onMessage(state.result)}>
                  Message
                </button>
              )}
              {state.result.peerId !== identity.peerId &&
                (savedPeerIds.has(state.result.peerId) ? (
                  <button
                    type="button"
                    className="row-action row-action-done"
                    aria-label={`Remove ${state.result.handle} from contacts`}
                    title="Remove from contacts"
                    onClick={() => onRemove(state.result.peerId)}
                  >
                    <CheckIcon size={20} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="row-action"
                    aria-label={`Add ${state.result.handle}`}
                    title="Add to contacts"
                    onClick={() => onAdd(state.result)}
                  >
                    <AddPersonIcon size={20} />
                  </button>
                ))}
            </li>
          </ul>
        </>
      )}
    </>
  );
}
