import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/api/[[route]]";

describe("Cloudflare API function cookie forwarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Porta session cookies while dropping Cloudflare Access cookies", async () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", "porta_session=abc; Path=/; HttpOnly; SameSite=Lax");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers,
        }),
      ),
    );

    const response = await onRequest({
      request: new Request("https://porta.example/api/auth/login", {
        method: "POST",
        body: "{}",
      }),
      env: { PORTA_API_BASE: "https://api.example" },
    });

    expect(response.headers.get("Set-Cookie")).toContain("porta_session=abc");
  });

  it("does not forward Cloudflare Access authorization cookies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "CF_Authorization=secret; Path=/; HttpOnly",
          },
        }),
      ),
    );

    const response = await onRequest({
      request: new Request("https://porta.example/api/health"),
      env: { PORTA_API_BASE: "https://api.example" },
    });

    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});
