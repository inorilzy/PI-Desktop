# Personal integration

A local-only testing branch combining four optional features. This is not an upstream release or a fully green release candidate.

## Safety first

- Always use a separate application data directory **and** Electron `--user-data-dir`. Do not point this build at your official installation's profile, or run two processes against the same profile.
- PR #941 introduces private **schema 24** (upstream baseline: 23). Existing v19-v23 databases migrate through upstream steps before adding receipts, with backups. That does not make switching the same database back to an official build safe. A future upstream schema 24 may mean something different. Keep personal data isolated; do not downgrade or edit schema numbers manually.
- Start with an empty profile and configure test accounts explicitly. No real user databases or credentials were used in validation.
- For self-built ZIP/portable packages, keep updates set to **manual**. Accepting an official update removes private features and may encounter incompatible data. Development runs do not auto-update.
- Per-fallback `model|thinking` settings are private-format additions; older official builds are not a safe editing path for them.

## Included sources

Branch: `personal/integration`. Checkout: `E:\1-code-project\PI-Desktop-personal`.

Validated executable candidate: `1723f29633d979ea8d90bcf22f9c1173cc319446`.
Upstream validation baseline: `93a9a828f896edc468ff15f74b9c2a93fedefd5b` (`vastsa/PI-Desktop`, `upstream/main`).

