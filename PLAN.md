# github-core-clone-01 — Fase 1: survei + baseline + rencana

Bounty: build a GitHub-compatible git forge, $500, deadline Sabtu 2026-11-21 13:30 WIB.
Repo ini: `~/workspace/makefun/github-core-clone-01-entry/` (source-bundle entry, anchor
`makefun anchor 62da0f39731084897b27bbca91869df7c307a757 round 33967509`).
Kit: `~/workspace/makefun/github-core-clone-01-kit/` (RULES.txt + competition.yaml dibaca seluruhnya).

## 1. Baseline: starter di practice trial-0 (diukur lokal, 2026-11-15 ~08:24 WIB)

Cara ukur (tanpa docker — docker tidak ada di VM ini): env dijalankan langsung
`MAKEFUN_STATE_DIR=/tmp/gh-baseline/state MAKEFUN_ENV_HOST=127.0.0.1
MAKEFUN_ENV_PORT=8080 MAKEFUN_SHOP_TOKEN=makefun-test-token node program/env/server.mjs`,
entry starter `MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts`.
Env menulis `<state>/export/state.json` + `perf.json`. Node lokal v24.22.1 (grader pakai Node 22).

- **Skor starter: 15 / 1000** — feature 15, agent 0, perf 0. Working 1.
- Checks lolos **3/120**: `repos.root`, `repos.not-found`, `protocol.unknown-route-json-404`.
- Per grup: git 0/30, repos 2/15, issues 0/15, pulls 0/20, graphql 0/20, mcp 0/15, protocol 1/5.
- Perf: 4 workload 0 poin (setup gagal: `POST /api/v3/user/repos` 404).
- Fase: boot 7142 ms, conformance 328 ms, benchmark 14 ms. Total trial ~7,5 detik.
- Artefak baseline: `/tmp/gh-baseline/state/export/state.json`, `perf.json`, log `/tmp/gh-baseline/env.log`.

## 2. Skor dan bar yang harus dilewati

- Skor = feature (600) + agent (200) + perf (200). feature = round(600 × passed/120);
  agent = round(200 × mcpPassed/15); perf = Σ workload, tiap workload
  `round(clamp(25 − 12,5×log2(t/T_ref), 0, 50))`.
- House reference forge (baseline/entry): **120/120 conformance** (git 30/30, repos 15/15,
  issues 15/15, pulls 20/20, graphql 20/20, mcp 15/15, protocol 5/5), working 1.
  Di T_ref tiap workload = 25 poin → perf reference 100/200 → **total reference ≈ 900/1000**.
- Hadiah HANYA kalau skor final STRICTLY di atas reference (seri statistik 90% paired
  t-interval tidak dihitung menang). Jadi praktis: conformance harus (hampir) 120/120
  DAN perf harus > 100/200, alias lebih cepat dari reference secara agregat.
- Final: semua entry jalan 1 trial di instance pertama; top 60 (+ seri dengan rank 60)
  lanjut ke 3 instance, tiap trial di-replay; ranking pakai rata-rata 3 instance.
  Replay harus menghasilkan state export byte-identik — determinisme wajib.
- T_ref (median 3 run reference di produksi, 2026-11-14):
  push 1640,82 ms · clone 266,941 ms · read 2759,715 ms · write 348,965 ms.
  perf_p50_us reference (geometric mean) ≈ 805.899 µs.
- Kuota tertulis: 5/hari, 10 total (Force_Last). Catatan: di kompetisi lain kuota
  efektif akun terbukti 3 (reputasi) — belum terverifikasi di kompetisi ini.
- Batas: 1 proses, port ephemeral sendiri, JANGAN bind 8080; tanpa git binary;
  stdlib + source yang di-vendor saja; maks 16 MiB source / 8 MiB per file;
  wall 900 detik; boot budget 20 detik; check timeout 5–15 detik;
  conformance budget 240 detik; benchmark budget 240 detik; 2 CPU / 1024 MiB / 256 pid.
- Transcript gate (RULES.txt): reproduces ≥30%, turns ≥5, priced 100%,
  revised ≥2 file writes, fresh 100% (source bundle), wellformed 60 detik,
  in-window 60 detik skew. competition.yaml: min_authored_coverage 0,8
  (efficiency view saja — "no prize rides on that view").
