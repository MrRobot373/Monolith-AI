import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@aatmiq/shared", "@aatmiq/ui"],
  poweredByHeader: false,
  // The browser talks to one origin; /api is proxied to the API service.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default config;
