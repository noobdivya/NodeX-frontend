"use client";

import { useState } from "react";

// Round avatar: the profile photo if there is one, otherwise the initial on
// a stable colour per username.
const HUES = [168, 200, 262, 290, 330, 20, 42, 142];

export default function Avatar({ name, size = 48, src }: { name: string; size?: number; src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: size * 0.42 };

  if (src && failedSrc !== src) {
    return (
      <img className="avatar avatar-img" src={src} alt="" style={style} onError={() => setFailedSrc(src)} />
    );
  }

  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ ...style, background: `hsl(${hue} 45% 26%)`, color: `hsl(${hue} 80% 78%)` }}
    >
      {name[0]?.toUpperCase()}
    </span>
  );
}