- Prizes tidak di-escrow; entry repo GitHub tidak butuh --keypair, entry source
  bundle butuh --keypair. Repo ini memakai jalur source bundle.

## 3. Lifecycle (main.ts — jangan diubah)

1. `server.listen(0)` (kernel pilih port). Jangan bind 8080.
2. `POST $MAKEFUN_ENV_URL/register {"port": N}`. Pertama menang; 409 = sudah ada.
3. Poll `GET $MAKEFUN_ENV_URL/done` sampai `{"done": true}`. Jangan exit duluan.
4. Exit 0. Env menulis export; scorer membaca state.json + perf.json.
- Token: `MAKEFUN_SHOP_TOKEN` — semua API call bawa `Authorization: Bearer <token>`;
  tanpa token = 401 (kecuali /healthz). Repo milik login yang dinamai token;
  nama repo sama di bawah owner lain = 404, bukan 403.
- Skenario deterministik: `SCENARIO_SEED_HEX = '6a09e667f3bcc909'` (sama di trial-0/1/2);
  semua nama/path/blob/judul berasal dari scenario — tidak ada waktu/port/id acak
  di data yang disajikan (pakai timestamp tetap + counter sekuensial).

## 4. Inventaris check (120) — dari program/env/src/*.ts

### git (30) — checks-git.ts
advertise-v2, advertise-receive-pack, advertise-headers, unknown-repo-404, ls-refs,
ls-refs-prefix, clone-empty, push-first-commit, clone-object-hashes, clone-blob-bytes,
clone-tree-entries, clone-commit-bytes, clone-annotated-tag, fetch-incremental,
fetch-nothing-new, fetch-shallow-depth1, fetch-shallow-deepen, fetch-shallow-new-tip,
push-update-ref, push-create-branch, push-delete-branch, push-non-fast-forward,
push-mixed-report, push-delete-tag, push-100-files, pack-integrity, pack-deltas,
sideband-framing, push-sideband-report, repo-survives-errors.

Aturan kunci: upload-pack HARUS v2 (suite minta `Git-Protocol: version=2`; jawaban v0
kehilangan 3 check, sisanya fallback v0). receive-pack v0 saja, advertise
report-status, side-band-64k, delete-refs. Iklan v0 dibuka `# service=git-upload-pack`
/ `# service=git-receive-pack`; iklan v2 dibuka `version 2`. Repo hilang = 404 di
GET /info/refs kedua service, server tetap hidup. Setiap update harus fast-forward;
non-FF ditolak per-ref (`ng <ref> non-fast-forward`, ref tidak bergerak); satu push
campuran menerapkan yang ok dan melaporkan `ok` + `ng` per-ref. v0 upload-pack tanpa
side-band-64k tidak bisa di-frame.

### repos (15) — checks-rest.ts
pagination (30 repo seed, per_page=10, Link rel="next"), root (GET /api/v3/ 200 +
X-OAuth-Scopes), meta (installed_version non-empty), create (POST /user/repos 201,
GET round-trip name/private/default_branch), not-found (GET repo hilang = JSON 404),
patch (PATCH description), delete (DELETE 204, GET berikutnya 404), branches
(GET /branches dari branch yang dibuat via POST /git/refs), commits (GET /commits
mencerminkan commit di branch non-default), unauthorized (tanpa token 401),
foreign-token (nama repo sama di owner lain = 404), contents-create (PUT 201 create /
200 update, GET base64 + sha), contents-directory (GET direktori = daftar entry),
contents-stale-sha (PUT sha basi = 409), contents-delete (DELETE 200 {commit:{sha}},
GET berikutnya 404).

### issues (15)
create (POST 201, issue open + number), create-title-body (echo title+body),
create-labels (label yang sudah ada), numbers-increment, list-open, list-open-excludes-closed,
list-sort-asc/desc (sort=created), list-shape (bentuk issue GitHub), get-one,
patch-close, patch-close-persists, comment-create, comments-list, bad-label (label
tak dikenal = 422). Label harus dibuat dulu (POST /labels 201 {name}) sebelum
issue boleh membawanya.

