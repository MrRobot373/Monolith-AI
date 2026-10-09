import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@aatmiq/shared", "@aatmiq/ui"],
  poweredByHeader: false,
  // Aatmiq's pages may only be framed by Aatmiq itself (no clickjacking an "Approve" button from
  // another site). The IDE (which Aatmiq frames from the IDE's own host) and the API set their own.
  async headers() {
    return [
      {
        source: "/((?!api/|code/ide).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
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
