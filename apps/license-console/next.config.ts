import type { NextConfig } from "next";

const LICENSE_API_URL = process.env.LICENSE_API_URL ?? "http://localhost:4100";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@aatmiq/ui", "@aatmiq/license"],
  poweredByHeader: false,
  // The console talks to one origin; /api is proxied to the license server.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${LICENSE_API_URL}/api/:path*` }];
  },
};

export default config;
