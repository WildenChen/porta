import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "porta_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PASSWORD_REQUIRED_ERROR =
  "PORTA_PASSWORD is required when PORTA_AUTH_MODE=password";
const PASSWORD_POLICY = { minLength: 8 };
const CONFIG_VERSION = 1;
const SCRYPT_PARAMS = { n: 16_384, r: 8, p: 1, keyLength: 32 };

export type AuthMode = "disabled" | "password";

export interface AuthStatus {
  mode: AuthMode;
  enabled: boolean;
  authenticated: boolean;
  configured: boolean;
}

export interface AuthSettings {
  mode: AuthMode;
  sessionDuration: { seconds: number; label: string };
  configured: boolean;
  status: "Disabled" | "Password protection enabled";
  passwordPolicy: { minLength: number };
  canEnablePassword: boolean;
}

export interface AuthProvider {
  readonly mode: AuthMode;
  status(cookieHeader?: string): AuthStatus;
  settings(c: Context): AuthSettings;
  login(password: string): Promise<string | null>;
  logout(c: Context): void;
  isRequestAuthenticated(c: Context): boolean;
  isCookieHeaderAuthenticated(cookieHeader?: string): boolean;
  enablePassword(password: string, c: Context): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  disablePassword(currentPassword: string): Promise<void>;
}

interface RuntimeAuthConfig {
  version: 1;
  mode: AuthMode;
  passwordVerifier?: {
    algorithm: "scrypt";
    salt: string;
    hash: string;
    params: typeof SCRYPT_PARAMS;
  };
  sessionSecret?: string;
  updatedAt: string;
}

interface LoadedRuntimeConfig {
  exists: boolean;
  config: RuntimeAuthConfig;
}

export interface AuthRuntimeOptions {
  dataDir?: string;
  isTrustedBootstrapRequest?: (c: Context) => boolean;
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

function validatePassword(password: unknown): string {
  if (typeof password !== "string") {
    throw new Error("Password is required.");
  }
  if (password.trim().length === 0) {
    throw new Error("Password must not be blank.");
  }
  if (password.length < PASSWORD_POLICY.minLength) {
    throw new Error(`Password must be at least ${PASSWORD_POLICY.minLength} characters.`);
  }
  return password;
}

function requiredPasswordFromEnv(password: string | undefined): string {
  if (!password || password.trim().length === 0) {
    throw new Error(PASSWORD_REQUIRED_ERROR);
  }
  return validatePassword(password);
}

function createVerifier(password: string): RuntimeAuthConfig["passwordVerifier"] {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.n,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  }).toString("base64url");

  return {
    algorithm: "scrypt",
    salt,
    hash,
    params: SCRYPT_PARAMS,
  };
}

function verifyPassword(
  password: string,
  verifier: RuntimeAuthConfig["passwordVerifier"],
): boolean {
  if (!verifier || verifier.algorithm !== "scrypt") return false;
  const hash = scryptSync(password, verifier.salt, verifier.params.keyLength, {
    N: verifier.params.n,
    r: verifier.params.r,
    p: verifier.params.p,
  }).toString("base64url");
  return safeEqual(hash, verifier.hash);
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
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

function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PORTA_DATA_DIR?.trim() || join(homedir(), ".porta"));
}

function configPath(dataDir: string): string {
  return join(dataDir, "auth.json");
}

function emptyConfig(mode: AuthMode = "disabled"): RuntimeAuthConfig {
  return {
    version: CONFIG_VERSION,
    mode,
    updatedAt: new Date().toISOString(),
  };
}

function assertRuntimeConfig(value: unknown, filePath: string): RuntimeAuthConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Porta auth runtime config at ${filePath}.`);
  }
  const config = value as Partial<RuntimeAuthConfig>;
  if (config.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported Porta auth runtime config version at ${filePath}.`);
  }
  if (config.mode !== "disabled" && config.mode !== "password") {
    throw new Error(`Invalid auth mode in Porta auth runtime config at ${filePath}.`);
  }
  if (config.mode === "password") {
    if (!config.passwordVerifier || !config.sessionSecret) {
      throw new Error(`Password auth runtime config is incomplete at ${filePath}.`);
    }
  }
  return config as RuntimeAuthConfig;
}

