import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TTL_SECONDS,
  authMiddleware,
  createAuthProvider,
  registerAuthRoutes,
} from "../auth.js";

function createApp(env: NodeJS.ProcessEnv) {
  const app = new Hono();
  const provider = createAuthProvider(env);
  registerAuthRoutes(app, provider);
  app.use("/api/*", authMiddleware(provider));
  app.get("/api/private", (c) => c.json({ ok: true }));
  return app;
}

describe("auth provider", () => {
  it("keeps disabled mode compatible with existing behavior", async () => {
    const app = createApp({ PORTA_AUTH_MODE: "disabled" });

    const status = await app.request("/api/auth/status");
    const privateRoute = await app.request("/api/private");

    expect(await status.json()).toMatchObject({
      mode: "disabled",
      enabled: false,
      authenticated: true,
    });
    expect(privateRoute.status).toBe(200);
  });

  it("requires a password session in password mode", async () => {
    const app = createApp({
      PORTA_AUTH_MODE: "password",
      PORTA_PASSWORD: "secret-pass",
    });

    expect((await app.request("/api/private")).status).toBe(401);

    const failed = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(failed.status).toBe(401);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("porta_session=");

    const authenticated = await app.request("/api/private", {
      headers: { cookie: login.headers.get("set-cookie") ?? "" },
    });
    expect(authenticated.status).toBe(200);
  });

  it("fails fast when password mode is missing PORTA_PASSWORD", () => {
    expect(() => createAuthProvider({ PORTA_AUTH_MODE: "password" })).toThrow(
      "PORTA_PASSWORD is required when PORTA_AUTH_MODE=password",
    );
  });

  it("fails fast when password mode has a blank PORTA_PASSWORD", () => {
    expect(() =>
      createAuthProvider({
        PORTA_AUTH_MODE: "password",
        PORTA_PASSWORD: "   ",
      }),
    ).toThrow("PORTA_PASSWORD is required when PORTA_AUTH_MODE=password");
  });

  it("fails fast on unsupported auth modes", () => {
    expect(() => createAuthProvider({ PORTA_AUTH_MODE: "oidc" })).toThrow(
      'Unsupported PORTA_AUTH_MODE "oidc". Expected "disabled" or "password".',
    );
  });

  it("keeps sessions valid across provider recreation with the same password", async () => {
    vi.setSystemTime(new Date("2026-07-22T08:00:00Z"));

    const first = createApp({
      PORTA_AUTH_MODE: "password",
      PORTA_PASSWORD: "secret-pass",
    });
    const login = await first.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
      headers: { "Content-Type": "application/json" },
    });

    const second = createApp({
      PORTA_AUTH_MODE: "password",
      PORTA_PASSWORD: "secret-pass",
    });
    const authenticated = await second.request("/api/private", {
      headers: { cookie: login.headers.get("set-cookie") ?? "" },
    });

    expect(authenticated.status).toBe(200);
    vi.useRealTimers();
  });

  it("sets a seven-day persistent HttpOnly session cookie", async () => {
    const app = createApp({
      PORTA_AUTH_MODE: "password",
      PORTA_PASSWORD: "secret-pass",
    });

    const login = await app.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret-pass" }),
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
    });

    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("porta_session=");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });
});
