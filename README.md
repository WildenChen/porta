# Porta

[![CI](https://github.com/WildenChen/porta/actions/workflows/ci.yml/badge.svg)](https://github.com/WildenChen/porta/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.14.0%2Bwilden.01-green)

Remote web interface for [Antigravity](https://antigravity.google/) Agent Manager.
Access your local Antigravity sessions from your phone, tablet, or any remote browser through a lightweight LSP bridge.

Current Wilden build: **0.14.0+wilden.01**. Based on upstream **0.14.0**.

Porta is a two-part system: a **proxy** that discovers and routes across local Antigravity Language Server instances, and a **web UI** (installable PWA) that gives you a mobile-friendly chat interface.

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
PORTA_AUTH_MODE=password
PORTA_PASSWORD=<bootstrap-password>
```

### Optional outer access gate

Upstream 0.14.0 adds a separate Vite access gate for deployments that expose the
web development server through a public reverse proxy or tunnel. It protects the
page, `/api`, and WebSocket upgrades before Porta's built-in password login.

It is disabled by default and is not required for local or ordinary LAN use:

```bash
PORTA_REQUIRE_AUTH=1
PORTA_ACCESS_TOKEN=<at-least-32-random-characters>
PORTA_ALLOWED_HOSTS=porta.example.com
PORTA_CORS_ORIGINS=https://porta.example.com
```

Visit `https://porta.example.com/?access_token=<token>` once to set the secure
HttpOnly cookie. This outer token gate complements rather than replaces the
built-in password mode or an edge service such as Cloudflare Access.

### Project association

When creating a conversation, Porta matches the selected workspace against the
Antigravity project metadata under `~/.gemini/config/projects/*.json`. A matched
workspace is created in the same Antigravity project; an unmatched workspace is
shown with an Outside of Project warning before the conversation starts.

Legacy and disk-only conversations can temporarily use a derived project
association until their full Language Server metadata is loaded. Use **Refresh
project metadata** in the workspace selector after changing Antigravity project
folders or names.

## Architecture and limitations

Porta discovers multiple Antigravity Language Server instances, including
workspace-scoped and hub-style instances, and routes conversation operations to
the appropriate instance. Conversations remain Antigravity trajectories rather
than being copied into a separate Porta database.

The Wilden build is intended for one trusted administrator. Password mode and
the optional access token do not implement multi-user isolation, per-user
permissions, or tenant separation.
