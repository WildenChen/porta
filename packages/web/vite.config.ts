import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import { normalizeBasePath } from "./src/basePath.shared";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

function gitSha(): string {
  if (process.env.PORTA_GIT_SHA) return process.env.PORTA_GIT_SHA;

  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function upstreamVersion(version: string): string {
  return version.split("+")[0] || version;
}

function toHttpOrigin(host: string, port: string) {
  const normalizedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const proxyHost = env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1";
  const proxyPort = env.PORTA_PORT || process.env.PORTA_PORT || "3170";

  const rawBasePath = env.PORTA_BASE_PATH || process.env.PORTA_BASE_PATH || "/";
  const basePath = normalizeBasePath(rawBasePath);
  const allowedHostsRaw = env.PORTA_ALLOWED_HOSTS || process.env.PORTA_ALLOWED_HOSTS;
  const allowedHosts = allowedHostsRaw === "true" || allowedHostsRaw === "all" || allowedHostsRaw === "*"
    ? true
    : (allowedHostsRaw ? allowedHostsRaw.split(",") : undefined);

  return {
    base: basePath,
    define: {
      "import.meta.env.PORTA_BASE_PATH": JSON.stringify(basePath),
      "import.meta.env.PORTA_APP_VERSION": JSON.stringify(rootPackage.version),
      "import.meta.env.PORTA_UPSTREAM_VERSION": JSON.stringify(
        upstreamVersion(rootPackage.version),
      ),
      "import.meta.env.PORTA_GIT_SHA": JSON.stringify(gitSha()),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        workbox: {
          // Only precache hashed static assets — NOT index.html.
          // index.html must always come from the network so deploys
          // take effect immediately. Hashed filenames (e.g. index-Ab12Cd.js)
          // guarantee the SW cache entry matches the code version.
          globPatterns: ["**/*.{js,css,ico,png,svg,woff2}"],
          skipWaiting: true,
          clientsClaim: true,
          // Don't create a NavigationRoute — let navigation requests
          // hit the network (Cloudflare CDN) for a fresh index.html.
          navigateFallback: null,
        },
        manifest: false, // Use our existing public/manifest.json
        injectRegister: "script-defer",
        scope: basePath,
      }),
    ],
    envDir: repoRoot,
    server: {
      host: env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1",
      port: Number(env.PORTA_WEB_PORT || process.env.PORTA_WEB_PORT || 3070),
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
      proxy: {
        "/api": {
          target: toHttpOrigin(proxyHost, proxyPort),
          changeOrigin: true,
          ws: true,
          headers: {
            ...(env.CF_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID } : {}),
            ...(env.CF_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET } : {}),
          },
        },
      },
    },
  };
});
