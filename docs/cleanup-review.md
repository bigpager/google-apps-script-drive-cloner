# Cleanup review

Reviewed teaching snapshot derived from DavisGroup commit `128158cd672323c76984cc4dc459cd426e71e94f` on 2026-09-28. This is a scoped code/documentation review, not a security certification or live Google integration test.

## Applied to this copy

- Replaced all six organization-specific Drive folder IDs with descriptive placeholders. Initialized new history instead of republishing the source history.
- Rewrote the two-line README into setup, authorization, smoke-test, troubleshooting, architecture, testing, and reuse documentation.
- Added a self-contained AI-agent customization prompt.
- Checked template access before creating the destination in both client and listing entry points, avoiding empty output folders when a template ID is missing/inaccessible.
- Validated template choices as own object keys rather than accepting inherited names such as `constructor`.
- Used null-prototype dictionaries for recovery file/folder name indexes, so names such as `__proto__` and `toString` are treated as ordinary Drive names.
- Added regression tests for these fixes and retained the existing resume/copy regression suite.
- Pointed the add-on icon at this repository's included PNG instead of the original external host; normalized manifest indentation.
- Omitted historical `docs/superpowers/` planning notes from the public teaching copy; these are not required to install or run the app. Kept executable code, test harness, and icon assets.
- Added clasp linkage/authorization exclusions to the inherited ignore file; it already excludes local environment files. Its unused framework entries are harmless and could be trimmed in a later maintenance pass.

## Opportunities deliberately left for a larger hardening pass

**Platform validation is the first priority:** inherited code assumes six-minute background execution and rapid one-shot trigger chaining. Google's current installable-trigger guide says add-ons can use time-driven triggers only once per hour, and its quota table lists a 30-second Google Workspace add-on runtime. Validate the exact test/installed deployment behavior before relying on the 4.5-minute slice setting or advertising large-copy support. A separate standalone worker architecture may be needed; mock tests are not evidence that these platform assumptions hold.

1. **Concurrent callbacks/workers:** user locks guard some writes but are advisory; destination-name check and creation are not transactional. Two users share a destination but not UserProperties or user locks. Do not promise exactly-once behavior under concurrent operations.
2. **Crash-consistent checkpoints:** job, cursor, and queue occupy separate property keys without a transaction. Name-based recovery is approximate. A robust production version should persist source-to-destination identities and exercise crashes between each storage write.
3. **Storage limits:** chunks stay under individual property limits, but the queue cap is not an aggregate property-store budget. Very wide trees may hit total storage limits before that cap. Error names and user-entered job names can also enlarge the stored job.
4. **Source/destination topology:** the user must keep destinations outside template trees. Add an ancestry preflight and tests before supporting untrusted configuration. The depth cap limits traversal; it is not a substitute for preventing self-copy.
5. **Failure paths:** folder creation or initial trigger creation can fail after preliminary validation; clearer rollback/recovery UX and tests would help. No blanket deletion of partial results should be added.
6. **UI text:** dynamic Drive names/error strings can contain markup characters understood by CardService. Escape/normalize text consistently while preserving the intentional `<br>` separators, and test rendering behavior on Google.
7. **Progress semantics:** `done` means traversal finished, potentially with skips; recovered counters can lag real output after a crash. Consider a dedicated 'Completed with skips' state rather than treating 100% as an integrity assertion.
8. **Scope and sharing:** full Drive access is broad. Do not silently replace it with `drive.file` and assume arbitrary configured folders still work. The script does not recreate sharing, ownership, revisions, or metadata as a backup would. Test shared-drive/shortcut behavior separately before advertising support.
9. **Maintainability:** client/listing entry points repeat setup logic. Extracting a shared job starter would be reasonable with new failure-path coverage, but a broad worker rewrite would make this teaching copy harder to compare with the original.
10. **Licensing:** the inspected source has no license file. Keep attribution; obtain an explicit license decision from the owner rather than adding an arbitrary license.

## Evidence and limits

- Baseline: `node tests/run.js` on the unchanged source: **50/50 passing**.
- Teaching copy after cleanup: `node tests/run.js`: **54/54 passing** with Node **v22.23.2**.
- These are local fake-service tests. No authorization flow, add-on installation, actual Drive copying, Google quotas, or multi-user behavior was verified against a live Google account as part of this review.
- The README's disposable-sandbox smoke test is the next required integration check before using real documents.
