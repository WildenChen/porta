import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import { normalizeBasePath } from "./src/basePath.shared";
import { accessGate } from "./vite-access-gate";

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const proxyHost = env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1";
  const proxyPort = env.PORTA_PORT || process.env.PORTA_PORT || "3170";

  const rawBasePath = env.PORTA_BASE_PATH || process.env.PORTA_BASE_PATH || "/";
  const basePath = normalizeBasePath(rawBasePath);
  const allowedHostsRaw = env.PORTA_ALLOWED_HOSTS || process.env.PORTA_ALLOWED_HOSTS;
  const allowedHostsValue = allowedHostsRaw?.trim();
  const allowedHosts =
    allowedHostsValue === "true" || allowedHostsValue === "all" || allowedHostsValue === "*"
      ? true
      : allowedHostsValue
        ? allowedHostsValue.split(",").map((host) => host.trim()).filter(Boolean)
        : undefined;

  const requireAuthRaw = (
    env.PORTA_REQUIRE_AUTH || process.env.PORTA_REQUIRE_AUTH || ""
  ).trim();
  const requireAuth = /^(1|true|yes|on)$/i.test(requireAuthRaw);
  if (
    requireAuthRaw &&
    !requireAuth &&
    !/^(0|false|no|off)$/i.test(requireAuthRaw)
  ) {
    throw new Error(
      "PORTA_REQUIRE_AUTH must be one of 1/true/yes/on or 0/false/no/off.",
    );
  }
  const accessToken = env.PORTA_ACCESS_TOKEN || process.env.PORTA_ACCESS_TOKEN || "";

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
      accessGate({ enabled: requireAuth, token: accessToken }),
      react(),
      VitePWA({
        registerType: "autoUpdate",
        workbox: {
          globPatterns: ["**/*.{js,css,ico,png,svg,woff2}"],
          skipWaiting: true,
          clientsClaim: true,
          navigateFallback: null,
        },
        manifest: false,
        injectRegister: "script-defer",
        scope: basePath,
      }),
    ],
    envDir: repoRoot,
    server: {
      host: env.PORTA_HOST || process.env.PORTA_HOST || "127.0.0.1",
      port: Number(env.PORTA_WEB_PORT || process.env.PORTA_WEB_PORT || 3070),
      strictPort: true,
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
