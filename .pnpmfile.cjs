/**
 * better-auth declares optional peers for every framework and test runner it can work with. pnpm
 * links any it finds elsewhere in the workspace (Next.js from the web app, vitest, drizzle-kit),
 * which put them in the API's production install, where image scanners flag them. The API uses
 * better-auth only on the server with Drizzle ORM, so it doesn't need them.
 */
const UNUSED_PEERS = ["next", "react", "react-dom", "vitest", "drizzle-kit"];

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "better-auth" || (pkg.name ?? "").startsWith("@better-auth/")) {
        for (const peer of UNUSED_PEERS) {
          if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
        }
      }
      return pkg;
    },
  },
};
