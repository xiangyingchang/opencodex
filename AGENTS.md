# AGENTS.md

Guidance for AI agents and humans working on or reviewing this repository.

## Project and file scope

opencodex (`ocx`) is a Bun-native TypeScript provider proxy for Codex and Claude
Code. It supports multiple upstream providers without a separate server compile
step.

- `src/` — proxy runtime, routing, adapters, configuration, and management API.
- `tests/` — Bun tests; shared fixtures are in `tests/helpers/`.
- `gui/` — React + Vite dashboard; `gui/dist/` is generated.
- `docs-site/` — Astro + Starlight public documentation.
- `scripts/` — release and maintenance tooling; `scripts/release.ts` is the
  release authority.
- `structure/` — architecture invariants; read the relevant document before
  changing a shared subsystem.
- `devlog/` — tracked planning and investigation records.
- `go/` — retired native-runtime experiment; do not add new work there.

Read the nearest nested `AGENTS.md` before changing files in `src/`, `gui/`,
`docs-site/`, `scripts/`, or `.github/`. The nested file adds scope-specific
rules; this file remains the repository-wide baseline.

## Optional subsystems stay off the core path

`src/lab/` (Compatibility Lab) is opt-in. A one-provider, one-model request
without a routing profile or Lab must not execute Lab code or start a Lab timer.
These core-path files must not reach `src/lab/`, directly or transitively:

- `src/router.ts`
- `src/server/lifecycle.ts`
- `src/server/responses/core.ts`

`tests/core-lab-boundary.test.ts` enforces the import-graph boundary. Optional
features register through the core-owned seams
`src/server/passive-route-linker.ts`,
`src/routing/compatibility/provider-slot.ts`, and
`src/lib/optional-shutdown-hooks.ts`; do not import them into the core path.

`src/server/index.ts` is the composition-root exception. Keep Lab activation
behind `labActivationRequired` and synchronous. The design and audit record is
`devlog/_fin/260814_lab_core_decoupling/`.

## Public devlog and security material

`devlog/` is ordinary tracked documentation, not a submodule or private mirror:

- `devlog/_plan/` — open units and planning evidence.
- `devlog/_fin/` — closed units whose outcome is already public.
- `devlog/_chase/` — gitignored third-party reference clones for parity work.

The runtime does not read `devlog/`; `privacy:scan` deliberately does. Keep
repository hygiene intact: `tests/repo-hygiene.test.ts` forbids tracked gitlinks,
vendored reference clones, and previously excised security triage.

Unreleased security findings, severity assessments, exploit or bypass reasoning,
reproduction steps for unfixed defects, and pre-disclosure plans belong only in
gitignored `.tmp/` or a `mktemp -d` directory. Never put them in `devlog/`,
`structure/`, `docs-site/`, or another repository. After disclosure, publish only
the fix, regression test, release note, or public advisory; then record the
closed outcome in `_fin/`. If a task asks for a security write-up, use scratch
space and state its location.

## User-consent actions

Never perform or auto-answer actions that spend the user's identity, credits,
reputation, or external account state. GitHub starring is the current example.
The operating-agent rule is in [`AGENTS_INSTALL.md`](./AGENTS_INSTALL.md), and
the development enforcement is covered by the code and tests around
`src/cli/agent-driven.ts`, `src/cli/star-prompt.ts`, and
`src/server/management/sidebar-routes.ts`. New identity-spending actions need
the same gate and must be documented in `AGENTS_INSTALL.md`.

The dashboard-session check is a casual-path guard, not a technical barrier
against a determined local process running as the user. The consent rule still
binds regardless of which local mechanism is reachable.

## Commands and validation

```bash
bun install
bun run typecheck      # bun x tsc --noEmit (strict)
bun run test           # full tests/ suite
bun run lint:gui       # GUI eslint
bun run privacy:scan   # credential/privacy scan used by CI
bun run build:gui      # Vite GUI build
```

During implementation, run the smallest focused checks for the changed
subsystem. Expand to full `bun run typecheck` and `bun run test` when shared
runtime, routing, configuration, server behavior is affected, a focused check
fails or is ambiguous, the user asks for full validation, or a non-trivial PR
is being marked review-ready. Do not rerun passing checks on unchanged code.

## Issues and pull requests

Agent-created issues use the template chooser and retain the generated headings:
`bug_report.yml`, `feature_request.yml`, `documentation.yml`, or
`provider_compatibility.yml`. Blank issues are disabled.

PRs fill `Summary`, `Verification`, and `Checklist` in
`.github/PULL_REQUEST_TEMPLATE.md`. A PR mentioning `gui` in its title or body
includes a UI screenshot; issue fixes add `Closes #<number>`. PRs target `dev`,
so linked issues do not auto-close until a PR reaches `main`.

## Branch and release policy

- `dev` is the integration branch and default PR target.
- `main` moves only through maintainer-controlled promotion from `dev` for
  releases and docs deployments; do not open feature PRs against it.
- `preview` is the prerelease train (`x.y.z-preview.*`).

Bun-native TypeScript on `dev` is the only runtime line. If native code returns,
land an incremental module rather than a second full runtime. A stacked child PR
may target an open parent PR head; retarget it to `dev` after the parent lands or
closes. Rebase work is ordinary maintenance and should name its source commits.

`enforce-target` owns the ancestry, description, screenshot, draft, and
review-readiness gates: contributor PRs remain draft until the required local-CI,
latest-`dev`, finding-resolution, and ready-for-review boxes are complete; a new
push resets the exact-commit readiness state. [`MAINTAINERS.md`](./MAINTAINERS.md)
is authoritative for approvals, CI, security review, promotion, and release
policy.

## Review guidelines

These apply to Codex, CodeRabbit, and human reviews:

- Review in English; name the file and line, concrete failure mode, and fix.
- Flag PRs targeting anything other than `dev`, except releases or promotions.
- Treat authentication, credentials/tokens, OAuth, GitHub Actions, release
  automation, and dependency installation as security-boundary changes requiring
  explicit review. Token exposure, workflow permission escalation, and mutable
  third-party action refs are release blockers.
- Enforce Bun-native runtime constraints and focused tests near changed `src/`
  behavior; shared routing, adapter, config, or server changes need the full
  suite.
- Sync user-visible behavior to `docs-site/` and keep translations consistent.
- Keep `bun run privacy:scan` green; never log request bodies, API keys, account
  identifiers, or other private data.
