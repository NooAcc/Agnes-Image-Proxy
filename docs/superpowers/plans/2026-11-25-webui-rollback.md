# WebUI Rollback Implementation Plan

> **For agentic workers:** Future implementation must use `superpowers:subagent-driven-development` or `superpowers:executing-plans`, only after a new explicit implementation request. Steps use checkbox (`- [ ]`) syntax for tracking. This document does not authorize execution.

**Goal:** Restore the WebUI from `7387e35^`, remove React SPA, and retain the current Go backend and later storage/delivery features.

**Architecture:** Restore historical TypeScript template modules under `frontend/web/`. A Node 24 native build renders separate console/login/setup HTML documents and externalizes scripts/styles into same-origin content-hashed assets; Go continues embedding `internal/webassets/dist`. Adapt browser contracts and initialization flow without changing backend contracts or redesigning the old UI.

**Tech Stack:** Go 1.26, Node 24 native TypeScript support, HTML/CSS/browser JavaScript, Node test runner, Playwright/axe as dev-only dependencies.

**Spec:** [`../specs/2026-11-25-webui-rollback-design.md`](../specs/2026-11-25-webui-rollback-design.md).

**Status:** Documents only. No implementation tasks are complete or running. Earlier baseline checks do not verify this proposed implementation.

## Global Constraints

- Do not modify persistence, image processing, authentication contracts, Compose deployment or public-origin behavior.
- Restore the design from `7387e35^`, including `--accent: #22c55e`, rather than designing a different UI.
- Keep executable scripts external and CSP `script-src 'self'`; allow existing DOM style attributes only through `style-src-attr 'unsafe-inline'`.
- Keep page routing allowlisted, unknown assets/API paths JSON 404, HEAD bodyless, sensitive pages no-store.
- Storage choice requires explicit user selection and is immutable after initialization. Never persist or echo frontend secrets outside required transient inputs and API requests; existing server persistence remains unchanged.
- Keep source files tracked, generated `internal/webassets/dist/` ignored, and `.codegraph/` untouched.
- Do not reset history, stage, commit, push or merge without separate authorization.
- Current authorization is spec/plan editing only: no implementation, agents, installs, tests, server or browser.

## Review Focus

- Cold unauthenticated visits and expired cookies must stop normal queries/polling and show login, while unrelated 403/503 errors remain visible and retryable.
- Direct page paths, historical hashes and returned destinations must select the right section without enabling open redirects.
- Current Go responses must not be interpreted as historical DTOs; unavailable data must not be fabricated.
- Storage conflicts, empty token updates and background refresh must preserve fixed modes, stored tokens and dirty forms.
- 375px dialogs/downloads/thumbnail failures and CSP must work with both themes and correct content types.

## Execution boundaries and dependency map

All tasks below are **future work** and execute sequentially: `1 → 2 → 3 → 4`. Task 4 completes release packaging, browser verification and documentation. No intermediate task is a release-ready rollback.

If subagents are later authorized, each implementer/reviewer inherits the single authorized worktree. Omit `Agent.isolation`; do not create an additional agent worktree or attempt to switch between them. A tool parameter validation failure must be corrected once from the actual schema; if still blocked, report it rather than repeat invalid calls. Do not bypass workspace/permission restrictions.

The visual baseline and current APIs are already known. Use historical `git show` for removed templates; use CodeGraph only if an index exists in the execution checkout. Do not re-index automatically.

### File ownership

| Unit | Owner / responsibility |
|---|---|
| `frontend/web/{icons,styles,theme,ui,login,console,runtime,gallery}.ts`, `frontend/web/sections/{accounts,logs,overview,settings}.ts` | Restored legacy templates and browser behaviors |
| `frontend/web/contracts.ts` | Small testable import/DTO/request adapters shared by browser code, no runtime library |
| `frontend/web/bootstrap.ts` | Session/storage readiness, safe destination and page lifecycle |
| `frontend/web/{setup,storage}.ts` | Explicit storage selection and read-only storage settings |
| `frontend/scripts/build.mjs` | Deterministic rendered HTML and external hashed assets |
| `internal/httpapi/assets.go`, `internal/webassets/assets.go` | Distinct document serving and unchanged embedded FS boundary |
| `frontend/tests/*.test.mjs`, `frontend/e2e/*.spec.ts` | Contract/build and real-browser regression tests |
| `Dockerfile`, `frontend/package*.json`, `.dockerignore`, `.gitignore`, `README.md` | Production build and accurate documented commands |

