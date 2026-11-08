# `agent-sdlc-kit` — Deterministic Agent SDLC Toolkit

Portable Antigravity CLI (`agy`) plugin enforcing a deterministic-first software delivery pipeline:
- **One-Verb Skills (`bv <verb>`)**: Every repeatable action is a single deterministic script emitting `<= 40` lines of structured JSON and caching results by working-tree OID (`GIT_INDEX_FILE=.bv/tmp.index git write-tree`).
- **Deterministic-First Execution**: Intake, AST Slicing, Static Review (`oxlint` + `ast-grep`), Verification, Proof Capture, and Shipping execute with **0 LLM tokens**. LLMs are invoked only for `RED` (`qa`) and `CODE` (`coder`) phases by default.
- **Hook-Enforced Security & Role Locks (`hooks.json`)**:
  - **Always-On Security Denies**: Blocks `ssh`, `mysql`, `pm2`, `sudo`, `printenv`, `env`, `infisical secrets`, `~/.bv-admin-env`, and `.env*` reads/writes (except `.env.schema`) across every chat and session.
  - **Active SDLC Guards**: Blocks whole-file reads `> 200` lines, blocks duplicate reads of unchanged file ranges, enforces strict path locks (`qa` only edits tests; `coder` only edits `apps/**` & `packages/**` and cannot touch locked `RED` tests), and prevents premature turn stops when phase exit conditions are unmet.
- **True TDD (`RED` → `CODE`)**: `bv write-red` requires the new test to fail and locks its git blob hash in `.bv/state/ISSUE-<n>.json`. `bv gate-green` refuses to run without a recorded `RED` state or if any locked test blob was modified.
- **Zero `.env` Secrets**: Only `.env.schema` (Varlock type schema) is permitted on disk or in git. Runtime secrets flow exclusively through Infisical.

## Plugin Layout (Antigravity Native Plugin)
- `plugin.json` — Plugin manifest at root
- `hooks.json` — Lifecycle hooks at root (`SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`)
- `bin/bv` & `lib/` — Zero-dependency Node CLI & AST/hook engines
- `rules/ast-grep/` — Architectural & TypeScript AST rules
- `agents/` — Isolated subagent definitions (`inheritCustomizations: false`, `excludeDefaultComponents: true`, `inheritMcp: false`)
- `templates/` — `sdlc.config.json` and JSON output schemas
- `tests/hooks.test.mjs` — Automated hook & TDD enforcement unit test suite

## Per-Repo Adoption
1. Install the kit **once** as a plugin (hooks, skills and agents come from the plugin only). For kit development, symlink the plugin dir to your checkout: `ln -s <checkout> ~/.gemini/config/plugins/agent-sdlc-kit`.
2. In each project run `bv init` (idempotent; writes only `.agents/sdlc.config.json`, `.bv/{state,packets,logs}` and a `.bv/` `.gitignore` entry; `--force` replaces the config). It refuses if a local `.agents/hooks.json` registers the kit (`--allow-local-hooks` to override).
3. Run `bv doctor`: it fails if the kit is registered more than once (double hook firing) and warns on `.agents/{agents,skills}` files that shadow the kit's.
4. Run `bv run-issue <n>` (or step through `bv start-issue <n>`, `bv set-phase`, `bv verify`, `bv ship`).

## Living Domain Suites & Issue Script Lifecycle
- **3-Phase Issue Script Lifecycle**:
  - `RED` phase: Temporal acceptance script (`verify-issue-<N>.test.mjs`) authored and locked.
  - `CODE` phase: Implementation satisfies acceptance test; core domain invariants are promoted into living domain test suites (`apps/backend/src/**/*.spec.ts`).
  - `SHIP` / post-merge: Script archival and retirement from the active verification matrix.
- **Living Test Suite Taxonomy**:
  - **Category A (Living Domain Truth)**: Permanent active domain assertions executed on every verify pass.
  - **Category B (SUPERSEDED / Retired)**: Historical scripts overridden by newer product specifications (e.g., `verify-issue-055.test.mjs`), excluded from active verification via `SUPERSEDED_TEST_SCRIPTS` to eliminate mock shims.
  - **Category C (Integration / Smoke)**: Standalone integration and runtime emulator tests.
