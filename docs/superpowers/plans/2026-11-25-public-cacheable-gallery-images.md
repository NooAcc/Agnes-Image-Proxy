# Public Cacheable Gallery Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 相册原图与缩略图使用带文件后缀的公开图片 URL，使按后缀匹配的 CDN 可以缓存图片；ImgBed 原图由浏览器直接访问图床。

**Architecture:** 相册列表增加 `imageUrl` 和 `thumbnailUrl`。本地原图与所有本地缩略图由独立于 `/admin/api/` 的公开资源路由提供，成功响应允许缓存；ImgBed 原图 URL 根据当前图床地址和已存储的 `original_ref` 构造。前端直接设置 `<img src>`，不再获取 Blob。

**Tech Stack:** Existing Go HTTP router, database/sql store, ImgBed client/path validation, TypeScript-generated vanilla WebUI, Node tests and Playwright.

**Spec:** 本次对话中用户批准的修改范围：本地原图使用带真实后缀的公开 URL；ImgBed 直接使用已存储原图的公开 URL；缩略图同样公开并移除 Blob 展示；管理 API 保留登录保护和 no-store；生成 API 签名链接行为不变。用户接受公开访问以及删除后的 CDN 缓存残留。

## Global Constraints

- 文件后缀依据实际 MIME：PNG `.png`、JPEG `.jpg`、WebP `.webp`；不能靠查询参数伪装后缀。
- URL 使用已有随机 public ID，不能使用可枚举的相册数字 ID。
- 不改数据库 schema，不改变上传、原图保存、删除、生成交付或签名验证协议。
- `/admin/api/` 继续鉴权并 `Cache-Control: no-store`，旧 content/thumbnail/download 接口保持兼容。
- 本地公开成功响应采用 `Cache-Control: public, max-age=31536000, immutable`；错误响应 `no-store`，无 Set-Cookie。
- 不修改用户 CDN 配置；图床直链缓存策略由图床/CDN 决定，程序不能修改其响应头。
- 不提交、不推送；本次仅创建计划，实施前确认执行方式。

## Review Focus

- ImgBed 地址更新后，已有图片直链必须使用新地址，不能缓存旧域名，也不能泄露 token。
- 公开 URL 拒绝穿越路径、数字 ID、错误 MIME 后缀、已替换缩略图版本及不存在的资源。
- 缩略图被重新补齐或本地备份恢复后，不得让相同 immutable URL 返回不同图片内容。
- 浏览器 CSP 必须允许 HTTPS 图床图片；缩略图或原图失败不得无限重试。
- 公开资源新增后，管理 API 仍要求登录，生成 API 的签名过期检查仍有效。

---

### Task 1: Build gallery resource URLs from stored metadata

**Files:**
- Modify: `internal/domain/gallery.go`
- Create: `internal/store/gallery_resources.go`
- Modify: `internal/store/gallery.go` (ListGallery / scanGalleryItem)
- Modify: `internal/imgbed/paths.go`
- Test: `internal/store/gallery_resources_test.go`, `internal/imgbed/paths_test.go`
- Modify: `internal/httpapi/testdata/admin-contracts.json`, `docs/api/admin.openapi.yaml`

**Interfaces:**
- Extend `domain.GalleryItem` with `ImageURL *string json:"imageUrl"` and `ThumbnailURL *string json:"thumbnailUrl"` (null when unavailable; no omitempty).
- Add `imgbed.PublicFileURL(baseURL, ref string) (string, error)`: normalize/validate the base origin and reuse segment-escaped `fileURL(baseURL, "file", ref)`; never include a token.
- Local URLs: `/images/<publicID>/original.<ext>`; thumbnails: `/images/<publicID>/<basename of current thumb_path>` (existing random `thumb-<version>.<ext>`).
- `ListGallery` continues returning `domain.Page[domain.GalleryItem]`, with URLs generated from validated original/thumbnail metadata and one shared storage configuration snapshot, with no filesystem probe or ImgBed HTTP request per item.

