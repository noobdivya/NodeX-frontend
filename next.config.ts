import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The P2P layer only runs in the browser (which has WebRTC built in). Its
  // Node.js build pulls in a native addon, so keep it out of server bundles.
  serverExternalPackages: ["@libp2p/webrtc", "node-datachannel"],
};

export default nextConfig;
