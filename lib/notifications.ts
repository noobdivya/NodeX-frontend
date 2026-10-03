// New-message notifications while NodeX is open in the background (another
// tab or app in front, or the window minimised). They are raised by this
// device itself when a message arrives over the peer-to-peer connection, so
// no push server is involved. With NodeX fully closed nothing can arrive,
// and so nothing is notified.

const PREF_KEY = "nodex-notifications";

export type NotifyState = "unsupported" | "denied" | "off" | "on";

function pref(): string | null {
  try {
    return localStorage.getItem(PREF_KEY);
  } catch {
    return null;
  }
}

function setPref(value: "on" | "off") {
  try {
    localStorage.setItem(PREF_KEY, value);
  } catch {
    // preference just won't be remembered
  }
}

export function notifyState(): NotifyState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && pref() === "on" ? "on" : "off";
}

/** Whether the user has never been asked (to offer turning notifications on once). */
export function notificationsUndecided(): boolean {
  return notifyState() === "off" && pref() === null;
}

/** Turns notifications on, asking the browser for permission if needed. */
export async function enableNotifications(): Promise<NotifyState> {
  if (notifyState() === "unsupported") return "unsupported";
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  setPref(permission === "granted" ? "on" : "off");
  return notifyState();
}

export function disableNotifications(): NotifyState {
  setPref("off");
  return notifyState();
}

/** True when the user isn't looking at NodeX right now. */
export function inBackground(): boolean {
  return document.hidden || !document.hasFocus();
}

/** Shows a notification for a new message; clicking it brings NodeX to the front. */
export function notifyMessage(from: string, body: string, peerId: string, onOpen: () => void): void {
  if (notifyState() !== "on" || !inBackground()) return;
  try {
    // One notification per conversation: a newer message replaces the older one.
    const n = new Notification(from, { body, tag: `nodex-${peerId}`, icon: "/icon.svg" });
    n.onclick = () => {
      window.focus();
      onOpen();
      n.close();
    };
  } catch {
    // some browsers only allow notifications from a service worker
  }
}
