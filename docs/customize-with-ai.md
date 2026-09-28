# Ask your AI agent to make a version for you

Copy the entire prompt below into an AI coding agent that can inspect a GitHub repository and edit files. Replace the bracketed workflow description; leave credentials and real folder IDs out of chat. An agent without repository/file access can help plan, but must not pretend it has created or tested anything.

```text
Help me create my own version of this Google Apps Script Drive folder-template copier:
https://github.com/bigpager/google-apps-script-drive-cloner

My workflow: [Describe what you repeatedly create, for example a project folder with a brief, budget Sheet, and subfolders for every new client.]

I am a beginner. Inspect the actual README, Code.gs, appsscript.json, tests, and cleanup review first. Do not assume this repo sends Gmail or edits spreadsheet cells: it copies Drive files and folder structure. Explain the existing behavior and limitations in plain language.

Before making changes, ask only the questions you need about my workflow: template types and button labels, destination folders, whether I am using a personal or managed Google account, and whether I need anything beyond copying. Do not ask me for passwords, OAuth tokens, confidential files, or real folder IDs in chat. Use descriptive placeholders in all shareable files and tell me where to enter IDs privately in the Apps Script editor.

Create a separate local teaching copy, leaving the original unchanged. Review the upstream license/attribution before redistribution; a public repo is not automatically open source. Keep attribution and never invent a license grant. Propose a small plan, then implement the agreed customization. Preserve duplicate-name checks, background copying, progress/skipped reporting, and recovery behavior. Keep destinations outside template trees. Do not silently add Gmail sending, spreadsheet mutations, external services, or extra OAuth scopes.

Use a disposable My Drive sandbox containing invented data and a small nested template. Explain exactly which files to copy into Apps Script, how to configure the manifest and folder IDs, how to install a personal Google Workspace add-on test deployment, what each permission allows, and how to uninstall/stop it. Never advise making my Drive folders public or bypassing an administrator's restrictions.

Run the existing local tests and add regression tests for your changes. Report the actual commands and results. Distinguish mock tests from a real Google integration test: do not claim a live test unless it was actually performed. Give me a manual smoke-test checklist that checks copied structure and file contents, unchanged originals, skipped items, duplicate-name behavior, and output sharing.

Keep real IDs, account details, credentials, and sensitive data out of public files AND git history. Ask for my explicit approval before creating/publishing a remote repo, pushing code, installing/deploying/authorizing an add-on, accessing real Drive documents, sending email, changing sharing, or deleting anything. Prefer a new sanitized git history for a public teaching copy. Do not attach or migrate the original private history.

Deliver the working files, a beginner-friendly README, tests, an explanation of changes, known limitations, and a verification checklist. Tell me what is implemented and tested, what still needs my Google-account test, and any blockers. Do not substitute plausible-looking results for tests you could not run.
```

**Start small:** customize labels and templates first. Gmail or Sheets workflows can be a separate iteration, with a fresh review of permissions and side effects. You remain responsible for reviewing the code and authorization screen before using it with your account.
