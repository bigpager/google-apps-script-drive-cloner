# Ask an AI agent to help with your one-folder copier

Copy this entire prompt into an AI coding agent with repository/file access. Replace the bracketed description with the harmless contents you want in Clonable. Do not paste private folder IDs or credentials into chat.

```text
Help me set up and, only where agreed, customize this Google Apps Script Drive copier:
https://github.com/bigpager/google-apps-script-drive-cloner

My practice contents: [For example, Welcome Doc, Checklist Sheet, and Documents/Samples/sample.txt for a project.]

I am a beginner. Read the actual README, Code.gs, appsscript.json, tests, and docs/cleanup-review.md before changing anything. Explain Apps Script and the current behavior in plain language. This app copies Drive folders/files only; it does not send Gmail or edit spreadsheet cells.

Preserve this exact contract: one regular My Drive source folder named Clonable, one start button labeled Copy to Cloned, no name input or template selector. Configure exactly const CLONABLE_FOLDER_ID = 'PASTE_CLONABLE_FOLDER_ID'; in shareable code. Tell me to replace only that placeholder privately in Apps Script, not in chat or public files. Do not add a parent/output ID or a separate destination folder to set up.

Before output is created, verify the source name is exactly Clonable and resolve exactly one accessible parent. Refuse a wrong name, no accessible parent, or ambiguous parents. Require source read/copy access and parent write access. Create the fixed output Cloned as a sibling of Clonable, directly in My Drive or in its optional Cloner Sandbox parent. Refuse an existing sibling Cloned; never overwrite or delete it. Preserve the existing resumable background worker, Check progress, Open folder, skipped-item reporting, Resume, and reset controls.

Resume must continue the saved job in the same partial Cloned. Reset clears job state and queued triggers, not copied files; an in-flight operation may take time to stop. A fresh copy needs the existing Cloned deliberately renamed or removed only after activity stops and after inspection. Do not change either tree while a job is running or paused.

Ask only necessary questions about my account restrictions, sample contents, or proposed changes. Do not ask for passwords, tokens, real folder IDs, or confidential files. Work in a separate local copy and leave the original unchanged. No license is currently supplied; do not invent a license grant or assume public visibility permits redistribution. Propose a small plan and implement only agreed changes. Do not silently add Gmail sending, spreadsheet mutations, external services, or OAuth scopes.

Give beginner setup instructions using invented data: create only Clonable and sample contents, copy Code.gs and appsscript.json into Apps Script, configure the single ID privately, and install a personal Google Workspace Add-on test deployment. Explain the broad Drive and script trigger management permissions; the single ID does not narrow the permission grant. Never make folders public or bypass administrator restrictions. Explain how to stop/uninstall the test add-on.

Run the local regression suite and add tests for any changes. Report actual commands/results, without inventing a test count. Distinguish simulated Google services from a live Google integration test. Preserve the unresolved caveat: Google's documented 30-second add-on runtime and at-most-hourly add-on time-driven triggers conflict with assumptions behind the worker's longer slices and rapid chaining. If live testing hits those limits, report the blocker and propose a separately approved design rather than claiming it works.

Give a manual smoke test for sibling placement, copied contents, unchanged originals, skipped items, sharing, existing-Cloned refusal, wrong-name/no-parent failures before output, and Resume using the same partial Cloned. Do not claim live testing unless actually performed.

Keep sensitive data, account details, real IDs, and credentials out of public files and git history. Ask for explicit approval before pushing, publishing, installing, deploying, authorizing, accessing real documents, changing sharing, sending email, or deleting anything. Do not rewrite or migrate history.

Deliver the working files, beginner README, tests, change summary, limitations, and verification checklist. Say what was actually tested, what still requires my Google-account test, and what is blocked. An agent without repository access must not pretend it edited or tested files.
```

Start by changing Clonable's contents, not the fixed names or button. Any later Gmail or Sheets automation is a separate feature with its own permission and side-effect review.