- [x] **Step 1: Write failing metadata/URL tests.**
  - `TestGalleryResourceURLsLocal`: saved PNG/JPEG/WebP have matching `imageUrl` suffixes and random public ID paths, not numeric IDs; metadata-only items have null URLs.
  - `TestGalleryResourceURLsImgbed`: `imageUrl` equals configured HTTPS origin + `/file/` + escaped saved ref, differs from upstream `sourceUrl`, contains no token; after storage address update the same row uses the new origin; list performs zero remote GET/HEAD requests.
  - `TestGalleryThumbnailURLVersion`: available thumbnails have random versioned URLs; re-enrichment changes the URL; absent/invalid metadata yields null.
  - `TestPublicFileURL`: special characters escaped exactly once, invalid origins/refs rejected, file suffix preserved.
- [x] **Step 2: Verify RED.** Run `go test -p 1 ./internal/store ./internal/imgbed -run 'TestGalleryResourceURLs|TestGalleryThumbnailURLVersion|TestPublicFileURL' -count=1`; expect missing URL fields/function or incorrect URLs.
- [x] **Step 3: Implement metadata-derived URLs.** Extend the existing list query with public ID/original/thumbnail metadata; preserve pagination, tags, metadata-only seeds and sourceUrl. Build URLs while holding the storage configuration read gate, without holding nested storage gates. Validate local refs/MIME/version using existing identity helpers; return no filesystem path or secret in JSON. Keep this focused logic in `gallery_resources.go`.
- [x] **Step 4: Synchronize the DTO fixture and OpenAPI GalleryItem properties.** Add nullable URL properties to the standalone item and nested page fixture entries; leave all existing fields intact.
- [x] **Step 5: Verify GREEN.** Run the Task 1 command, then `go test -p 1 ./internal/httpapi -run TestAdminContractFixture -count=1`; expect PASS.

### Task 2: Serve immutable public local resources outside admin authentication

**Files:**
- Modify: `internal/domain/gallery.go` (resource result type)
- Modify: `internal/store/gallery_resources.go`
- Create: `internal/httpapi/gallery_resources.go`
- Modify: `internal/httpapi/router.go`, `internal/app/runtime.go`
- Test: `internal/store/gallery_resources_test.go`, `internal/httpapi/gallery_resources_test.go`
- Modify: `docs/api/admin.openapi.yaml`, `README.md`

**Interfaces:**
- Add `domain.GalleryResource { Data []byte; MIME string; Bytes int64 }` (internal result, not an admin DTO).
- Add `Store.PublicGalleryResource(ctx context.Context, publicID, filename string, head bool) (domain.GalleryResource, error)`.
- Add HTTP `GalleryResourceStore` interface containing that method and `Options.GalleryResources GalleryResourceStore`; wire it to the Store in runtime (and relevant manually wired test routers).
- Add `router.serveGalleryResource(w http.ResponseWriter, req *http.Request)` for `/images/<publicID>/<filename>` before the admin route. GET and HEAD only; no session middleware or cookie renewal.

- [x] **Step 1: Write failing public-resource tests.**
  - `TestPublicGalleryResources`: unauthenticated GET for local originals/all MIME formats and thumbnails returns exact bytes, proper MIME, length, inline filename and `public, max-age=31536000, immutable`; HEAD returns same headers and zero body; response contains no Set-Cookie even with an admin cookie.
  - `TestPublicGalleryResourceIdentity`: numeric/malformed ID, traversal, extra segments, wrong extension, wrong thumbnail version and deleted resources yield 404 + no-store; unsupported method yields 405 + no-store. Do not expose arbitrary `/data` files.
  - `TestPublicGalleryThumbnailRecovery`: missing thumbnail file uses existing bound database backup/recovery behavior; successful content matches the requested version. Old replaced versions cannot retrieve new content; HEAD must not download an ImgBed original.
  - `TestPublicGalleryImgbedOriginalNotProxied`: local original route cannot be used to proxy ImgBed originals; its thumbnails still work publicly.
  - `TestGalleryPublicDoesNotChangeAuth`: unauthenticated admin list/delete/content still fail; signed image links retain expiry validation and no-store.
