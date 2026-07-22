// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const onRequest: any = async (context: any) => {
    const { request, env } = context;

    // Determine the target API base URL from the environment.
    let apiBase = env.PORTA_API_BASE;
    if (!apiBase) {
        return new Response(JSON.stringify({ error: "Missing PORTA_API_BASE environment variable" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }

    if (typeof apiBase === "string" && !apiBase.startsWith("http")) {
        apiBase = "https://" + apiBase;
    }

    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, apiBase);

    const headers = new Headers(request.headers);

    // 1. Inject Cloudflare Access Service Token credentials (if configured).
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
        headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
    }

    // Strip origin headers to avoid triggering CORS preflight issues on the target server.
    headers.delete("Origin");
    headers.delete("Referer");

    const requestInit: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
        redirect: "manual"
    };
    if (requestInit.body) {
        requestInit.duplex = "half";
    }

    const newRequest = new Request(targetUrl.toString(), requestInit);

    const response = await fetch(newRequest);

    const headersOut = new Headers(response.headers);
    const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
    const setCookies = getSetCookie
        ? getSetCookie()
        : response.headers.get("Set-Cookie")
            ? [response.headers.get("Set-Cookie") as string]
            : [];

    // Cloudflare Access on the API backend might return a `Set-Cookie:
    // CF_Authorization` because it processed the request. Forwarding that cookie
    // can overwrite the user's frontend Access session, but Porta's own
    // `porta_session` cookie must pass through for password auth.
    headersOut.delete("Set-Cookie");
    for (const cookie of setCookies) {
        if (!/^CF_Authorization=/i.test(cookie)) {
            headersOut.append("Set-Cookie", cookie);
        }
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headersOut,
    });
};
