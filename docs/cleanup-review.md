# Cleanup review: current one-folder behavior

This is a scoped teaching review, not a security certification or a live Google integration test. The README is the setup guide; this document separates the current contract from future hardening work.

## Current behavior

- One source: a regular My Drive folder named exactly `Clonable`. The only private configuration is `const CLONABLE_FOLDER_ID = 'PASTE_CLONABLE_FOLDER_ID';` with the placeholder replaced in Apps Script, not public files.
- One start button: **Copy to Cloned**. There is no name field, template choice, parent ID, output ID, or separate destination setup.
- Before creating output, the start path checks source access/name and resolves exactly one accessible parent. A wrong name, no accessible parent, or ambiguous parents fails without output. The user needs read/copy access to the source and write access to the parent.
- Output is fixed: **Cloned is a sibling of Clonable**, either directly in My Drive or in the optional Cloner Sandbox. An existing sibling Cloned is refused, never overwritten or deleted.
- The same resumable worker copies files and nested folders, saving a queue and cursor. Progress, Open folder, skipped-item reporting, Resume, and reset controls remain.
- Resume reuses the same partial Cloned. Reset clears job state and queued triggers, not Drive output. An in-flight operation may take time to stop. Another fresh copy requires deliberately renaming/removing old Cloned only after activity stops.
- Recovery uses name/count comparisons with null-prototype name indexes. This avoids treating special object-property names as inherited entries, but is not a durable source-to-copy identity map.
- Documentation uses a tiny generic example: Welcome Doc, Checklist Sheet, and Documents/Samples/sample.txt. First-run setup creates only Clonable and its sample contents.
- The manifest requests broad Drive access and script trigger management. The single configured ID does not narrow the OAuth grant. No email sending or spreadsheet-cell editing is implemented.

## Future opportunities and remaining limitations

**Platform validation comes first.** The existing worker assumes a longer background budget, uses a voluntary 4.5-minute slice, and requests rapid one-shot continuation. Google's [quota table](https://developers.google.com/apps-script/guides/services/quotas) lists a **30-second Google Workspace add-on runtime**. Its [installable-trigger guide](https://developers.google.com/apps-script/guides/triggers/installable) says add-ons may use time-driven triggers **at most once per hour**. These assumptions remain unresolved for this exact deployment. A separately designed standalone worker may be necessary. Mocks cannot establish that the platform permits the scheduling design.

1. **Concurrency:** advisory user locks and per-user properties do not coordinate all users. Checking for Cloned and creating it is not a transaction. Do not promise exactly-once behavior under overlapping executions.
2. **Crash consistency:** job, cursor, and queue occupy separate property keys. Interrupted writes and approximate name-based recovery need stronger identity-based reconciliation before production use. Do not edit, move, or rename either tree while running or paused.
3. **Storage:** chunking protects individual property values, not the total store. Very wide trees and long error strings can still exhaust storage. Depth and chain caps are safety limits, not capacity guarantees.
4. **Scope of folder support:** sibling placement avoids deliberately placing output inside the source. Continue to restrict setup to regular My Drive folders. Shared drives, shortcuts, unusual topology, and moves during execution need separate design and live tests before support is advertised.
5. **Failure paths:** parent permission changes, output creation, state persistence, or initial trigger creation can fail after validation. Partial output may remain. Improve recovery/error messages without adding blanket deletion or automatic overwrite.
6. **Card rendering:** Drive names and errors can contain markup characters. Consistent escaping and actual CardService rendering checks remain useful hardening work.
7. **Progress semantics:** Done means traversal ended, potentially with skips. Counters after interruption are not content verification. A clearer completed-with-skips status could help.
8. **Permissions and sharing:** broad Drive access deserves explicit review. Do not substitute a narrower scope and assume access to arbitrary configured folders still works. Source permissions, ownership, revisions, and metadata are not reproduced as a backup would preserve them. Inspect output sharing.
9. **Licensing:** no license is currently supplied. Obtain an explicit decision from the owner; do not manufacture a license grant or replacement attribution.

## Evidence and next checks

The local regression suite uses fake Google services. Run `node tests/run.js` for actual results; this document intentionally does not pin a test count. The implementation owner verifies the final suite after code changes.

No authorization flow, add-on installation, actual Drive copying, quota behavior, or multi-user execution is claimed as live-tested here. Run the README's disposable smoke test before important documents. Include negative checks for a wrong source name, no accessible parent, missing parent write access, and existing Cloned, plus a recovery check that Resume uses the same partial output. Build and publication verification are separate from this documentation review.
