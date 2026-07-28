import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";

const COOKIE_NAME = "porta_access";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function tokenFromQuery(url: string | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf("?");
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get("access_token");
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return false;
  const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
  if (cookie && safeEqual(cookie, token)) return true;
  const queryToken = tokenFromQuery(req.url);
  return !!queryToken && safeEqual(queryToken, token);
}

export function accessGate(options: { enabled: boolean; token: string }): Plugin {
  return {
    name: "porta-access-gate",
    configureServer(server) {
      if (!options.enabled) return;

      server.middlewares.use((req, res, next) => {
        if (!options.token) {
          res.statusCode = 503;
          res.end(
            "Access control is enabled (PORTA_REQUIRE_AUTH) but PORTA_ACCESS_TOKEN is not set.",
          );
          return;
        }

        const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
        if (cookie && safeEqual(cookie, options.token)) {
          next();
          return;
        }

        const queryToken = tokenFromQuery(req.url);
        if (queryToken && safeEqual(queryToken, options.token)) {
          const path = (req.url ?? "/").split("?")[0] || "/";
          res.statusCode = 302;
          res.setHeader(
            "Set-Cookie",
            `${COOKIE_NAME}=${encodeURIComponent(options.token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
          );
          res.setHeader("Location", path);
          res.end();
          return;
        }

        res.statusCode = 401;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          "<!doctype html><meta charset=utf-8><title>Unauthorized</title>" +
            "<body><h1>401 — Access restricted</h1>" +
            "<p>Append <code>?access_token=YOUR_TOKEN</code> to the URL once to sign in.</p>",
        );
      });

      const httpServer = server.httpServer;
      if (!httpServer) return;

      const originalEmit = httpServer.emit;
      const guardedEmit = function (
        this: typeof httpServer,
        eventName: string | symbol,
        ...args: unknown[]
      ) {
        if (eventName === "upgrade") {
          const req = args[0] as IncomingMessage;
          const socket = args[1] as Duplex;
          if (!isAuthorized(req, options.token)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return true;
          }
        }
        return Reflect.apply(originalEmit, this, [eventName, ...args]);
      } as typeof httpServer.emit;

      httpServer.emit = guardedEmit;
      httpServer.once("close", () => {
        if (httpServer.emit === guardedEmit) {
          httpServer.emit = originalEmit;
        }
      });
    },
  };
}
