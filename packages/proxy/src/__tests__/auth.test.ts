import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_TTL_SECONDS,
  authMiddleware,
  createAuthProvider,
  registerAuthRoutes,
  type AuthProvider,
} from "../auth.js";

let tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "porta-auth-test-"));
  tempDirs.push(dir);
  return dir;
}

function createApp(
  env: NodeJS.ProcessEnv,
  options: {
    dataDir?: string;
    trustedBootstrap?: boolean;
    providerRef?: { current?: AuthProvider };
  } = {},
) {
  const app = new Hono();
  const provider = createAuthProvider(env, {
    dataDir: options.dataDir,
    isTrustedBootstrapRequest: () => options.trustedBootstrap ?? true,
  });
  options.providerRef && (options.providerRef.current = provider);
  registerAuthRoutes(app, provider);
  app.use("/api/*", authMiddleware(provider));
  app.get("/api/private", (c) => c.json({ ok: true }));
  return app;
}

async function login(app: Hono, password: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

async function readRuntimeConfig(dataDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dataDir, "auth.json"), "utf8"));
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("auth provider", () => {
  it("keeps disabled mode compatible with existing behavior", async () => {
    const dataDir = await tempDataDir();
    const app = createApp({ PORTA_AUTH_MODE: "disabled" }, { dataDir });

    const status = await app.request("/api/auth/status");
    const privateRoute = await app.request("/api/private");

    expect(await status.json()).toMatchObject({
      mode: "disabled",
      enabled: false,
      authenticated: true,
    });
    expect(privateRoute.status).toBe(200);
  });

  it("enables password mode from disabled mode and persists a verifier", async () => {
    const dataDir = await tempDataDir();
    const app = createApp({ PORTA_AUTH_MODE: "disabled" }, { dataDir });

    const res = await app.request("/api/auth/settings/password", {
      method: "POST",
      body: JSON.stringify({
        password: "new-password",
        confirmPassword: "new-password",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("porta_session=;");
    expect(await res.json()).toMatchObject({ mode: "password", authenticated: false });

    const config = await readRuntimeConfig(dataDir);
    const configStat = await stat(join(dataDir, "auth.json"));
    expect(config.mode).toBe("password");
    expect(JSON.stringify(config)).not.toContain("new-password");
    expect(config.passwordVerifier).toMatchObject({ algorithm: "scrypt" });
    expect(config.sessionSecret).toEqual(expect.any(String));
    if (process.platform === "win32") {
      expect(configStat.isFile()).toBe(true);
    } else {
      expect(configStat.mode & 0o777).toBe(0o600);
    }
  });

  it("rejects untrusted remote first-time password setup", async () => {
    const dataDir = await tempDataDir();
    const app = createApp(
      { PORTA_AUTH_MODE: "disabled" },
      { dataDir, trustedBootstrap: false },
    );

    const res = await app.request("/api/auth/settings/password", {
      method: "POST",
      body: JSON.stringify({
        password: "new-password",
        confirmPassword: "new-password",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Password mode can only be enabled from the local Porta host.",
    });
  });

  it("rejects mismatched and short passwords on the backend", async () => {
    const dataDir = await tempDataDir();
    const app = createApp({ PORTA_AUTH_MODE: "disabled" }, { dataDir });

    const mismatch = await app.request("/api/auth/settings/password", {
      method: "POST",
      body: JSON.stringify({ password: "new-password", confirmPassword: "other" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "Passwords do not match." });

    const short = await app.request("/api/auth/settings/password", {
      method: "POST",
      body: JSON.stringify({ password: "short", confirmPassword: "short" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({
      error: "Password must be at least 8 characters.",
    });
  });

  it("keeps password mode effective after restart", async () => {
    const dataDir = await tempDataDir();
    const first = createApp({ PORTA_AUTH_MODE: "disabled" }, { dataDir });
    await first.request("/api/auth/settings/password", {
      method: "POST",
      body: JSON.stringify({
        password: "new-password",
        confirmPassword: "new-password",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const second = createApp({ PORTA_AUTH_MODE: "disabled" }, { dataDir });
    expect((await second.request("/api/private")).status).toBe(401);
    const cookie = await login(second, "new-password");
    expect((await second.request("/api/private", { headers: { cookie } })).status).toBe(200);
  });

  it("rejects wrong passwords and accepts the correct password", async () => {
    const dataDir = await tempDataDir();
    const app = createApp(
      { PORTA_AUTH_MODE: "password", PORTA_PASSWORD: "secret-pass" },
      { dataDir },
    );

    expect((await app.request("/api/private")).status).toBe(401);

    const failed = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong-password" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(failed.status).toBe(401);

    const cookie = await login(app, "secret-pass");
    const authenticated = await app.request("/api/private", { headers: { cookie } });
    expect(authenticated.status).toBe(200);
  });

  it("changes password and invalidates the old password and old sessions", async () => {
    const dataDir = await tempDataDir();
    const app = createApp(
      { PORTA_AUTH_MODE: "password", PORTA_PASSWORD: "secret-pass" },
      { dataDir },
    );
    const oldCookie = await login(app, "secret-pass");

    const changed = await app.request("/api/auth/settings/password/change", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: "secret-pass",
        newPassword: "new-password",
        confirmPassword: "new-password",
      }),
      headers: {
        "Content-Type": "application/json",
        cookie: oldCookie,
      },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toContain("porta_session=;");
    expect((await app.request("/api/private", { headers: { cookie: oldCookie } })).status).toBe(401);

    const oldLogin = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(oldLogin.status).toBe(401);

    const newCookie = await login(app, "new-password");
    expect((await app.request("/api/private", { headers: { cookie: newCookie } })).status).toBe(200);
  });

  it("requires the current password before disabling password mode", async () => {
    const dataDir = await tempDataDir();
    const app = createApp(
      { PORTA_AUTH_MODE: "password", PORTA_PASSWORD: "secret-pass" },
      { dataDir },
    );
    const cookie = await login(app, "secret-pass");

    const wrong = await app.request("/api/auth/settings/disable", {
      method: "POST",
      body: JSON.stringify({ currentPassword: "wrong-password" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(wrong.status).toBe(400);

    const disabled = await app.request("/api/auth/settings/disable", {
      method: "POST",
      body: JSON.stringify({ currentPassword: "secret-pass" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get("set-cookie")).toContain("porta_session=;");
    expect(await disabled.json()).toMatchObject({ mode: "disabled" });
    expect((await app.request("/api/private")).status).toBe(200);
  });

  it("does not expose sensitive settings fields", async () => {
    const dataDir = await tempDataDir();
    const app = createApp(
      { PORTA_AUTH_MODE: "password", PORTA_PASSWORD: "secret-pass" },
      { dataDir },
    );
    const cookie = await login(app, "secret-pass");

    const res = await app.request("/api/auth/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).toContain("Password protection enabled");
    expect(bodyText).not.toContain("secret-pass");
    expect(bodyText).not.toContain("hash");
    expect(bodyText).not.toContain("salt");
    expect(bodyText).not.toContain("sessionSecret");
  });

  it("sets a seven-day persistent HttpOnly session cookie", async () => {
    const dataDir = await tempDataDir();
    const app = createApp(
      { PORTA_AUTH_MODE: "password", PORTA_PASSWORD: "secret-pass" },
      { dataDir },
    );

    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
    });

    const cookie = loginRes.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("porta_session=");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("uses runtime config before environment variables", async () => {
    const dataDir = await tempDataDir();
    const first = createApp(
      { PORTA_AUTH_MODE: "password", PORTA_PASSWORD: "runtime-pass" },
      { dataDir },
    );
    await login(first, "runtime-pass");

    const second = createApp(
      { PORTA_AUTH_MODE: "disabled", PORTA_PASSWORD: "ignored-pass" },
      { dataDir },
    );
    expect((await second.request("/api/private")).status).toBe(401);
    await login(second, "runtime-pass");
  });

  it("fails fast when password bootstrap is missing PORTA_PASSWORD", async () => {
    const dataDir = await tempDataDir();
    expect(() =>
      createAuthProvider({ PORTA_AUTH_MODE: "password" }, { dataDir }),
    ).toThrow("PORTA_PASSWORD is required when PORTA_AUTH_MODE=password");
  });

  it("fails fast on unsupported auth modes", async () => {
    const dataDir = await tempDataDir();
    expect(() =>
      createAuthProvider({ PORTA_AUTH_MODE: "oidc" }, { dataDir }),
    ).toThrow('Unsupported PORTA_AUTH_MODE "oidc". Expected "disabled" or "password".');
  });

  it("fails safely when runtime config is corrupted", async () => {
    const dataDir = await tempDataDir();
    await writeFile(join(dataDir, "auth.json"), "{not-json", { mode: 0o600 });

    expect(() => createAuthProvider({}, { dataDir })).toThrow(
      `Invalid JSON in Porta auth runtime config at ${join(dataDir, "auth.json")}.`,
    );
  });

  it("makes WebSocket auth validation follow the latest mode", async () => {
    const dataDir = await tempDataDir();
    const providerRef: { current?: AuthProvider } = {};
    const app = createApp({ PORTA_AUTH_MODE: "disabled" }, { dataDir, providerRef });
    const provider = providerRef.current;
    expect(provider).toBeDefined();

    expect(provider?.isCookieHeaderAuthenticated()).toBe(true);
    await app.request("/api/auth/settings/password", {
      method: "POST",
      body: JSON.stringify({
        password: "new-password",
        confirmPassword: "new-password",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(provider?.isCookieHeaderAuthenticated()).toBe(false);
  });
});