| PR | Pinned source commit | Feature |
| --- | --- | --- |
| [#1013](https://github.com/vastsa/PI-Desktop/pull/1013) | `43be92526b101f1d33ae6539b9bc3dfc1471af5f` | Independent thinking levels for fallback models |
| [#941](https://github.com/vastsa/PI-Desktop/pull/941) | `c8d0eb6f428816d8f09bfb0ea20e0d2bb04dc41e` | Opt-in collaboration delivery at the next safe request in the current turn |
| [#1563](https://github.com/vastsa/PI-Desktop/pull/1563) | `b895366c47bd9861f375b0bbafbde8214a57149f` | Bundled `@` session references |
| [#973](https://github.com/vastsa/PI-Desktop/pull/973) | `6ba473b6d3cb69264e92252b786b4db899866136` | Configured subagent primary model wins over conflicting `Task.model` |

All source heads are ancestors of this branch; original branches were not rewritten. #973 was closed without merging and #1563 remains a draft: their presence here is a personal opt-in, not upstream acceptance.

### Integration adaptations

- Retained #1013's disabled-provider display handling and accessible/scroll-aware user-path fixture.
- Adapted #941's old v19-to-v20 migration to v23-to-v24, preserving all intervening upstream migrations. Added v19-v23 upgrade/reopen tests, new queue fields, retained `eventPersistence.flush` wiring, current Pi runtime hooks, shared settings controls, and Portuguese translations.
- Preserved upstream remote-session capability fixtures when adding #1563's user-message reference renderer.
- Retained upstream model authorization guidance with #973; added coverage combining pin precedence with an explicit fallback thinking level.

## Build and run from this checkout

Prerequisites: Node, the repository-pinned pnpm, Rust/MSVC build tools. Dependencies are already prepared on this machine; no install is needed for the current checkout. Shared dependencies were initially linked from the existing #1013 worktree. Do not delete that worktree while links remain in use.

The machine's global pnpm wrapper is broken. This session successfully used the installed native executable by prepending its directory to the **current shell only**:

```powershell
Set-Location E:\1-code-project\PI-Desktop-personal
$env:PATH = "C:\Users\liuzhiyu\AppData\Local\pnpm\.tools\pnpm\12.8.1\node_modules\@pnpm\exe.win32-x64;$env:PATH"
pnpm --version
```

Reuse the existing Cargo cache, build this checkout, then launch an unpackaged development instance with explicit profile isolation:

```powershell
$env:CARGO_TARGET_DIR = 'E:\1-code-project\PI-Desktop-1013-merge-main\target'
cargo build -p host-core --locked
if ($LASTEXITCODE -ne 0) { throw 'Host build failed' }
pnpm build:js
if ($LASTEXITCODE -ne 0) { throw 'JavaScript build failed' }
$env:PI_DESKTOP_HOST_BIN = Join-Path $env:CARGO_TARGET_DIR 'debug\pi-desktop-host-core.exe'
$profile = Join-Path $env:LOCALAPPDATA 'PI-Desktop-personal-integration'
$env:PI_DESKTOP_DATA_DIR = Join-Path $profile 'data'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& '.\apps\desktop\node_modules\electron\dist\electron.exe' '.\apps\desktop' "--user-data-dir=$profile\electron"
```

Build commands and binary paths were verified. The last launch command is intentionally not executed automatically against a persistent personal profile.

### Package for Windows

The existing packaging scripts produce release artifacts. No installer/ZIP was generated or tested as part of this branch setup. To prepare a local, non-published ZIP using standard tooling:

```powershell
# From the repository root, with working pnpm on PATH:
# Packaging expects target/release in this checkout, not a redirected Cargo target.
Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
Remove-Item Env:PI_DESKTOP_HOST_BIN -ErrorAction SilentlyContinue
pnpm --filter @pi-desktop/desktop run build:deps
if ($LASTEXITCODE -ne 0) { throw 'Dependency build failed' }
pnpm --filter @pi-desktop/desktop run build:host-release
if ($LASTEXITCODE -ne 0) { throw 'Release host build failed' }
pnpm --filter @pi-desktop/desktop run bundle:runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime bundle failed' }
pnpm --filter @pi-desktop/desktop build
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
pnpm --filter @pi-desktop/desktop exec electron-builder --win zip --publish never -c.extraMetadata.piDistribution=zip
if ($LASTEXITCODE -ne 0) { throw 'ZIP build failed' }
```

Artifacts go under `apps/desktop/release`. Launch the extracted executable with the same explicit `PI_DESKTOP_DATA_DIR` and `--user-data-dir` isolation shown above. Do not launch a self-build against the official profile by double-clicking it without a configured isolated launcher.

## Validation

Environment: Windows, Node 24.14.1, pnpm 12.8.1, Rust 1.95.0. Provider E2Es used local deterministic fixtures and temporary profiles, not paid providers or the user's running Desktop.

Passed on the integrated executable candidate:

- `pnpm build:js`; Desktop typecheck; `pnpm lint`; `cargo fmt --check`; Host debug build.
- `pnpm docs:check`: 86 English/Chinese pairs and 574 pages (non-blocking ADR notes).
- `node scripts/check-architecture.mjs --base upstream/main`.
- Shared: 1,244 tests; plugin-sdk: 384; i18n: 30; agent-runtime: 1,352 passed / 1 skipped. Other completed package suites: plugin-devkit 52, voice-runtime 51, agent-host 57, racp 22.
- Session-reference targeted tests: 139/139, including the real plugin runtime, renderer loader, snapshot, selection/send, title and settings paths.
- Model selection/fallback targeted tests: 399/399 before the final upstream-only refresh. The final full runtime suite also covers these. Combined pin-priority/fallback-thinking regression passed.
- `test:e2e:subagent-models`, `test:e2e:session-current-turn`, `test:e2e:collaboration`, `test:e2e:session-completion` passed on the final candidate.
- The fallback editor's Electron user path passed after restoring the missing Electron binary. A serial rerun of eight environment-sensitive test files had 37 passed / 1 failed (unrelated S3 settings timeout).

Not fully green:

- Rust full suite: **822 passed, 4 failed, 1 ignored**. The four configuration-sync/data-relocation failures also reproduced in the pre-integration #1013 checkout. They were not suppressed or fixed outside scope.
- Host-runtime: **115 passed, 1 failed, 3 skipped**. The failure is a POSIX scratch-path expectation on Windows, also reproduced before integration. Recursive workspace testing stopped at this package; not every later workspace app suite ran.
- Desktop full suite initially: **3,823 passed, 84 failed, 9 skipped**. Seven failures were missing Electron, one MCP timeout was transient. After restoring Electron and rerunning those files, six Electron paths and MCP passed, while S3 settings still timed out. Other failures include Windows symlink permission, missing shell, and path assumptions. The full suite was not rerun or declared green after this targeted recovery.
- Clippy is not installed in the current Rust toolchain. No Clippy pass is claimed.
- No packaged installer, release signing, paid-provider compatibility run, or interactive test of the user's actual profile was performed.

## Update or retire a source

Before rebuilding, query GitHub explicitly against the upstream repository:

```powershell
git fetch upstream main
foreach ($n in 1013, 941, 1563, 973) {
    gh pr view $n -R vastsa/PI-Desktop --json number,state,mergedAt,baseRefName,mergeCommit,headRefOid
}
```

`MERGED` is only a removal candidate when the target is `main` and its recorded merge commit is present in the fetched `upstream/main`. Preserve any local-only follow-up fixes and check for later upstream reverts. `CLOSED` without a merge (such as #973) is **not** a reason to silently drop a wanted feature. A moved head does not change this branch until explicitly integrated and retested.

Do not rely only on original PR-head ancestry: squash/rebase changes commit identities. Do not treat an empty merge diff as proof that the feature is now upstream: another private feature might already include the same code.

Build the next integration candidate in a new branch/worktree, retaining this known candidate for rollback. Apply source branches and required compatibility adaptations, then rerun the feature tests before switching builds. This branch setup does not include an automatic rebuild/push job.
