import type { Metadata, Viewport } from "next";
import "./globals.css";

// favicon.ico, icon.svg and apple-icon.png in this folder are picked up
// automatically by Next.js and emitted as <link rel="icon"> tags.
export const metadata: Metadata = {
  title: {
    default: "NodeX — Decentralized P2P Chat",
    template: "%s · NodeX",
  },
  description: "NodeX is a decentralized, end-to-end encrypted peer-to-peer chat network.",
  applicationName: "NodeX",
  manifest: "/manifest.webmanifest",
  appleWebApp: { title: "NodeX", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