### pulls (20)
create (POST 201, state open, head+base), create-body, create-head-sha (head.sha =
ujung head branch), create-base-sha, get-one, files-list, files-shape (filename,
status, change counts), files-multiple, merge-status (PUT /merge merge_method=squash
= 200), merge-body ({merged:true, sha, message}), merge-closes (closed+merged+
merged_at), merge-commit-on-default, merge-content-on-default (konten squash ada
di default branch), merge-commit-sha (merge_commit_sha = sha merge), merge-unknown
(404), merge-conflict (405), list-state-all, list-default-open, list-shape,
get-unknown (404).

### graphql (20) — checks-graphql.ts, GRAPHQL_DOCUMENTS (18 dokumen)
viewerLogin, repositoryFields, issueFields, typeFields, searchTypeEnumValues,
openIssues, issueByNumber, createIssue, closeIssue, pullRequests, pullRequestFiles,
pullRequestId, createPullRequest, mergePullRequest, addComment, invalidField,
nodeRepository, issuesPage.
Check: viewer.login; repository(...) = id, databaseId, name, owner,
defaultBranchRef, viewerPermission, hasIssuesEnabled; __type Issue = id, number,
title, state, body; __type PullRequest = id, number, headRefName, baseRefName,
mergeable, state, merged, files; __type Repository = id, databaseId, name,
nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue,
issues, pullRequests, pullRequest; SearchType enumValues termasuk ISSUE;
issues(first:10, states:[OPEN], orderBy CREATED_AT DESC) = nomor DESC, ties nomor
DESC, closed disaring; createPullRequest dari repo id + head branch yang sudah
di-push; mergePullRequest SQUASH → REST merged:true; addComment → REST list;
field tak dikenal = HTTP 200 + errors[] yang menyebutnya; tanpa auth = 401 persis;
repo tak dikenal = data.repository null tanpa errors; dua dokumen operasi dalam
satu body = dua hasil berurutan; node(id:) round-trip repo; global id opak dan
stabil di pembacaan berulang; issues(first, after) paging cursor sampai habis.

### mcp (15) — checks-mcp.ts
initialize (serverInfo.name/version + capabilities.tools), server-discover
(supportedVersions = daftar revisi YYYY-MM-DD non-empty; revisi 2026-07-28, atau
handshake lama 2025-11-25 via initialize + notifications/initialized + Mcp-Session-Id
opsional), tools-list (≥6 tools, wajib: create_repo, get_repo, create_issue,
list_issues, create_pull_request, merge_pull_request; prefix server diizinkan,
dicocokkan sebagai suffix case-insensitive), tool-schemas (deskripsi non-empty +
inputSchema type object), create-issue, list-issues, create-pull-request,
merge-pull-request, unknown-tool (-32602/-32601, bukan HTTP 500), parse-error
(body bukan JSON = HTTP 400 + -32700), missing-arguments (isError:true / -32602),
concurrent-calls (dua call bersamaan jawab di id masing-masing), tools-list-idempotent
(dua tools/list = array tools sama byte-per-byte), rest-parity (repo+issue via MCP
terbaca di REST sebagai objek sama, id stabil), auth-required (tanpa Authorization = 401).
Transport: JSON-RPC 2.0 Streamable HTTP, application/json atau SSE; tiap request
≤ 3 detik. Argumen sesuai github-mcp-server: create_repo {name}, get_repo
{owner, repo}, create_issue {owner, repo, title, body?}, list_issues {owner, repo,
state?}, create_pull_request {owner, repo, title, head, base}, merge_pull_request
{owner, repo, pull_number}; argumen dipetakan ke nama properti terdekat + full_name
= owner/repo.

### protocol (5)
content-type-json (semua reply REST application/json, bukan HTML),
unknown-route-json-404, malformed-body-400, request-id (X-GitHub-Request-Id
non-empty di semua reply), error-message (body 401/404/422 bawa string message).

## 5. Workload (bench.ts) + T_ref

- push: 200 push sekuensial, perubahan 1 KiB, satu repo, satu receive-pack
  exchange per operasi (advertisement + command list + pack). Semua payload
  dibangun sebelum timer mulai. T_ref 1640,82 ms.
- clone: 50 shallow clone (depth 1) KONKUREN dari repo 200 commit (satu push
  membawa semua 200 commit saat setup). Client verifikasi checksum pack saja.
  T_ref 266,941 ms.
