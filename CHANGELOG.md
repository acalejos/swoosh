# Changelog

All notable changes to the swoosh packages (`@swoosh-dev/*`). The five packages
are versioned and released in lockstep.

## 0.1.2 — 2026-06-16

### Fixed

- **Package resolution under Vite / Vitest.** Removed the `"development"` export
  condition from every package's `exports` map. It pointed at `./src`, which is
  not included in the published npm tarball (only `./dist` ships). Vite and
  Vitest activate the `development` condition in dev/test mode, so any external
  consumer importing a `@swoosh-dev/*` package under Vitest failed with
  `Failed to resolve entry for package` / `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  Node's runtime resolver and Vite **production** builds were never affected
  (they resolve `default` → `dist`); this only bit dev/test tooling. Internal
  monorepo development is unchanged — cross-package imports resolve through
  tsconfig `paths` to source, not through this export condition. Affects all
  five packages (`router`, `ai-sdk`, `capabilities`, `judge`, `sdk`).

## 0.1.1 — 2026-06-14

- Initial public release of `@swoosh-dev/router`, `@swoosh-dev/ai-sdk`,
  `@swoosh-dev/capabilities`, `@swoosh-dev/judge`, and `@swoosh-dev/sdk`
  (provenance-signed; fixes the `workspace:*` protocol leak from 0.1.0).
