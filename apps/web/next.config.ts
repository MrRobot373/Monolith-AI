import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@aatmiq/shared", "@aatmiq/ui"],
  poweredByHeader: false,
  // The browser talks to one origin; /api and the IDE (/code/ide, incl. WebSockets) go to the API service.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/code/ide", destination: `${API_URL}/code/ide` },
      { source: "/code/ide/:path*", destination: `${API_URL}/code/ide/:path*` },
    ];
  },
};

export default config;
