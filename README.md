# Cloner: learn Google Apps Script with a useful Drive automation

![Cloner folder icon](assets/cloner-folder-branch-128.png)

Create a named copy of a Google Drive folder template—including nested folders and files—from a sidebar in Drive. Use it for a new project, client, course, or event instead of rebuilding the same folder structure by hand.

This is a cleaned-up teaching copy of [bigpager/DavisGroup](https://github.com/bigpager/DavisGroup), based on commit `128158cd672323c76984cc4dc459cd426e71e94f`. The original project stays unchanged. Its organization-specific folder IDs and development history are **not** included in this copy.

**[Read the illustrated walkthrough](https://marclar.tech/blog/google-apps-script-drive-folder-automation/)** · **[Copy the AI-agent customization prompt](docs/customize-with-ai.md)** · **[Cleanup review and limitations](docs/cleanup-review.md)**

## What it does—and does not do

- Offers Renter, Buyer, Commercial Lease, and Listing buttons inherited from the original real-estate workflow. You can change the display labels for your own workflow.
- Copies files and recreates nested folders in a new destination folder.
- Runs the copying work in background triggers, saves its position, and offers progress checks and recovery.
- Refuses a destination name that already exists in the selected parent folder.
- Reports skipped items; **Done does not mean every item copied successfully**. Always inspect the skipped list and resulting folder.

It does **not** send Gmail messages, read spreadsheet cells, duplicate source sharing permissions, or provide a backup/synchronization service. A Google Sheet can be copied as a Drive file; automating its contents is a separate feature. Recovery uses names and counts rather than a durable source-to-copy identity map. Do not edit the template or destination while a job is running or paused. Simultaneous use by several people is not hardened for production.

## Start with a disposable sandbox

You need a Google account that can use Apps Script and install a test Google Workspace add-on. A work/school administrator may restrict this. No paid Google Cloud services, API keys, or local Node installation are required for the browser setup. Node is only needed for the optional local tests.

In **My Drive**, make a private `Cloner Sandbox` folder with these children:

```text
Cloner Sandbox/
├── Renter Template/
│   ├── Welcome (a sample Google Doc)
│   └── Planning/
│       └── Checklist (a sample Google Sheet)
├── Buyer Template/
├── Commercial Template/
├── Listing Template/
├── Clients/
└── Listings/
```

Use invented information. Keep `Clients` and `Listings` **outside** all the template trees. Never point a destination into its source template: the copier can encounter its own output. Do not use client records, shared drives, or your only copy of important documents for the first test.

## Install your own test add-on

1. Open [script.google.com](https://script.google.com/) using the same account as the sandbox. Create a **New project** and name it `Drive Cloner Sandbox`.
2. Replace the editor's `Code.gs` with this repository's [`Code.gs`](Code.gs). Do not paste the `tests/` files into Apps Script.
3. Open **Project Settings** (gear icon) and enable **Show "appsscript.json" manifest file in editor**. Return to the editor and replace the manifest with [`appsscript.json`](appsscript.json). Keep the V8 runtime. Change `timeZone` if appropriate.
4. Configure the six IDs below in your **private Apps Script editor**. For each folder, open it in Drive and copy the portion after `/folders/` in its URL, excluding query parameters. Paste only that ID between the existing quotes—not the whole URL.

   | Setting in `Code.gs` | Sandbox folder |
   | --- | --- |
   | `CLIENTS_FOLDER_ID` | Clients |
   | `LISTINGS_FOLDER_ID` | Listings |
   | `LISTING_TEMPLATE_ID` | Listing Template |
   | `TEMPLATES.renter.id` | Renter Template |
   | `TEMPLATES.buyer.id` | Buyer Template |
   | `TEMPLATES.commercial.id` | Commercial Template |

   Leave the public repository's `PASTE_*` placeholders unchanged. A folder ID is not a password, but publishing internal identifiers is unnecessary. Do not make your Drive folders public to make this script work.

5. Save the project. Choose **Deploy → Test deployments**. If prompted, choose the **Google Workspace Add-on** deployment type. Use **Install** to install the test add-on for your account. This is not a web-app deployment or a Marketplace publication.
6. Open or reload [Google Drive](https://drive.google.com/) in that account. Expand the right-side panel if hidden, and select the Cloner icon. Complete the authorization flow when asked. If the test deployment does not appear, check the account, manifest, and administrator policy against [Google's test-add-on instructions](https://developers.google.com/workspace/add-ons/how-tos/testing-workspace-addons).
7. Review the permissions before accepting. This manifest requests full **Drive** access (`drive`) to open your configured folders and copy files, and **script trigger management** (`script.scriptapp`) to schedule the worker. The folder IDs restrict the code's intended operation, **not** the breadth of the OAuth grant. It requests no Gmail or Sheets-specific scope. Install only code you have reviewed and trust.

An unverified-app warning can occur for a personal test project. Verify that the project is the one you created and review the code and permissions; do not bypass warnings for unfamiliar software. If your administrator blocks installation or authorization, stop and ask them. You do not need to publish the app publicly or change organizational security policies to follow this tutorial. Standard Cloud project and OAuth setup may be necessary for other testing/distribution arrangements; follow Google's documentation rather than enabling billing or unrelated APIs blindly.

**Do not press Run on `onCreate` as your first test:** it expects an event from the sidebar. Start from the add-on instead. You also do not need to create a recurring trigger manually—the code creates one-shot workers.

## Verify the first copy

1. In Cloner, enter `Demo Client 01` and click **Create new Renter** once.
2. Use **Check progress**. The card is a snapshot, not a live dashboard. Triggers can start later than their requested delay.
3. Use **Open folder** to inspect `Clients/Demo Client 01`. It should contain the sample Doc and the nested `Planning/Checklist` Sheet.
4. Wait for completion, read any **Skipped** entries, and open the copied files. Confirm the originals still exist and have not changed. Compare the folder/file structure manually; counters after an interrupted execution are not an integrity check.
5. Inspect the destination's sharing. New items may inherit the destination folder's access; the script does not recreate the template's sharing settings.
6. Choose **Start another**, then try the same name. The duplicate-name warning should refuse a new folder. Use another name for another independent test.
7. Optionally test **Create listing** after putting one sample document in `Listing Template`.

### If something goes wrong

| Symptom | What to check |
| --- | --- |
| Cannot open a folder | Correct folder ID, correct Google account, and access to that folder. The copy now checks source access before creating a destination. |
| Copy seems stuck | Refresh with **Check progress**; inspect Apps Script **Executions** for errors. Trigger delays, permissions, and quotas can interrupt work. |
| Resume appears | Read the error first. **Resume** uses the same partially filled folder. Fix permissions or wait for a quota reset if needed; repeatedly pressing Resume will not remove a quota limit. |
| Skipped items | Review the reasons and resulting folder. Unsupported/unreadable items may not copy. |
| Same name already exists | Open the existing folder. Resume an unfinished job, or deliberately rename/remove its disposable output before starting anew. |
| Want to abandon a job | **Start over** clears job state and queued worker triggers but leaves copied files in Drive. A currently running operation may take time to stop. Inspect the output before any manual deletion. |

To finish testing, uninstall the test deployment in Apps Script's **Test deployments** screen and check the **Triggers** page for any remaining `runCloneJob` trigger. Remove that trigger if present. Review account access at [Google Account connections](https://myaccount.google.com/connections). Delete only sandbox output you have inspected and no longer need.

## How the code is organized

| File or function | Role |
| --- | --- |
| `Code.gs` | The complete add-on and copy worker; no external libraries |
| `appsscript.json` | Drive host, homepage callback, logo, timezone, and OAuth scopes |
| `onHomepage` | Builds the sidebar form or current status card |
| `onCreate` / `onCreateListing` | Validate the request, create a destination, save a job, schedule work |
| `runCloneJob` | Copies within a time budget, saves progress, chains a continuation when needed |
| `onCheckProgress` / `onResume` / `onReset` | Refresh, recover, or abandon the job |
| `tests/` | Local fake Google services and regression tests |
| `assets/` | Original Cloner icon, reused for this educational copy |

The worker walks a queue of folders instead of keeping its entire position in a recursive call stack. It stores progress in per-user script properties and uses continuation tokens when available. The voluntary slice budget is 4.5 minutes, with a 20-slice chain cap and 20-level nesting cap. These are code settings, **not a guarantee that your account has that much quota available**. Consult [current Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas). Very wide trees can also exceed the total property-store limit even though individual values are chunked.

**Important platform caveat:** the inherited worker assumes a background trigger can use a longer runtime than the sidebar callback and requests another trigger after one second. Google's [installable-trigger guide](https://developers.google.com/apps-script/guides/triggers/installable) says add-ons can use time-driven triggers at most once per hour, and its quota table lists a 30-second Google Workspace add-on runtime. Do not treat this repository's 4.5-minute slicing or rapid chaining as a verified platform guarantee. These assumptions need a live test in your exact deployment; large-copy support may require a separately designed standalone worker. Keep the first template tiny, inspect Executions, and stop if trigger/runtime limits prevent completion. The local tests cannot validate these platform rules.

## Run the local tests

With a current Node.js LTS installed (checked here with Node 22):

```sh
git clone https://github.com/bigpager/google-apps-script-drive-cloner.git
cd google-apps-script-drive-cloner
node tests/run.js
```

No `npm install` is needed. Tests simulate Drive, cards, time, triggers, and properties. They cover nested copying, skipped files, duplicates, progress, chunked state, interruptions, continuation, and recovery. They do **not** authenticate to Google, prove OAuth installation works, or certify real-world quota/concurrency behavior. Run the sandbox checklist above for a real integration test.

## Make it yours

Start by changing the display labels in `TEMPLATES` and the sidebar hints. Keep its internal keys and callback names until you understand their references. For deeper changes, [give your AI agent this self-contained customization prompt](docs/customize-with-ai.md). Require a small, reviewable change and tests before adding Gmail sending, spreadsheet updates, or new scopes.

## Attribution and reuse

Adapted from the user-provided [DavisGroup project](https://github.com/bigpager/DavisGroup), with its code and icon credited to that source. No upstream license file was present in the inspected snapshot. This educational copy does not invent or substitute a license grant; public visibility alone is not an open-source license. Ask the owner about licensing before redistribution outside the authorized teaching copy.