- [x] **Step 2: Verify RED.** Run `go test -p 1 ./internal/store ./internal/httpapi -run 'TestPublicGallery|TestGalleryPublicDoesNotChangeAuth' -count=1`; expect missing method/options/route or 404 for valid public resources.
- [x] **Step 3: Implement Store public resource lookup.** Validate public ID and filename before querying. Hold existing lifecycle locks/config snapshot; match filename to authoritative metadata, local original identity or exact current thumbnail basename. Local-original HEAD uses stat/verification; thumbnail HEAD may use existing backup recovery when needed. Reuse existing thumbnail recovery without returning different content under stale filenames. Keep ImgBed original requests out of this method's read path.
- [x] **Step 4: Implement and wire the public HTTP handler.** Start with no-store; set long-lived public cache headers only after successful validation/read, plus nosniff, Content-Length and correct Content-Disposition. Use HEAD-aware error responses. No redirect and no signature requirements on this new route. Leave existing signed and admin handlers untouched.
- [x] **Step 5: Document public resources.** Describe GET/HEAD resource paths, TTL, public-access semantics, direct ImgBed caching controlled externally, and deletion cache residuals; retain old download compatibility.
- [x] **Step 6: Verify GREEN.** Run the Task 2 command and `go test -p 1 ./internal/store ./internal/httpapi ./internal/app -count=1`; expect PASS.

### Task 3: Switch gallery display to direct URLs and verify browser behavior

**Files:**
- Modify: `frontend/web/gallery.ts`, `internal/httpapi/assets.go`
- Create: `frontend/tests/gallery.test.mjs`
- Modify: `frontend/e2e/gallery.spec.ts`, `frontend/e2e/contracts.spec.ts`
- Test: `internal/httpapi/assets_test.go` and ImgBed HTTP/store tests from preceding tasks

**Interfaces:**
- Gallery cards consume `item.thumbnailUrl || item.imageUrl`; dialogs consume `item.imageUrl`.
- Remove gallery Blob fetches, object URL arrays/cache and revoke cleanup. Keep bounded unavailable-image state if necessary.
- On card thumbnail load failure, try the distinct original URL at most once; failed original becomes disabled placeholder. Null thumbnail selects original immediately. This direct `<img>` workflow does not distinguish HTTP 404 from 503.
- Preserve dialog load token/previous-frame hiding, navigation, prompt copying, metadata, pagination and delete behavior.
- Download links retain authenticated `/admin/api/gallery/{id}/content?download=1` so cross-origin ImgBed download behavior remains correct without relying on CORS or an HTML download attribute.
- Extend CSP `img-src` to allow HTTPS images, without loosening script-src/connect-src or frame policy. Keep pre-existing blob/data allowances if used elsewhere.

- [x] **Step 1: Write failing frontend/browser checks.**
  - Node gallery test asserts direct URL consumption and absence of `createObjectURL`, `revokeObjectURL`, `response.blob` and old image src paths in generated gallery script (old download path explicitly allowed).
  - Playwright asserts local card/dialog URLs have actual suffixes, no blob src, image dimensions decode correctly, unauthenticated resource fetch succeeds and carries public cache headers.
  - Update thumbnail fallback test to public thumbnail route; prove null-thumbnail immediate original and failed-thumbnail single original attempt; failed original does not loop.
  - Add HTTPS external original URL browser test with a locally fulfilled image response to prove CSP allows direct ImgBed display without a proxy image request.
  - Update rapid switching route interception to suffix-bearing originals; keep download MIME tests and session/list regression tests.
  - Add CSP unit assertion for HTTPS img-src and unchanged script/connect restrictions.
- [x] **Step 2: Verify RED.** Run `npm --prefix frontend test` and targeted Go asset test; expect old Blob code/CSP failures. Run relevant new Playwright tests where available to expose old image src behavior.
- [x] **Step 3: Implement direct-image rendering and scoped CSP update.** Do not add external scripts, dependencies or alternative signed API URLs. Preserve cached error behavior only where needed to prevent retry loops; public missing images need no login handling.
- [x] **Step 4: Verify GREEN.** Run `npm --prefix frontend test`, `npm --prefix frontend run build`, `npm --prefix frontend run test:e2e -- e2e/gallery.spec.ts e2e/contracts.spec.ts`; expect PASS. Browser tests use the project's preview infrastructure, not a production deployment.
- [x] **Step 5: Full regression.** Run `go test -p 1 ./...`, `go vet ./...`, `npm --prefix frontend test`, `npm --prefix frontend run test:e2e`, and `git diff --check`. Report failures or unavailable browser dependencies faithfully; do not claim an actual CDN hit without deployment evidence.
- [x] **Step 6: Independent final review and outcome.** Review changed public route boundaries, versioned cache identities, ImgBed origin updates/token redaction, unchanged signed API behavior, and frontend retries. Fix confirmed issues, rerun affected tests, summarize actual verification. Do not commit/push unless separately requested.
