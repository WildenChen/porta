# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.14.0+wilden.01] - 2026-07-28

### Added

- Integrated upstream 0.14.0's optional Vite access gate for public reverse-proxy or tunnel deployments while preserving the Wilden build's built-in password authentication.
- Added fail-closed protection for pages, API requests, and WebSocket upgrades when `PORTA_REQUIRE_AUTH` is enabled.
- Added strict web-server port handling and normalized allowed-host parsing.

### Security

- Updated `@hono/node-server` to `^2.0.10`, Hono to `^4.12.27`, and `serialize-javascript` to `^7.0.7` in line with upstream security updates.

### Changed

- Updated the Wilden build baseline from upstream 0.13.0 to upstream 0.14.0.
- Kept the upstream Windows watchdog recipe out of the active macOS deployment path; it remains available on the pure upstream-tracking `develop` branch.

## [0.13.0+wilden.04] - 2026-07-24

### Fixed

- Resolve and pass `projectId` from Antigravity config (`~/.gemini/config/projects/*.json`) when starting a cascade, preventing sessions created in Porta from showing up as "Outside of Project" / 獨立對話 in Antigravity Desktop.

## [0.13.0+wilden.03] - 2026-07-22

### Added

- Remember the last used project across reloads and login sessions.
- Configurable default project in Settings with Last used and fixed workspace
  options.

### Fixed

- Root navigation safely falls back to the last used or first available
  workspace when a fixed project is unavailable.

## [0.13.0+wilden.02] - 2026-07-22

### Added

- Settings page controls for enabling, changing, and disabling the built-in
  single-administrator Password Authentication mode.
- Server-side runtime auth configuration with scrypt password verifiers,
  atomic writes, and current-user-only file permissions.
- Auth settings API exposing mode, session duration, status, and password
  policy without returning password verifiers or signing material.

### Security

- Existing sessions are invalidated when password settings change.
- First-time password configuration is limited to the local Porta host.
