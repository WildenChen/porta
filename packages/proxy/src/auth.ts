import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";

const COOKIE_NAME = "porta_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PASSWORD_REQUIRED_ERROR =
  "PORTA_PASSWORD is required when PORTA_AUTH_MODE=password";

export type AuthMode = "disabled" | "password";

export interface AuthStatus {
  mode: AuthMode;
  enabled: boolean;
  authenticated: boolean;
  configured: boolean;
}

export interface AuthProvider {
  readonly mode: AuthMode;
  status(cookieHeader?: string): AuthStatus;
  login(password: string): Promise<string | null>;
  logout(c: Context): void;
  isRequestAuthenticated(c: Context): boolean;
  isCookieHeaderAuthenticated(cookieHeader?: string): boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(cookieHeader?: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function isHttpsRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https" || new URL(c.req.url).protocol === "https:";
}

function requiredPasswordFromEnv(password: string | undefined): string {
  if (!password || password.trim().length === 0) {
    throw new Error(PASSWORD_REQUIRED_ERROR);
  }
  return password;
}

function passwordHashFromEnv(password: string): string {
  const trimmed = password.trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.slice("sha256:".length).toLowerCase();
  }
  return sha256(password);
}

function createSession(secret: string): string {
  const payload = {
    v: 1,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${hmac(secret, encodedPayload)}`;
}

function verifySession(secret: string, value?: string): boolean {
  if (!value) return false;
  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return false;
  if (!safeEqual(signature, hmac(secret, encodedPayload))) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      v?: unknown;
      exp?: unknown;
    };
    return payload.v === 1 && typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

class DisabledProvider implements AuthProvider {
  readonly mode = "disabled";

  status(): AuthStatus {
    return {
      mode: this.mode,
      enabled: false,
      authenticated: true,
      configured: true,
    };
  }

  async login(): Promise<string | null> {
    return null;
  }

  logout(c: Context): void {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
  }

  isRequestAuthenticated(): boolean {
    return true;
  }

  isCookieHeaderAuthenticated(): boolean {
    return true;
  }
}

class PasswordProvider implements AuthProvider {
  readonly mode = "password";
  private readonly passwordHash?: string;
  private readonly sessionSecret?: string;

  constructor(password?: string) {
    this.passwordHash = passwordHashFromEnv(requiredPasswordFromEnv(password));
    this.sessionSecret = sha256(`porta-auth-session:${this.passwordHash}`);
  }

  status(cookieHeader?: string): AuthStatus {
    return {
      mode: this.mode,
      enabled: true,
      configured: this.isConfigured(),
      authenticated: this.isCookieHeaderAuthenticated(cookieHeader),
    };
  }

  async login(password: string): Promise<string | null> {
    if (!this.passwordHash || !this.sessionSecret) return null;
    if (!safeEqual(sha256(password), this.passwordHash)) return null;
    return createSession(this.sessionSecret);
  }

  logout(c: Context): void {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
  }

  isRequestAuthenticated(c: Context): boolean {
    return this.isCookieHeaderAuthenticated(c.req.header("cookie"));
  }

  isCookieHeaderAuthenticated(cookieHeader?: string): boolean {
    if (!this.sessionSecret) return false;
    return verifySession(this.sessionSecret, parseCookies(cookieHeader).get(COOKIE_NAME));
  }

  private isConfigured(): boolean {
    return Boolean(this.passwordHash && this.sessionSecret);
  }
}

export function createAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  const configuredMode = env.PORTA_AUTH_MODE?.trim() || "disabled";
  if (configuredMode !== "disabled" && configuredMode !== "password") {
    throw new Error(
      `Unsupported PORTA_AUTH_MODE "${configuredMode}". Expected "disabled" or "password".`,
    );
  }

  const mode = configuredMode;
  if (mode === "password") return new PasswordProvider(env.PORTA_PASSWORD);
  return new DisabledProvider();
}

export function registerAuthRoutes(app: Hono, provider: AuthProvider): void {
  app.get("/api/auth/status", (c: Context) =>
    c.json(provider.status(c.req.header("cookie"))),
  );

  app.post("/api/auth/login", async (c: Context) => {
    if (provider.mode === "disabled") {
      return c.json(provider.status(c.req.header("cookie")));
    }

    const body = await c.req.json().catch(() => ({})) as { password?: unknown };
    const session = typeof body.password === "string"
      ? await provider.login(body.password)
      : null;

    if (!session) {
      return c.json({ error: "Invalid password" }, 401);
    }

    setCookie(c, COOKIE_NAME, session, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttpsRequest(c),
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.json(provider.status(`${COOKIE_NAME}=${encodeURIComponent(session)}`));
  });

  app.post("/api/auth/logout", (c: Context) => {
    provider.logout(c);
    return c.json(provider.status());
  });
}

export function authMiddleware(provider: AuthProvider): MiddlewareHandler {
  return async (c, next) => {
    if (provider.mode === "disabled" || provider.isRequestAuthenticated(c)) {
      await next();
      return;
    }

    const status = provider.status(c.req.header("cookie"));
    if (!status.configured) {
      return c.json({ error: PASSWORD_REQUIRED_ERROR }, 503);
    }
    return c.json({ error: "Authentication required" }, 401);
  };
}