---

### Task 1: Restore legacy templates and native asset build

**Files:**
- Create: the 12 historical template modules listed in File ownership, under `frontend/web/` (excluding new contracts/bootstrap/setup/storage).
- Create: `frontend/scripts/build.mjs`, `frontend/tests/build.test.mjs`.
- Modify: `frontend/package.json`, `frontend/package-lock.json`.
- Remove after inspection: `frontend/src/`, `frontend/index.html`, `frontend/components.json`, `frontend/eslint.config.js`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/vitest.config.ts`, `frontend/scripts/check-colors.mjs`, `frontend/scripts/check-docker-layout.mjs`.
- Preserve for Task 4: `frontend/e2e/`, `frontend/playwright.config.ts`, `frontend/scripts/build-e2e.mjs`.

**Interfaces:**
- Historical exports retained: `renderAdminPage(): string`, `renderLoginPage(): string`, `BASE_STYLE: string`, `THEME_INIT_SCRIPT: string`, `RUNTIME_SCRIPT: string` and existing section HTML/script constants.
- Build exports `build(outputDir?: string): Promise<void>`; default output is repo-root `internal/webassets/dist`.
- Final build produces `index.html`, `login.html`, `setup.html` and `assets/<name>-<64-character-lowercase-sha256>.{js,css}`. Setup output joins when Task 3 adds `renderSetupPage()`; do not create a fake setup placeholder.
- Package commands: `build` → `node scripts/build.mjs`; `test` → `node --test tests/*.test.mjs`; `test:e2e` → build, existing Go build helper, Playwright. Production build requires no installed npm package.

- [ ] **1. Write failing build tests.** In temporary output dirs assert rendered console has all five `data-section` values, five desktop and five bottom nav links; CSS has the original accent and light-theme selectors; login has password form and no console sections. Assert rendered documents have external script/style references, not executable inline script/style blocks or remote dependencies. Check every referenced file exists and its hash matches actual bytes; parsing generated JS must not require eval.
- [ ] **2. Verify RED.** Run `node --test frontend/tests/build.test.mjs`; missing build/template imports must fail. Preserve the observed failure in the future task report.
- [ ] **3. Restore historical source.** Inspect tracked legacy paths with `git ls-tree -r --name-only 7387e35^ web`; restore only templates under the new prefix. Do not restore `lib/`, `main.ts`, Deno config or old backend tests.
- [ ] **4. Implement build.** Render pages, extract trusted template blocks with deterministic order, write hashed assets and rewrite references. Keep theme initialization blocking before stylesheet paint. Validate external references; reject malformed output and unknown/unsafe output roots before cleanup. Clean only the designated build output, never data/source/worktree roots.
- [ ] **5. Replace React package and configuration.** Remove runtime dependencies and React-specific dev dependencies; retain only Playwright/axe dev tooling. Inspect obsolete tracked files before removal; regenerate lockfile only after implementation is separately authorized. Keep browser test scenarios for adaptation, not silent deletion.
- [ ] **6. Verify GREEN.** Run native build tests and `npm --prefix frontend run build`; repeat build in temporary output to assert stable asset names/content. Add a test with an old stale asset and prove rebuild removes only stale output files while an unrelated sibling file survives.

### Task 2: Adapt page serving, bootstrap and all management contracts

**Files:**
- Modify: `internal/httpapi/assets.go`, `internal/httpapi/assets_test.go`, `internal/webassets/assets.go`.
- Create: `frontend/web/bootstrap.ts`, `frontend/web/contracts.ts`, `frontend/tests/contracts.test.mjs`, `frontend/tests/bootstrap.test.mjs`.
- Modify: restored runtime, console, login, gallery and four section modules.

**Interfaces:**
- `NewAssets(fsys fs.FS) http.Handler` unchanged. Known login/setup paths read their own documents; other known pages read `index.html`. `webassets.FS() (fs.FS,error)` unchanged.
- `window.Agnes.api(path, options)` keeps legacy signature, same-origin credentials and 204/error-envelope handling. Add readiness/lifecycle gating so all normal section queries and timers wait for session and storage checks.
- `parseAccountImport(text: string): {accounts: Array<{name:string,apiKey:string}>, lineNumbers:number[], errors:Array<{line:number,message:string}>}`: pure parser; no secrets in errors.
- `overviewRanges(day: string): {selected:{start:string,end:string}, trend:{start:string,end:string}}`: UTC day arithmetic.
- `safeAdminDestination(raw: string): string`: returns only allowlisted console path/hash; invalid/external/login/setup input falls back to `/admin#overview`.
- Browser adapters and bootstrap script constants are generated from the same tested functions or module source; tests must not implement duplicate mock versions of production logic.

- [ ] **1. Write Go routing failures.** Populate fstest FS with distinct `index.html/login.html/setup.html`. Assert correct selection for all existing page routes, trailing `/admin/`, bodyless page/asset HEAD, no-store, CSP, nosniff/frame protection; missing page document returns 500; unknown pages/APIs/missing files/traversal remain JSON errors. Run `go test ./internal/httpapi -run 'TestAssets'` and capture RED.
- [ ] **2. Implement page selection.** Generalize existing index serving to the selected document without broad fallback. Preserve HTTP/cache/security behaviors and update misleading SPA comments. Do not change router/auth APIs or image CSP.
- [ ] **3. Write adapter tests.** Cases: `a,k1\n\n b,k,2` parses two accounts and original line numbers `[1,3]`; invalid lines report original row without key; >1000 entries and >1 MiB serialized payload blocked. `overviewRanges('2026-11-25')` yields selected `2026-11-25` and trend start `2026-11-12`; test leap-day/month/year boundaries. Reject absolute URLs, protocol-relative paths, unknown pages and `javascript:` destinations.
- [ ] **4. Implement bootstrap with failing behavior tests.** Test request order session → storage → section, 401 stopping timers, initialization-required redirect, and 403/network/storage-unavailable showing retry instead of redirect. Known hash wins known path, invalid hash preserves known path. Hide unauthenticated shell until ready; keep theme immediate. Guard all legacy shell/settings requests as well as section refresh callbacks.
- [ ] **5. Adapt accounts and overview.** Consume current `{items}` responses, `{accounts}` import request and indexed errors, probe `message`; retain create/edit/delete/enable/reset. Overview fetches selected-day and 14-day ranges separately, maps `days`/`models[].model`, uses real healthy/cooling/disabled counts, and avoids unavailable last-used values. Pin request bodies and rendered counters with contract fixtures.
- [ ] **6. Adapt logs.** Use `{items,nextBefore}` with 50-item cursor paging, category omission for all; details/search use attempts and deliveryFailures, and explicit partial. Test a log with multiple attempts plus persist failure, new-page merge without duplicates, and log-clear not altering usage. Label search as loaded-items only.
- [ ] **7. Adapt gallery.** Use createdAt/nsfwTag/nsfwScores and `unclassified`; request 24-item pages. Remove unavailable metadata; authenticated thumbnail 404 may fallback once, other failures show errors. Downloads use `content?download=1`. Replace POST cursor loop with one background job start and cumulative GET status snapshots; handle recovery/409 and partial-clear refresh. Test cumulative processed values 3→5 display 5, not 8; no extra POST on page reload.
- [ ] **8. Adapt ordinary settings.** Remove defaultResponseFormat and stale unavailable-base64 copy; full PUT preserves all 14 spec fields and no extra fields. Test modified-one-field preserves remaining values, TTL boundaries 1/720 and invalid 0/721/fraction; background refresh must not overwrite dirty fields. Keep storage out of settings payload.
- [ ] **9. Verify affected tests.** Run Node tests and `go test ./internal/httpapi`; adapter tests must exercise production helpers and fixture shapes. Authentication/setup integration reaches final status only after Task 3/4 E2E; do not call Task 2 release-ready.

### Task 3: Restore storage initialization and fixed-mode settings in legacy style

**Files:**
- Create: `frontend/web/setup.ts`, `frontend/web/storage.ts`, `frontend/tests/storage.test.mjs`.
- Modify: `frontend/web/styles.ts`, `frontend/web/sections/settings.ts`, `frontend/web/console.ts`, `frontend/web/login.ts`, `frontend/web/bootstrap.ts`, `frontend/scripts/build.mjs`, `frontend/tests/build.test.mjs`.

**Interfaces:**
- `renderSetupPage(): string` produces old-style card with explicit local/imgbed radio selection and no default.
- `STORAGE_HTML: string`, `STORAGE_SCRIPT: string` integrate fixed-mode storage information into legacy settings.
- `storageInitPayload(mode: 'local'|'imgbed', baseUrl: string, token: string): object` and `storageUpdatePayload(baseUrl: string, token: string): object` are production helpers tested by native tests.
- Calls only existing GET/POST/PUT `/admin/api/storage`; no new backend endpoints or remote probes.

- [ ] **1. Write failing storage tests.** Assert local init contains only mode, imgbed init contains all three fields, empty update token is omitted, null is never sent; exact redacted status shapes drive readonly controls. Setup output has no default checked choice, submits disabled initially and no console section markup. Extend build test to require setup.html.
- [ ] **2. Verify RED.** Run `node --test frontend/tests/storage.test.mjs frontend/tests/build.test.mjs`; missing renderer/helpers must fail.
- [ ] **3. Implement setup page.** Reuse legacy login styles/card/brand/form language. Add explicit choice and irreversible-mode warning, conditional ImgBed inputs, token permission note, HTTPS-origin validation and submit lifecycle. 201 transitions only after confirmed state; 409 already_initialized refetches and respects actual mode. Do not claim remote connectivity was tested.
- [ ] **4. Implement storage settings.** Render mode readonly; local has no token control; imgbed has address, configured flag and empty update-token field. Separate save action; omit blank token, clear successful secret input, preserve dirty state during refresh. Explain address change does not migrate files. Handle not_initialized/storage_mode_fixed by refetch rather than retrying invalid writes.
- [ ] **5. Integrate document/build/readiness.** Emit setup.html, connect login/setup/console transitions, maintain safe destination and no unauthorized polling. Keep plain settings save and storage save independent; don't imply one atomic operation.
- [ ] **6. Verify GREEN.** Run all native tests and build. Browser keyboard/375px/real conflict tests are owned by Task 4; record that they remain unverified until then.

### Task 4: Browser regression coverage, deployment cleanup and final acceptance

**Files:**
- Modify: `frontend/e2e/helpers.ts`, `frontend/e2e/console.spec.ts`, `frontend/e2e/gallery.spec.ts`, `frontend/e2e/storage.spec.ts`, `frontend/e2e/accessibility.spec.ts`, `frontend/playwright.config.ts`, `frontend/scripts/build-e2e.mjs`.
- Create: `frontend/e2e/contracts.spec.ts`, `frontend/tests/deployment.test.mjs`.
- Modify: `Dockerfile`, `.dockerignore`, `.gitignore`, `README.md`, package scripts only if needed to match final documented commands.

**Interfaces:**
- Keep existing offline Go `preview` and e2e binary helper; browser uses system Chrome through Playwright.
- Tests use actual generated/embedded pages with Go preview; route mocking is limited to specific error/conflict cases absent from seeded preview.
- Docker frontend stage uses Node 24 to run the native build directly; copy resulting dist into unchanged Go build stage. No npm installation required for image's production asset build.

- [ ] **1. Write/adapt browser cases.** Replace React selectors with legacy roles/data attributes, not legacy UI with React-compatible markup. Cover invalid/valid login, direct gallery and hashes, expired session, safe destination, five sections, theme persistence, autoRefresh pause/resume and navigation with refresh disabled.
- [ ] **2. Cover current contract interactions.** Real preview account create/edit/enable/probe/reset/import/delete; empty/invalid imports; overview request ranges and counters; logs attempts/partial/delivery details/paging; gallery pagination/fallback/lightbox keyboard/download extension/delete. Use targeted mocked 401/503 and partial-clear failure to verify recovery and no infinite image retry.
- [ ] **3. Cover storage lifecycle.** Mock uninitialized state only where preview is preinitialized; test no implicit choice, keyboard radio selection, local/imgbed requests, 409 refetch, fixed-mode updates, blank token preservation and secret non-echo. Test dirty regular/storage forms survive refresh. No real graph upload/delete or production database calls.
- [ ] **4. Cover visual/accessibility behavior.** At desktop and 375px, both themes: navigation, settings/init, table scrolling and dialogs fit viewport. Run axe on login/setup and five sections, focus restoration/Escape and reduced-motion checks. Capture desktop/mobile screenshots, and fail normal paths on unexpected JS/CSP errors. Compare structure/tokens with old baseline; visual restoration still needs human confirmation.
- [ ] **5. Record browser RED/GREEN evidence.** Run focused Playwright cases before fixing each observed regression; fix only production files owned by preceding tasks as necessary, rerun covering cases. Document exact commands/output; do not claim a case ran if only authored.
- [ ] **6. Update deployment and docs.** Remove React/Vite build instructions and obsolete ignore entries, retaining build/data/secret ignores. Docker preserves Go image stage, UID/GID 65532, DATA_DIR/volume/healthcheck/entrypoint and later ownership fix. README documents native build/preview and optional dev-only dependency installation for E2E; no Vite server. Add deployment test checking absence of React/Vite dependencies and that Docker copies generated dist while unchanged runtime directives remain.
- [ ] **7. Run final verification.** Commands, only after future execution authorization:

```bash
npm --prefix frontend ci                  # dev-only browser testing dependencies
npm --prefix frontend run build
npm --prefix frontend test
npm --prefix frontend run test:e2e

gofmt -l internal cmd                    # expected: no paths
go vet ./...
go test -p 1 ./...                        # avoid known Windows temp cleanup concurrency flake
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o .build/agnes-proxy ./cmd/agnes-proxy
git diff --check
```

Expected: all commands exit 0, tests pass; report any known environmental failure explicitly, not as success. Docker build is optional only if Docker is available; absence must be disclosed.

- [ ] **8. Final independent review, if separately authorized.** One reviewer reads full diff plus spec; no new agent worktree, no duplicate implementation. Verify current API adapters, startup ordering, security, dirty-state preservation and unchanged backend/deployment boundaries. Address verified findings and rerun affected tests. Preserve report and uncommitted changes; do not automatically delete the worktree.
- [ ] **9. User browser acceptance, only after all implementation work.** Start offline preview at an available loopback port, open browser as previously requested, provide URL and `preview` key; show restored desktop/mobile/theme screenshots and leave preview available for inspection. No auto-login secrets in URL. Browser acceptance is not a commit/merge/publish authorization. This step is not authorized by the present documentation-only request.

## Plan self-review

- **Coverage:** spec §§3–4 → Task1; §§5–6/8 → Task2; §7 → Task3; §§9–10 → Task4.
- **Interfaces:** build supplies FS consumed by Go; session/readiness precedes legacy queries; setup is explicitly deferred until its renderer exists; full settings and storage payloads remain separate.
- **Dependency corrections:** moved deployment/docs and final browser verification to the final task; no intermediate fake setup page; E2E infrastructure remains until replacement coverage exists.
- **Review focus:** cold/deep-link/error cases in Task2/4; adapter fixtures and unavailable fields in Task2; storage conflicts/dirty state in Task3/4; mobile/download/CSP in Task4.
- **Current state:** no tasks marked complete, no new implementation/test evidence, no execution started. Spec and plan completion alone does not restore WebUI.
