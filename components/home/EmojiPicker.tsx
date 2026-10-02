"use client";

import { useState } from "react";

// A small built-in emoji picker (no external library). Emojis are ordinary
// Unicode text, so they travel in messages like any other characters.
const CATEGORIES: { name: string; icon: string; emojis: string }[] = [
  {
    name: "Smileys",
    icon: "😀",
    emojis:
      "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖",
  },
  {
    name: "Gestures",
    icon: "👋",
    emojis:
      "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 👁️ 👅 👄 🧠 🫶 🙋 🙆 🙅 🤷 🤦 🙇 💃 🕺 🧑‍💻 👨‍👩‍👧 👫",
  },
  {
    name: "Hearts",
    icon: "❤️",
    emojis:
      "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💋 💌 💐 🌹 🥀 🌷 🌸 🌺 🌻 🌼 ✨ ⭐ 🌟 💫 🔥 💯 💢 💥 💦 💤 🎉 🎊 🎈 🎁 🏆 🥇",
  },
  {
    name: "Food",
    icon: "🍕",
    emojis:
      "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🥕 🥔 🍞 🥐 🧀 🍳 🥞 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🍚 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 ☕ 🍵 🥤 🧃 🍺 🍷 🥂",
  },
  {
    name: "Activities",
    icon: "⚽",
    emojis:
      "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏏 🥊 🎯 🎳 🎮 🕹️ 🎲 ♟️ 🧩 🎨 🎬 🎤 🎧 🎵 🎶 🎹 🥁 🎸 🎻 📚 ✏️ 💻 📱 📷 💡 💰 💎 🔑 🔒 ⏰ 🚗 🚕 🚌 🚀 ✈️ 🚲 🏠 🏖️ 🌍 🌙 ☀️ ⛅ 🌧️ ⚡ ❄️ 🌈",
  },
  {
    name: "Animals",
    icon: "🐶",
    emojis:
      "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦀 🐠 🐬 🐳 🦈 🐘 🦒 🐪 🐕 🐈 🐇 🐿️",
  },
  {
    name: "Symbols",
    icon: "✅",
    emojis:
      "✅ ❌ ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⭕ ✔️ ➕ ➖ ➗ ✖️ 💲 ♻️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔺 🔻 🔔 🔕 📌 📍 🔗 🕐 ⬆️ ⬇️ ⬅️ ➡️ 🔄 🆗 🆕 🆒 🔝 🏁 🚩",
  },
];

export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [active, setActive] = useState(0);
  const emojis = CATEGORIES[active].emojis.split(" ");

  return (
    <div className="emoji-picker" role="dialog" aria-label="Emoji picker">
      <div className="emoji-tabs" role="tablist" aria-label="Emoji categories">
        {CATEGORIES.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-label={c.name}
            title={c.name}
            className="emoji-tab"
            onClick={() => setActive(i)}
          >
            {c.icon}
          </button>
        ))}
      </div>
      <div className="emoji-grid" role="tabpanel" aria-label={CATEGORIES[active].name}>
        {emojis.map((e) => (
          // onMouseDown + preventDefault keeps the text box focused and its cursor in place.
          <button
            key={e}
            type="button"
            className="emoji-btn"
            aria-label={`Insert ${e}`}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(e)}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

/** True when a message is only 1–3 emojis (shown larger, like other messengers). */
export function isJumboEmoji(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  try {
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)]
      .map((s) => s.segment)
      .filter((s) => s.trim() !== "");
    return (
      segments.length >= 1 &&
      segments.length <= 3 &&
      segments.every((s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && !/[\p{L}\p{N}]/u.test(s))
    );
  } catch {
    return false;
  }
}
