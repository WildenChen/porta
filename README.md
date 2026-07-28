# Porta

[![CI](https://github.com/WildenChen/porta/actions/workflows/ci.yml/badge.svg)](https://github.com/WildenChen/porta/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.13.0%2Bwilden.05-green)

Remote web interface for [Antigravity](https://antigravity.google/) Agent Manager.
Access your local Antigravity sessions from your phone, tablet, or any remote browser through a lightweight LSP bridge.

Current Wilden build: **0.13.0+wilden.05**. Based on upstream **0.13.0**.

Porta is a two-part system: a **proxy** that bridges your local Antigravity Language Server to the network, and a **web UI** (installable PWA) that gives you a mobile-friendly chat interface.

<p align="center">
  <img src="docs/screenshot.png" alt="Porta — desktop and mobile" width="720">
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Porta mobile demo" width="360">
</p>

## Quick start

**Prerequisites**: **[Node.js](https://nodejs.org/) ≥ 22**, **[pnpm](https://pnpm.io/) ≥ 10**, and a running
[Antigravity](https://antigravity.google/) instance.

> **Warning:** Porta is a bridge to Antigravity. If Antigravity is not
> running, the proxy will start but cannot connect to any session.

```bash
git clone https://github.com/WildenChen/porta.git
cd porta
pnpm install
cp .env.example .env   # edit if needed — see comments inside
pnpm dev               # proxy (:3170) + web (:3070)
```

Open `http://localhost:3070` in your browser.

### Password authentication

Porta supports a lightweight single-administrator password mode. It does not
create user accounts, registration, password reset, RBAC, OAuth, OIDC, or
database-backed users.

Authentication is disabled by default. For a first LAN install, start Porta,
open the existing Settings page, and enable Password mode before removing any
outer protection such as Authentik.

The Settings page exposes:

- `Disabled`
- `Password`
- session duration (`7 days`)
- current protection status

When enabling Password mode from Settings, Porta stores a password verifier in
server-side runtime config and immediately rotates session signing material.
Existing unauthenticated access is cleared and the browser is sent back to the
login page. Password changes also rotate session signing material so existing
sessions stop working.

First-time Password mode enablement is intentionally limited to a request from
the local Porta host. Public unauthenticated visitors cannot claim or overwrite
the first password. Do not remove Authentik, DNS, reverse-proxy, or other outer
controls until built-in Porta password login, logout, API access, and WebSocket
access have been verified.

Runtime auth configuration is stored outside the repository by default:

```bash
~/.porta/auth.json
```

Set `PORTA_DATA_DIR` to use a different runtime data directory. The config file
is written atomically with current-user-only permissions and never stores the
plain-text password.

Environment variables remain supported only as bootstrap fallback:

```bash
PORTA_AUTH_MODE=disabled
# or, when no runtime config exists:
PORTA_AUTH_MODE=password
# provide PORTA_PASSWORD from your shell or secret manager
```

Priority order:

1. Existing runtime auth config wins.
2. If no runtime config exists, `PORTA_AUTH_MODE=password` plus
   `PORTA_PASSWORD` bootstraps a verifier into runtime config.
3. If no runtime config exists and `PORTA_AUTH_MODE` is unset or `disabled`,
   Porta starts in Disabled mode.
4. Unsupported `PORTA_AUTH_MODE` values still fail fast at proxy startup.

In password mode, all Porta API and WebSocket requests require a signed
HttpOnly session cookie. The password is validated only by the local proxy and
is never exposed to the frontend. Sessions use a seven-day persistent cookie
with `SameSite=Lax`; logout clears the browser cookie immediately. Sessions
survive proxy restarts as long as runtime config remains intact.

For deployments behind HTTPS reverse proxies, forward `X-Forwarded-Proto:
https` so Porta can mark login cookies as secure. Local HTTP development keeps
cookies usable on `localhost`.

The static SPA shell is public by design. Unauthenticated browsers can retrieve
`index.html`, compiled JavaScript and CSS bundles, icons, the web manifest, the
service worker, and other non-sensitive static assets. Sensitive data remains
behind authenticated API and WebSocket requests; do not place secrets,
credentials, private runtime configuration, or environment-specific material in
frontend source or public assets.

### LAN access

To access from another device on your home network:

```bash
# Set PORTA_HOST to this machine's LAN IP in .env
PORTA_HOST=192.168.1.23
```

Devices on the same network can reach the proxy at `http://192.168.1.23:3170`.  
Wildcard binds (`0.0.0.0`, `::`) are rejected by default and require `PORTA_ALLOW_WILDCARD=1`. Public IPs are rejected at startup for safety.

> **Note:** to also access the Vite dev UI from LAN, start it with `--host`:
>
> ```bash
> pnpm --filter @porta/web dev -- --host
> ```

When exposing the web UI beyond localhost, enable Password mode from Settings
and serve Porta through HTTPS or a trusted authenticated reverse proxy.

### Version convention

This fork tracks the upstream release plus a local build suffix:

- Upstream base: `0.13.0`
- Wilden build: `0.13.0+wilden.05`

The root `package.json` version is the release source of truth. The web build
injects that version, derives the upstream base from the part before `+`, and
injects a short Git commit SHA when build-time Git metadata is available. If a
production build has no `.git` directory and no injected SHA, the UI displays
`unknown` for the commit.

## Why Porta?

There are several ways to access a local development environment
remotely. Here's how Porta compares:

| Approach                              | Data sent           | Bandwidth      | Latency                   | Mobile UX                    | Self-hosted |
| ------------------------------------- | ------------------- | -------------- | ------------------------- | ---------------------------- | ----------- |
| **Screen sharing** (VNC, RDP, Parsec) | Pixel stream        | High           | Noticeable                | Poor: tiny text, no touch UX | ✅          |
| **SSH + port forwarding**             | Raw TCP             | Low            | Low                       | No UI: terminal only         | ✅          |
| **Cloud IDE** (Codespaces, Gitpod)    | Full workspace      | N/A (cloud)    | Varies                    | Usable but heavy             | ❌          |
| **Porta**                             | Structured LSP data | **Negligible** | **Real-time** (WebSocket) | **Native PWA**               | ✅          |

Porta doesn't stream pixels or run your workspace in the cloud. It
relays structured conversation data through the Antigravity Language
Server Protocol, so you get:

- **Near-zero bandwidth**: JSON messages, not video frames
- **Real-time streaming**: WebSocket push, no polling lag
- **Native mobile experience**: [installable PWA](docs/pwa.md) with touch-optimized UI
- **Full privacy**: your code and conversations never leave your machine
- **No vendor lock-in**: self-hosted, MIT-licensed, works with any Antigravity installation

## Limitations

Porta is a **chat interface**, not a full remote IDE. These
constraints are inherent to its LSP-bridge architecture:

- **Antigravity must be running**: Porta is a bridge, not a
  standalone tool. No Antigravity instance → no data.
- **Bounded by Antigravity**: Porta can only expose what the
  Antigravity Language Server provides. If Antigravity doesn't support
  a feature, Porta can't offer it either.
- **No code editing or terminal**: Porta relays conversation-level
  data only. Use your local editor or SSH for file operations.
- **Single user**: The proxy connects to one local Antigravity
  Language Server. There is no multi-user or multi-tenant model.

### Platform support

| Tier       | Platform    | Status                                               |
| ---------- | ----------- | ---------------------------------------------------- |
| **Tier 1** | Linux (x64) | Developed and tested on real hardware                |
| **Tier 2** | Windows     | Tested on real hardware; less extensively than Linux |
| **Tier 3** | macOS       | CI passes; no real-hardware testing by maintainers   |

> Porta's proxy must run on the **same side** as Antigravity. If
> Antigravity runs on your Windows host, run Porta from PowerShell / cmd,
> **not** from inside WSL2. Conversely, if Antigravity runs inside WSL2,
> run Porta from WSL2, **not** from Windows. The two environments cannot
> see each other's processes.

When running the proxy in a container that does not expose standard Docker,
Podman, Kubernetes, or containerd markers, set `PORTA_CONTAINER=1` so the proxy
skips host PID checks and relies on network probing.

## Remote access with Cloudflare

```mermaid
flowchart LR
  Browser

  subgraph CF ["Cloudflare (optional)"]
    Pages["Pages(static SPA)"]
    Tunnel
    ZT["Zero Trust"]
  end

  subgraph Local ["Your machine"]
    Proxy["Proxy(:3170)"]
    LS["Antigravity LS"]
  end

  Browser -- HTTPS --> Pages --> ZT --> Tunnel --> Proxy --> LS
  Browser -. local .-> Proxy
```

- **Local-only mode** (Quick start above): Browser → Proxy → LS. No cloud services needed.
- **Remote mode**: Cloudflare Pages + Tunnel + Zero Trust for secure remote access without exposing your network.

Cloudflare can be used in two different ways:

### Option A: Quick Tunnel (temporary testing)

If you only want to try Porta remotely and do not need a stable hostname, use a
Cloudflare Quick Tunnel.

- No custom domain required
- Best for demos and short-lived testing
- Not recommended for ongoing use: the hostname is temporary, and Cloudflare documents Quick Tunnels as testing-only infrastructure

To avoid stale copy-pasted instructions, follow Cloudflare's current docs:

- [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/setup/)

Use a named tunnel instead if you want a stable `VITE_API_BASE`, a fixed Cloudflare
Pages deployment, or long-lived remote access.

### Option B: Named tunnel + Pages (recommended for regular remote use)

This is the stable pattern for ongoing remote access. It requires:

- A **Cloudflare** account
- **Cloudflare Tunnel** (`cloudflared`) installed and authenticated
- A **Cloudflare Pages** project (for hosting the static SPA)
- A domain managed by **Cloudflare** for the tunnel hostname
- Optionally, **Cloudflare Zero Trust** for authentication

### 1. Configure `.env`

Set the proxy runtime and Cloudflare-related variables in `.env`:

```bash
# .env
PORTA_AUTH_MODE=password
# PORTA_PASSWORD is only needed for environment bootstrap.
# Prefer enabling Password mode from Settings.
PORTA_CORS_ORIGINS=https://<YOUR_PAGES_DOMAIN>
PORTA_TUNNEL_NAME=<YOUR_TUNNEL_NAME>
PORTA_CF_PROJECT=<YOUR_PROJECT_NAME>
```

### 2. Create the named tunnel

Point the tunnel at your local proxy:

```bash
cloudflared tunnel create <YOUR_TUNNEL_NAME>
cloudflared tunnel route dns <YOUR_TUNNEL_NAME> <YOUR_API_SUBDOMAIN>
```

### 3. Create `.env.production`

Create `.env.production` in the repo root for the web build:

```bash
# .env.production
VITE_API_BASE=https://<YOUR_API_SUBDOMAIN>
# Optional when hosting the web UI below a path such as https://example.com/porta/
PORTA_BASE_PATH=/porta
```

### 4. Build and deploy the SPA

```bash
pnpm deploy
```

This uses `PORTA_CF_PROJECT` from `.env`. If you prefer, you can run the
equivalent `wrangler pages deploy` command manually.

### 5. Start the proxy + named tunnel

```bash
pnpm dev:cloud
```

This reads `PORTA_TUNNEL_NAME` from `.env` and starts the proxy and
`cloudflared tunnel run` together.

### 6. Securing your API with Cloudflare Access (Zero Trust)

Exposing your local API to the public internet can be dangerous. To completely lock down your setup, you should protect **both** your frontend and your API using Cloudflare Access. 

Porta's built-in Edge Proxy securely bridges the two by injecting Machine-to-Machine authentication tokens, completely hiding your backend from the internet.

To set this up, follow these precise steps:

**1. Create Two Separate Applications**
- **Frontend App**: Protects your Pages deployment (e.g., `https://<YOUR_PAGES_DOMAIN>`). Configure this with standard user login policies (e.g., email OTP).
- **Backend API App**: Protects your Tunnel (e.g., `https://<YOUR_API_SUBDOMAIN>`). 

**2. Generate a Service Token**
In **Access > Service Auth**, create a new Service Token (e.g., "Porta Pages Bridge"). Copy its `Client ID` and `Client Secret`.

**3. Configure Backend Policy**
For the Backend API App, add a policy with:
- **Action**: `Service Auth`
- **Include**: `Service Token` -> select the token created above.

**4. Set Environment Variables in Cloudflare Pages**
In your Pages project **Settings > Environment Variables**, add the following secrets for both Production and Preview environments:
- `CF_ACCESS_CLIENT_ID`: The Client ID of the service token.
- `CF_ACCESS_CLIENT_SECRET`: The Client Secret of the service token.
- `PORTA_API_ORIGIN`: The full URL of your backend Tunnel (e.g., `https://api-porta.example.com`).

**5. Deploy the Pages Function**
The repository includes a `functions/api/[[path]].ts` Cloudflare Pages Function that acts as a secure reverse proxy. When you run `pnpm deploy`, it automatically gets deployed.
The frontend will automatically send all API requests to `/api/...` on its own domain. The Pages Function intercepts these requests, injects the service token headers, and forwards them to your backend Tunnel.
This architecture ensures your credentials are never exposed to the browser.

## Tailscale

For private access without exposing Porta publicly, you can also use Tailscale.

```bash
pnpm dev:tailscale
```

This starts the proxy on your configured Tailscale address and keeps the web UI
available through the same private network path.

## Development

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch and pull-request conventions.

## License

[MIT](LICENSE)
