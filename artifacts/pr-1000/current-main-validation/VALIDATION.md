# PR #1000: current-main UI step 4b validation

Result: PASS for the targeted Windows UI path. This is local task-candidate evidence, with an identical GitHub PR integration tree. It is not a claim that remote CI or merge gates passed.

## Revisions

- Tested task candidate: `d1656d5c8c3151a8bf6c7fa37bfacf4d53898d7b`.
- Target main at preparation and pre-push verification: `71ca7003460b134c632772caa90b4d722ad876ff`.
- PR integration candidate: `336e9a66171c32d7ff5ca0d6eb4bc00a9e605e53`.
- Both candidates have executable tree `26e7f5db6c6cb8bab260d5f4f1240f039250327e`.
- Previous PR head `e48351990199b7f053928f6e1e72d4a0f4cd7f9b` is preserved as the merge parent; no force push.
- Packaged ZIP SHA-256: `6a80e6eea87534fba8ca0ed77baa2f07ffd637eb6a10936db3c84bbe298b849e`.

## Environment and method

Windows 11 x64, packaged PI-Desktop 0.17.0 ZIP, Chinese UI, dark theme. Data, browser profile, agents directory, home and update cache were isolated. Two synthetic providers share a display name, vendor key and model ID. Both use authKind=none and a non-serving loopback endpoint. No credentials or model requests were used.

All edits and navigation were performed through native Windows UI input. Original screenshots record the window. Read-only inspection of the live renderer DOM verifies aria-label strings; production IPC reads verify Rust-owned persisted definitions. Native UI Automation did not expose useful accessible names, so this does not claim a screen-reader audit.

## UI step 4b

| Native user action | Observed result |
| --- | --- |
| Create a subagent, add provider A, save and reopen | Friendly provider/model label; move/remove aria-labels match; stored pin remains A/model |
| Add same-name provider B | Both rows and action aria-labels include their distinct provider IDs |
| Move A down, save and reopen | Order B,A persists; pins keep their exact provider IDs |
| Disable provider A on the Models page and reopen | Unavailable A pin stays visible; move/remove actions remain enabled as applicable |
| Move unavailable A up | The correct unavailable row moves to the first position |
| Remove unavailable A, save and reopen | Only B remains; friendly label returns; B's stored provider ID is unchanged |

Raw synthetic observations: [UI-4b-results.json](UI-4b-results.json). Offline calls to the production `resolveSubagentProviders` implementation confirm saved pins resolve to the intended provider IDs: [runtime-binding-results.json](runtime-binding-results.json).

## Checks actually run

- PASS: `pnpm build:js`.
- PASS: `cargo build --release --locked -p host-core`.
- PASS: `pnpm --filter @pi-desktop/desktop typecheck`.
- PASS: `pnpm --filter @pi-desktop/desktop lint`.
- PASS 3/3: `node --test apps/desktop/test/composer-menu-style-tokens.test.mjs apps/desktop/test/subagent-fallback-label.test.mjs`.
- PASS: `pnpm bundle:runtime` (from `apps/desktop`) and Windows x64 ZIP packaging.
- PASS: `node scripts/check-pr-base-main.mjs --base upstream/main --head HEAD`.
- PASS: independent artifact inspection matched all 129 ZIP files, 244 ASAR build outputs, 73 runtime outputs, and the x64 host binary.
- PASS: targeted actual UI path and offline runtime binding checks above.

Full repository tests, real-provider execution, macOS/Linux UI, and installer qualification were NOT RUN for this targeted evidence. Remote CI results must be read from the PR for this head; older green checks do not apply to it.

## Original test screenshots

- [Single provider after save/reopen](screenshots/01-single-provider-reopened.jpg)
- [Two same-name providers](screenshots/02-duplicate-providers.jpg)
- [Reordered and reopened](screenshots/03-moved-saved-reopened.jpg)
- [Disabled provider remains visible](screenshots/04-disabled-provider-visible.jpg)
- [Disabled provider removed and reopened](screenshots/05-disabled-removed-reopened.jpg)

The separately supplied user-selected screenshot is the requested visual illustration from an earlier run. It is not substituted for this candidate's step-4b evidence.