- read: 2.000 GET /repos/{o}/{r}/issues/{n} sekuensial, satu koneksi keep-alive.
  T_ref 2759,715 ms.
- write: 200 POST issue sekuensial. T_ref 348,965 ms.
- Tiap workload: median 3 round setelah 5 warm-up. Budget per workload 60 detik,
  fase benchmark 240 detik. Workload gagal setup = 0 poin, p50 = 1e9.

## 6. Arsitektur yang dipilih: Node 22 TypeScript (ikuti starter)

- **Node 22 TS, satu proses, `node:http` + `node:zlib` + `node:crypto` saja.**
  Alasan: starter sudah TS; suite-nya sendiri TS (bentuk wire-nya persis terlihat di
  program/env/src/*.ts); event loop Node menangani 50 clone konkuren dengan baik
  (I/O + zlib async; SHA-1 sync tapi objek kecil); read workload (2.000 GET
  sekuensial, satu keep-alive) diuntungkan store in-memory + alokasi minimal per
  request; Python ditolak — http.server lebih lambat per-request, dan starter TS
  memberi bentuk yang sudah benar (lifecycle main.ts jangan diubah).
- **Store in-memory** (Map): repos → refs → objek (Buffer keyed by SHA-1 hex).
  Tanpa persistensi — satu trial = satu proses; export deterministik adalah
  state.json milik suite, bukan data kita. Semua `created_at`/`updated_at` =
  timestamp tetap (konstanta), semua id = counter sekuensial — tanpa Date.now(),
  tanpa Math.random(), tanpa UUID di data yang disajikan.
- **Layout file** (semua .ts, type-stripping-safe — TANPA enum, namespace,
  parameter properties; pakai `import type`): `main.ts` (lifecycle, jangan diubah),
  `app.ts` (router HTTP), `store.ts` (model repo/issue/PR + JSON shapes),
  `git-objects.ts` (SHA-1, blob/tree/commit/tag, packfile baca/tulis),
  `git-http.ts` (pkt-line, v2 ls-refs/fetch, v0 upload/receive-pack, sideband),
  `rest.ts` (REST v3), `graphql.ts` (executor minimal + 18 dokumen),
  `mcp.ts` (JSON-RPC Streamable HTTP). Total target < 16 MiB, jauh di bawah batas.
- **Packfile**: baca HARUS tangani delta (OFS_DELTA + REF_DELTA) — client suite
  mengirim pack ber-delta saat push. Tulis pack TANPA delta (undelted, zlib per
  objek) — lebih sederhana + lebih cepat; check pack-deltas hanya menegaskan
  delta "saat server mengirimnya".
- **Perf**: pack history 200-commit di-cache sebagai Buffer sekali per repo
  (clone konkuren pakai ulang); issue read dari Map by number; hindari
  JSON.stringify ulang untuk respons yang sama; keep-alive default node:http.

## 7. Rencana implementasi berurutan (estimasi jam kerja fokus)

| # | Bagian | Isi | Estimasi |
|---|--------|-----|----------|
| a | Object store git + packfile | SHA-1 objek (blob/tree/commit/tag), parse + tulis pack v2, aplikasikan delta OFS/REF, verifikasi checksum, `collectReachable` | 4–6 jam |
| b | Smart HTTP v2/v0 | pkt-line, iklan v2 + ls-refs (prefix, symref HEAD, peeled tag), fetch (want/have, shallow, deepen), v0 upload-pack + sideband-64k, receive-pack v0 (report-status, delete-refs, fast-forward check, laporan per-ref) | 4–5 jam |
| c | REST v3 | repos (+pagination Link, /git/refs, branches, commits, contents base64+sha, stale 409), issues (+labels, comments, sort/filter), pulls (+files, squash merge ke default branch, 405 conflict), auth 401/404-asing, X-GitHub-Request-Id di semua reply | 5–7 jam |
| d | GraphQL | Executor minimal untuk 18 dokumen persis (baca teks dokumen dari checks-graphql.ts), introspeksi Issue/PullRequest/Repository/SearchType, cursor pagination, global id opak stabil, errors[] untuk field tak dikenal | 3–4 jam |
| e | MCP | JSON-RPC 2.0 Streamable HTTP, revisi 2026-07-28 + handshake lama, server/discover, tools/list idempotent, 6 tool wajib di atas store yang sama dengan REST, kode error -32601/-32602/-32700, 401 tanpa auth | 2–3 jam |
| f | Determinisme + export | Timestamp tetap, counter sekuensial, tanpa acak; uji replay: 2 run lokal harus hasilkan state.json byte-identik | 1 jam |
| g | Perf + loop grading lokal | Ukur 4 workload lokal vs T_ref, optimasi hot path (cache pack clone, Map issue), grade-local tiap submit | 3–5 jam |

Total ~22–30 jam dalam ~5 hari (deadline 21 Nov 13:30; Fase 1 selesai 15 Nov 08:30).
Urutan submit: v1 = REST + MCP + git dasar (skor parsial, pastikan Works=1) →
v2 = GraphQL + packfile lengkap → v3 = perf tuning. Tiap submit diikuti grade
lokal trial-0/1/2 sebelum submit berikutnya.

## 8. Risiko terbesar

1. **Aplikasi delta packfile** — OFS_DELTA/REF_DELTA harus byte-tepat; client
   suite mengirim pack ber-delta; satu bug di sini meruntuhkan semua check git
   push/clone.
2. **Semantik v2 ls-refs/fetch** — argumen ref-prefix, filter, shallow/deepen
   (deepen 2 = tepat satu generasi; shallow fetch tip baru tanpa history lama).
3. **Bentuk GraphQL gh/github-mcp-server** — dokumennya ada di kit
   (checks-graphql.ts GRAPHQL_DOCUMENTS) tapi harus dibaca verbatim di Fase 2;
   salah satu field/argumen = check gagal.
4. **Merge PR** — squash commit harus muncul di default branch dengan konten yang
   benar; kasus "conflicted" (405) — cara suite membangun PR yang konflik harus
   dibaca dari checks-rest.ts (pulls-merge-conflict) di Fase 2.
5. **Perf vs T_ref** — reference total ≈900; kita butuh >900, jadi perf harus
   >100/200 (lebih cepat dari reference). Angka lokal VM tidak sama dengan
   produksi — ukur relatif terhadap T_ref, bukan absolut.
6. **Node 22 vs Node 24 lokal** — grader Node 22.18 (type stripping); hindari
   fitur TS yang tidak bisa di-strip; uji dengan `--experimental-strip-types`
   bila perlu.
7. **Kuota efektif** — tertulis 5/hari 10 total, tapi di kompetisi lain kuota
   efektif akun terbukti 3. Jangan bakar slot: submit hanya setelah grade lokal
   bersih.

## 9. Yang TIDAK bisa diketahui dari kit (unknown)

- Teks verbatim 18 dokumen GraphQL — ADA di kit (checks-graphql.ts) tapi belum
  dibaca isinya; masuk Fase 2, bukan unknown sejati.
- Cara suite membangun PR "conflicted" untuk pulls-merge-conflict — ADA di
  checks-rest.ts; dibaca di Fase 2.
- Scored instance final — digambar setelah deadline dari drand round 34146612
  (2026-11-21T06:40Z); tidak bisa diketahui siapa pun (by design). Tapi seed
  skenario tetap (`6a09e667f3bcc909`), jadi bentuk datanya sama dengan practice.
- Reference forge (baseline/entry) — kodenya TIDAK ada di kit; hanya skornya
  (120/120, T_ref) yang diketahui. Tidak bisa meniru implementasinya, hanya
  mengalahkan angkanya.
- Timing produksi vs VM lokal — T_ref diukur di klaster produksi (gVisor, node
  bersama); VM ini lingkungannya berbeda; angka lokal hanya panduan relatif.
- Kuota efektif akun (3 vs 5/hari) — baru ketahuan saat submit ke-4 dicoba.

## 11. Fase 2 — hasil (2026-11-15 ~08:30–09:45 WIB, commit 8feecd1)

Implementasi inti selesai: `git-objects.ts` (object store, packfile baca
OFS/REF delta + tulis tanpa delta, reachability, shallow/deepen, merge-base,
diff tree), `scenario.ts` (generator seed → viewer `adaiversen` id 1000,
stranger `olgabauer` id 1002 — terverifikasi persis), `store.ts` (repo/issue/PR/
label/comment + squash merge + konflik 405), `git-http.ts` (pkt-line, iklan v2
+ v0, ls-refs, fetch v2/v0, receive-pack report-status), `rest.ts` (REST v3
lengkap), `app.ts` (router, auth Bearer = MAKEFUN_SHOP_TOKEN, X-GitHub-
Request-Id, JSON 400). `graphql.ts`/`mcp.ts` masih stub 404 (Fase 3).

Grade lokal (cara Fase 1, env server.mjs + `node main.ts`):
- **trial-0: 86/120, working 1** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, graphql 1/20 (hanya `unauthenticated` — 401
  sudah benar), mcp 0/15. Perf **173/200** (push 38 @778,8 ms, clone 40
  @117,3 ms, read 48 @756,8 ms, write 47 @103,2 ms; p50_us 290.676 vs
  reference 805.899).
- **trial-1: 86/120, working 1**, grup sama persis. Perf **169/200**
  (push 40 @699,5 ms, clone 40 @113,4 ms, read 48 @761,4 ms, write 41
  @143,5 ms; p50_us 305.092).
- **Replay: state.json trial-0 dan trial-1 BYTE-IDENTIK**
  (sha256 a7346559…) — determinisme terpenuhi.
- Semua 34 kegagalan di kedua run adalah GraphQL (19) + MCP (15) — nol
  kegagalan di git/repos/issues/pulls/protocol.

Skor lokal saat ini: feature round(600×86/120)=430 + agent 0 + perf ~171
≈ **601/1000**. Fase 3 (GraphQL 19 + MCP 15) bernilai ~370 poin;
proyeksi 120/120 → ~970/1000, di atas reference ~900.

Bug yang ditemukan & diperbaiki selama Fase 2 (jangan diulang):
- Report-status push: baris `unpack ok` tanpa `\n` membuat client membaca
  `unpackDetail: "okok refs/heads/main"` — semua baris report wajib `\n`.
- Deepen: have yang juga shallow boundary hanya berarti commit + tree-nya,
  BUKAN seluruh ancestry — kalau ancestry ikut dianggap held, deepen
  mengirim 0 objek. Walk harus menembus held shallow boundary.
- `inflateSync` mengabaikan trailing bytes tapi throw saat truncated —
  `skipDeflateStream` memakai itu (probe eksponensial + binary search).
- Env (server.mjs) TIDAK exit sendiri setelah trial — pegang port 8080;
  runner harus kill env setelah entry exit, kalau tidak trial berikutnya
  gagal EADDRINUSE dan menulis boot-failure export (0/120).
- `parseJsonBody` di app.ts menolak JSON array (400) — GraphQL batched
  operations mengirim array; Fase 3 harus mengizinkan array di /api/graphql.

Sisa untuk Fase 3: baca verbatim GRAPHQL_DOCUMENTS (checks-graphql.ts),
executor GraphQL (viewer, repository, issue, __type, search, cursor
pagination, global id, errors[]), MCP (JSON-RPC 2.0 Streamable HTTP,
6 tool wajib, error -32601/-32602/-32700), lalu perf tuning ringan
(write t1 41 vs t0 47 — variansi VM, bukan regresi kode).

- [ ] Baca verbatim GRAPHQL_DOCUMENTS + bodies check graphql (checks-graphql.ts ~l.100–320)
- [ ] Baca pulls-merge-conflict + git fixture GraphQL (configureGraphQLGit)
- [ ] Baca git-client.ts: bentuk pack yang dikirim client (delta? thin pack?),
      v2 fetch args, sideband framing persis
- [ ] Baca rest-client.ts + wire.ts: bentuk JSON yang diharapkan (shape checker)
- [ ] Implementasi (a) object store + packfile, uji dengan git-client suite lokal

## §12 — Hasil Fase 3 (GraphQL + MCP) — 2026-11-15 ~02:00 WIB

Implementasi (commit c1ab0ab, lalu perbaikan files-connection):
- `graphql.ts` ditulis ulang (~37 KB): tokenizer + parser recursive-descent
  untuk subset GraphQL (operasi, variabel, alias, inline list/object/enum,
  inline fragment, `__type`), executor dengan resolver Query/Mutation,
  Repository, Issue, IssueConnection, PullRequest, PullRequestChangedFile,
  User, __Type, payload. Global id = base64url `Kind:payload`, decode
  divalidasi bentuk kanonik (bukan databaseId/number mentah). Field tak
  dikenal → HTTP 200 + errors[] `Cannot query field "X" on type "Y".`.
  Repo tak dikenal → data.repository null tanpa errors. Batched array
  dijawab berurutan. Cursor = base64url `cursor:<number>`, ASC → number >
  cursor, DESC → number < cursor. mergeable dihitung non-mutating.
- `mcp.ts` ditulis ulang (~13 KB): JSON-RPC 2.0 Streamable HTTP.
  `server/discover` (supportedVersions 2026-07-28, 2025-11-25, 2025-06-18,
  2025-03-26, 2024-11-05), `initialize` (echo revisi yang diminta bila
  didukung, else 2025-11-25), `notifications/*` → 202 kosong,
  `tools/list` (array statis — byte-identik), `tools/call` (unknown tool
  -32602, argumen wajib hilang -32602, eksekusi via Store = rest-parity,
  hasil text JSON + structuredContent, gagal = isError:true), `ping`.
  6 tool wajib: create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request.
- `app.ts`: `parseGraphqlBody` mengizinkan objek ATAU array JSON hanya di
  /api/graphql (REST tetap menolak array — protocol.malformed-body-400
  tetap lolos). `/mcp`: body bukan JSON → HTTP 400 + -32700.

Bug yang ditemukan & diperbaiki selama Fase 3 (jangan diulang):
- TS parameter property (`constructor(private readonly tokens)`) DITOLAK
  Node type-stripping (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) — deklarasikan
  field secara eksplisit di body class. Berlaku untuk SEMUA file .ts.
- `files` PR: resolver awal meneruskan sub-seleksi field `files` (`nodes`)
  sebagai seleksi changed-file → error `Cannot query field "nodes" on
  type "PullRequestChangedFile"`. Perbaiki dengan tipe connection sendiri
  (`PullRequestChangedFileConnection`, field `nodes`) seperti issues/
  pullRequests — connection selalu di-resolve dua lapis (connection →
  nodes → item).
- `/tmp` TIDAK persisten antar exec call di VM ini — harness/skrip runner
  harus tinggal di ~/workspace (run-trial.sh kini di
  ~/workspace/makefun/run-trial.sh dan meng-absolut-kan path-nya sendiri).
- `pkill -f <nama>` membunuh shell exec itu sendiri kalau string-nya ada di
  command line — bunuh background process via PID (`$!`), bukan pkill.

**Grade lokal Fase 3 (verifikasi independen dari artefak export):**
| trial | conformance | feature | agent | perf | TOTAL | gagal |
|---|---|---|---|---|---|---|
| t0 | 120/120 | 600 | 200 | 182 | **982** | — |
| t1 | 120/120 | 600 | 200 | 177 | **977** | — |
| t2 | 120/120 | 600 | 200 | 179 | **979** | — |
Per grup (ketiga trial identik): git 30/30, repos 15/15, issues 15/15,
pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15.
Perf vs T_ref (push 1640.82 ms · clone 266.941 ms · read 2759.715 ms ·
write 348.965 ms): push ~650–685 ms (41–42), clone ~85–117 ms (40–46),
read ~570–676 ms (50), write ~86–144 ms (41–50). Variansi write antar
trial = noise VM (41 vs 50), bukan regresi.
**Replay: state.json t0/t1/t2 BYTE-IDENTIK (sha256
a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590).**
Artefak: `~/workspace/makefun/grade-fase3/` (t0/t1/t2 state+perf,
log env/entry). Repo 588 KB total, 155 KB .ts — jauh di bawah batas
16 MiB sumber / 8 MiB per file.

Skor lokal 977–982/1000, di atas reference ~900. **Entry LAYAK submit
sebagai v1** (kuota tertulis 5/hari 10 total; kuota efektif akun mungkin
3 — submit v1 ini menghabiskan 1 slot; jangan submit ulang tanpa
perubahan yang terukur lebih baik, karena Force_Last: entri terakhir
yang dinilai).