function loadRuntimeConfig(dataDir: string): LoadedRuntimeConfig {
  const filePath = configPath(dataDir);
  if (!existsSync(filePath)) {
    return { exists: false, config: emptyConfig() };
  }

  try {
    return {
      exists: true,
      config: assertRuntimeConfig(JSON.parse(readFileSync(filePath, "utf8")), filePath),
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in Porta auth runtime config at ${filePath}.`);
    }
    throw err;
  }
}

function writeRuntimeConfigSync(dataDir: string, config: RuntimeAuthConfig): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filePath = configPath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, filePath);
  chmodSync(filePath, 0o600);
  chmodSync(dataDir, 0o700);
}

async function writeRuntimeConfig(dataDir: string, config: RuntimeAuthConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filePath = configPath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
  await chmod(dirname(filePath), 0o700);
}

function bootstrapConfigFromEnv(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): RuntimeAuthConfig {
  const configuredMode = env.PORTA_AUTH_MODE?.trim() || "disabled";
  if (configuredMode !== "disabled" && configuredMode !== "password") {
    throw new Error(
      `Unsupported PORTA_AUTH_MODE "${configuredMode}". Expected "disabled" or "password".`,
    );
  }

  if (configuredMode === "password") {
    const config: RuntimeAuthConfig = {
      version: CONFIG_VERSION,
      mode: "password",
      passwordVerifier: createVerifier(requiredPasswordFromEnv(env.PORTA_PASSWORD)),
      sessionSecret: randomBytes(32).toString("base64url"),
      updatedAt: new Date().toISOString(),
    };
    writeRuntimeConfigSync(dataDir, config);
    return config;
  }

  return emptyConfig("disabled");
}

function normalizeLoopbackAddress(address?: string): string | null {
  if (!address) return null;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "127.0.0.1" ? normalized : null;
}

function nodeRemoteAddress(c: Context): string | null {
  const env = c.env as {
    incoming?: { socket?: { remoteAddress?: string } };
    node?: { req?: { socket?: { remoteAddress?: string } } };
  };
  return (
    normalizeLoopbackAddress(env.incoming?.socket?.remoteAddress) ??
    normalizeLoopbackAddress(env.node?.req?.socket?.remoteAddress)
  );
}

function defaultTrustedBootstrapRequest(c: Context): boolean {
  return nodeRemoteAddress(c) !== null;
}

class RuntimeAuthProvider implements AuthProvider {
  private config: RuntimeAuthConfig;
  private readonly dataDir: string;
  private readonly isTrustedBootstrapRequest: (c: Context) => boolean;

  constructor(
    config: RuntimeAuthConfig,
    dataDir: string,
    options: AuthRuntimeOptions = {},
  ) {
    this.config = config;
    this.dataDir = dataDir;
    this.isTrustedBootstrapRequest =
      options.isTrustedBootstrapRequest ?? defaultTrustedBootstrapRequest;
  }

  get mode(): AuthMode {
    return this.config.mode;
  }

  status(cookieHeader?: string): AuthStatus {
    return {
      mode: this.config.mode,
      enabled: this.config.mode === "password",
      configured: this.isConfigured(),
      authenticated:
        this.config.mode === "disabled" ||
        this.isCookieHeaderAuthenticated(cookieHeader),
    };
  }

  settings(c: Context): AuthSettings {
    const enabled = this.config.mode === "password";
    return {
      mode: this.config.mode,
      sessionDuration: { seconds: SESSION_TTL_SECONDS, label: "7 days" },
      configured: this.isConfigured(),
      status: enabled ? "Password protection enabled" : "Disabled",
      passwordPolicy: PASSWORD_POLICY,
      canEnablePassword: enabled || this.isTrustedBootstrapRequest(c),
    };
  }

  async login(password: string): Promise<string | null> {
    if (
      this.config.mode !== "password" ||
      !this.config.passwordVerifier ||
      !this.config.sessionSecret
    ) {
      return null;
    }
    if (!verifyPassword(password, this.config.passwordVerifier)) return null;
    return createSession(this.config.sessionSecret);
  }

  logout(c: Context): void {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
  }

  isRequestAuthenticated(c: Context): boolean {
    return this.isCookieHeaderAuthenticated(c.req.header("cookie"));
  }

  isCookieHeaderAuthenticated(cookieHeader?: string): boolean {
    if (this.config.mode === "disabled") return true;
    if (!this.config.sessionSecret) return false;
    return verifySession(
      this.config.sessionSecret,
      parseCookies(cookieHeader).get(COOKIE_NAME),
    );
  }

  async enablePassword(password: string, c: Context): Promise<void> {
    if (this.config.mode === "password") {
      throw new Error("Password mode is already enabled.");
    }
    if (this.config.mode === "disabled" && !this.isTrustedBootstrapRequest(c)) {
      throw new Error("Password mode can only be enabled from the local Porta host.");
    }

    const config: RuntimeAuthConfig = {
      version: CONFIG_VERSION,
      mode: "password",
      passwordVerifier: createVerifier(validatePassword(password)),
      sessionSecret: randomBytes(32).toString("base64url"),
      updatedAt: new Date().toISOString(),
    };
    await this.persist(config);
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (
      this.config.mode !== "password" ||
      !this.config.passwordVerifier ||
      !verifyPassword(currentPassword, this.config.passwordVerifier)
    ) {
      throw new Error("Current password is incorrect.");
    }

    const config: RuntimeAuthConfig = {
      version: CONFIG_VERSION,
      mode: "password",
      passwordVerifier: createVerifier(validatePassword(newPassword)),
      sessionSecret: randomBytes(32).toString("base64url"),
      updatedAt: new Date().toISOString(),
    };
    await this.persist(config);
  }

  async disablePassword(currentPassword: string): Promise<void> {
    if (
      this.config.mode !== "password" ||
      !this.config.passwordVerifier ||
      !verifyPassword(currentPassword, this.config.passwordVerifier)
    ) {
      throw new Error("Current password is incorrect.");
    }

    await this.persist(emptyConfig("disabled"));
  }

  private isConfigured(): boolean {
    return (
      this.config.mode === "disabled" ||
      Boolean(this.config.passwordVerifier && this.config.sessionSecret)
    );
  }

  private async persist(config: RuntimeAuthConfig): Promise<void> {
    await writeRuntimeConfig(this.dataDir, config);
    this.config = config;
  }
}

export function createAuthProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: AuthRuntimeOptions = {},
): AuthProvider {
  const dataDir = options.dataDir ?? defaultDataDir(env);
  const loaded = loadRuntimeConfig(dataDir);
  const config = loaded.exists ? loaded.config : bootstrapConfigFromEnv(env, dataDir);
  return new RuntimeAuthProvider(config, dataDir, options);
}

function clearSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  return await c.req.json().catch(() => ({})) as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Authentication settings update failed.";
}

export function registerAuthRoutes(app: Hono, provider: AuthProvider): void {
  app.get("/api/auth/status", (c: Context) =>
    c.json(provider.status(c.req.header("cookie"))),
  );

  app.get("/api/auth/settings", (c: Context) => {
    const status = provider.status(c.req.header("cookie"));
    if (provider.mode === "password" && !status.authenticated) {
      return c.json({ error: "Authentication required" }, 401);
    }
    return c.json(provider.settings(c));
  });

  app.post("/api/auth/login", async (c: Context) => {
    if (provider.mode === "disabled") {
      return c.json(provider.status(c.req.header("cookie")));
    }

    const body = await readJson(c);
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

  app.post("/api/auth/settings/password", async (c: Context) => {
    const body = await readJson(c);
    if (body.password !== body.confirmPassword) {
      return c.json({ error: "Passwords do not match." }, 400);
    }

    try {
      await provider.enablePassword(body.password as string, c);
      clearSession(c);
      return c.json(provider.status());
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/auth/settings/password/change", async (c: Context) => {
    if (!provider.isRequestAuthenticated(c)) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = await readJson(c);
    if (body.newPassword !== body.confirmPassword) {
      return c.json({ error: "Passwords do not match." }, 400);
    }

    try {
      await provider.changePassword(
        body.currentPassword as string,
        body.newPassword as string,
      );
      clearSession(c);
      return c.json(provider.status());
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/auth/settings/disable", async (c: Context) => {
    if (!provider.isRequestAuthenticated(c)) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = await readJson(c);
    try {
      await provider.disablePassword(body.currentPassword as string);
      clearSession(c);
      return c.json(provider.status());
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
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
