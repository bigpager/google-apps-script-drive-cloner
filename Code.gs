/**
 * Cloner — copies Clonable into a sibling folder named Cloned in Google Drive.
 *
 * The copy runs in a background trigger because add-on card
 * callbacks are capped at 30 seconds.
 *
 * Progress reporting: the worker starts copying immediately and walks the
 * template exactly once, discovering items as it goes. There is no denominator
 * — a total would require a second full walk of the tree, and any number
 * short of that is a guess — so the bar is indeterminate while running and the
 * card reports copied-of-discovered counts instead. Cards cannot poll (no
 * client-side script), so the card shows a snapshot plus a "Check progress"
 * button that redraws it from the latest stored counts.
 *
 * A job stays on screen until the user dismisses it with "Start another" or
 * "Start over", so a finished run's folder link and skipped list survive the
 * sidebar being closed and reopened.
 */

// Configure only the source ID in your private Apps Script editor.
// Cloned is created alongside Clonable, never inside it.
const CLONABLE_FOLDER_ID = 'PASTE_CLONABLE_FOLDER_ID';
const SOURCE_NAME = 'Clonable';
const COPY_NAME = 'Cloned';
const JOB_KEY = 'cloneJob';
/** In-flight position inside the folder being copied right now. */
const CURSOR_KEY = 'cloneCursor';
/** Pending folder pairs, chunked: cloneQueue.0, cloneQueue.1, … */
const QUEUE_KEY_PREFIX = 'cloneQueue.';
const WORKER_FN = 'runCloneJob';

/** UserProperties refuses any single value over this. */
const MAX_PROPERTY_BYTES = 9 * 1024;
/** Queue chunk target, kept under the ceiling with room for the wrapper. */
const QUEUE_CHUNK_BYTES = 8 * 1024;
/** Safety stop when probing for queue chunks. */
const MAX_QUEUE_CHUNKS = 200;

/**
 * Voluntary pause point, well short of the 6-minute hard limit. The check is
 * *between* items, so the remaining budget has to absorb one worst-case
 * makeCopy — a large binary takes many seconds and cannot be interrupted —
 * plus the checkpoint writes and the trigger creation.
 */
const SLICE_MS = 4.5 * 60 * 1000;
/**
 * Chained slices before the job stops and asks. Time-driven triggers share a
 * daily runtime quota; without a cap a pathological tree chains until the quota
 * dies mid-run and the user sees a stall with no explanation.
 */
const MAX_SLICES = 20;
/**
 * Deepest pair the walk follows. Drive folders may have several parents, so a
 * "tree" is not guaranteed acyclic; a visited set is unbounded and cannot be
 * stored, while a depth cap is O(1) and turns a cycle into a recorded skip.
 */
const MAX_DEPTH = 20;
/** How long a checkpoint waits for the user lock before going without it. */
const LOCK_WAIT_MS = 5 * 1000;

/** Minimum gap between heartbeat writes while copying. */
const WRITE_INTERVAL_MS = 2 * 1000;
/** Copy attempts — successful or not — between forced persistence writes. */
const WRITE_EVERY_ATTEMPTS = 5;
/**
 * No heartbeat for this long while "running" means the chain broke. Heartbeats
 * fire every couple of seconds *during* a slice, so the only quiet window is
 * the handover between slices — trigger dispatch is usually seconds but can be
 * minutes under load, and a tighter bound false-positives on a healthy job.
 */
const STALL_MS = 6 * 60 * 1000;
/** Width of the text progress bar drawn on the card. */
const BAR_CELLS = 20;
/** How many individual skip reasons the job keeps; the rest are summarised. */
const MAX_SKIPPED_DETAILS = 25;
/** Longest a single skip reason may be before it is trimmed. */
const MAX_SKIP_DETAIL_CHARS = 160;

/* ---------------------------------------------------------------- UI */

function onHomepage(e) {
  const job = readJob_();
  // Any job the user has not cleared stays on screen, not just a running one.
  // A finished run keeps its folder link and skipped list reachable after the
  // sidebar is closed and reopened; "Start another" is what dismisses it.
  if (job) {
    return statusCard_(job);
  }

  const section = CardService.newCardSection()
    .addWidget(
      CardService.newTextParagraph().setText(
        'Copy Clonable and its contents into a new sibling folder named Cloned. ' +
        'The original stays unchanged. An existing Cloned folder is never overwritten.'
      )
    )
    .addWidget(
      CardService.newTextButton()
        .setText('Copy to Cloned')
        .setOnClickAction(
          CardService.newAction().setFunctionName('onCreate')
        )
    );

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Cloner'))
    .addSection(section)
    .build();
}

/** One fixed source and output; event parameters cannot redirect the copy. */
function onCreate(e) {
  const running = readJob_();
  if (running && running.status === 'running') {
    return notify_('A clone is already running. Wait for it to finish.');
  }

  let source;
  let parent;
  try {
    source = DriveApp.getFolderById(CLONABLE_FOLDER_ID);
    if (source.getName() !== SOURCE_NAME) {
      return notify_('The configured source must be named Clonable. Check its name and folder ID.');
    }
    const parents = source.getParents();
    if (!parents.hasNext()) {
      return notify_('Cannot find the parent of Clonable. Use a regular folder in My Drive.');
    }
    parent = parents.next();
    if (parents.hasNext() || parent.getId() === source.getId()) {
      return notify_('Clonable must have one distinct parent folder. Nothing created.');
    }
    if (parent.getFoldersByName(COPY_NAME).hasNext()) {
      return notify_('Cloned already exists alongside Clonable. Nothing created.');
    }
  } catch (err) {
    return notify_('Cannot open Clonable or its parent: ' + err.message);
  }

  let target;
  try {
    target = parent.createFolder(COPY_NAME);
  } catch (err) {
    return notify_('Cannot create Cloned alongside Clonable: ' + err.message);
  }

  const job = newJob_({
    label: SOURCE_NAME,
    sourceId: source.getId(),
    name: COPY_NAME,
    target: target,
  });
  // A new job starts from nothing. Anything left over is a previous job's
  // position, and reading it back would copy this template into that target.
  clearResumeState_(job);
  persistJob_(job);

  clearWorkerTriggers_();
  ScriptApp.newTrigger(WORKER_FN).timeBased().after(1000).create();

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(statusCard_(job)))
    .setNotification(
      CardService.newNotification().setText('Started copying Clonable to Cloned')
    )
    .build();
}

/** Redraws the status card from the job's latest stored totals. */
function onCheckProgress(e) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(statusCard_(readJob_())))
    .build();
}

function onReset(e) {
  // Drop the queued worker first. Otherwise a trigger created moments ago
  // still fires, and its writeJob_ would resurrect the job we just cleared.
  clearWorkerTriggers_();
  const lock = tryLock_();
  try {
    PropertiesService.getUserProperties().deleteProperty(JOB_KEY);
    // The cursor and queue outlive the job record they belong to unless they
    // go with it, and a stranded queue would be read back by the next job.
    clearResumeState_(null);
  } finally {
    releaseLock_(lock);
  }
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(onHomepage(e)))
    .build();
}

/**
 * Carries on a job that stopped without finishing — a continuation trigger
 * that never fired, or a job that hit the slice cap.
 *
 * The same job id and the same destination, deliberately: the folder is
 * already there and already holds part of the template, and re-creating it is
 * what the duplicate-name check refuses anyway. The phase is put back to
 * `copying` rather than left at `paused`, so the worker treats the saved
 * position as approximate and reconciles the folder it was in the middle of —
 * we cannot know how much of the interrupted slice actually reached Drive.
 *
 * "Start over" is still the way to discard a clone; this never deletes.
 */
function onResume(e) {
  const job = readJob_();
  if (!job) return notify_('There is nothing to resume.');
  if (job.status === 'done') return notify_('That clone has already finished.');

  // Any trigger still queued for the old attempt would double up with the one
  // created below, and two workers on one job is the one thing the id check
  // cannot help with.
  clearWorkerTriggers_();

  const lock = tryLock_();
  try {
    job.status = 'running';
    job.phase = 'copying';
    job.error = '';
    // A fresh chain. Keeping the spent count would stop the job again on its
    // very first pause, which is exactly the state the user is resuming from.
    job.slices = 0;
    // persistJob_ restamps updatedAt, which is what clears the stall.
    persistJob_(job);
  } finally {
    releaseLock_(lock);
  }
  ScriptApp.newTrigger(WORKER_FN).timeBased().after(1000).create();

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(statusCard_(job)))
    .setNotification(
      CardService.newNotification().setText('Resuming "' + job.name + '"')
    )
    .build();
}

/* ------------------------------------------------------------ WORKER */

/** A fresh job record for the copy worker. */
function newJob_(spec) {
  return {
    status: 'running',
    // There is no counting phase any more: the worker copies from the start.
    phase: 'copying',
    label: spec.label,
    sourceId: spec.sourceId,
    name: spec.name,
    targetId: spec.target.getId(),
    url: spec.target.getUrl(),
    // Copied so far.
    folders: 0,
    files: 0,
    // Seen so far while walking. A floor, never a denominator.
    discoveredFolders: 0,
    discoveredFiles: 0,
    // Copy attempts, successful or not. Paces persistence writes.
    attempts: 0,
    // Written by a build that keeps a resumable cursor and queue. A job
    // without it predates them and has to be reconciled against whatever is
    // already in the destination — see seedState_.
    resumable: true,
    // True once the traversal queue has been seeded from the template root, so
    // an empty queue means "finished", not "not started".
    seeded: false,
    // Queue size metadata only; the pairs themselves live under their own keys.
    queueChunks: 0,
    pending: 0,
    // Identifies this run. A worker only writes while its id is still the
    // stored one, so a reset or a newly started job cannot be undone by a
    // worker that was already in flight.
    id: newJobId_(),
    startedAt: Date.now(),
    skipped: [],
    skippedCount: 0,
    error: '',
  };
}

/**
 * Runs in the background with the full 6-minute script budget, and hands over
 * to another trigger if the tree does not fit in one.
 */
function runCloneJob() {
  clearWorkerTriggers_();

  const job = readJob_();
  if (!job || job.status !== 'running') return;

  sliceStartedAt_ = Date.now();
  job.slices = (job.slices || 0) + 1;

  try {
    const sourceId = job.sourceId;
    if (!sourceId) throw new Error('The saved job has no source folder. Start over.');

    // Resolve both ends up front. A template or target that has gone missing
    // is a job-level failure the user must see, not a per-folder skip.
    DriveApp.getFolderById(sourceId);
    DriveApp.getFolderById(job.targetId);

    // Whether the previous slice stopped on its own terms. A clean pause wrote
    // its continuation tokens before it went; anything else — a kill at the
    // hard limit, a crash — left a cursor that may lag what is really in the
    // destination, and that gap is what the reconcile path exists to close.
    const cleanPause = job.phase === 'paused';

    // Straight into copying. The old pre-pass walked the whole tree just to
    // produce a denominator, which doubled every Drive listing and burned
    // budget before a single file moved.
    job.phase = 'copying';
    const state = readState_(job);
    if (state.cursor && !cleanPause) state.cursor.reconcile = true;
    if (!state.cursor && !state.queue.length && !job.seeded) {
      seedState_(job, state, sourceId);
    }
    traverse_(job, state);
    if (job.cancelled) return;
    if (state.paused) {
      pauseJob_(job, state);
      return;
    }
    job.status = 'done';
    job.phase = 'done';
    job.pending = 0;
    clearResumeState_(job);
  } catch (err) {
    if (job.cancelled) return;
    job.status = 'error';
    job.phase = 'error';
    job.error = err.message;
  }
  // Older builds stored the item being copied here. Nothing renders it, and a
  // single long Drive name pushed the one 9 kB job value over the limit — which
  // made even this final write fail and stranded the job as "running".
  delete job.current;
  writeJob_(job);
}

/**
 * Records one skipped item. The running total is always exact; the individual
 * reasons are capped and trimmed, because UserProperties holds the whole job
 * in a single 9 kB value and a template full of permission errors would
 * otherwise grow the list until every write fails.
 */
function recordSkip_(job, detail) {
  job.skippedCount = (job.skippedCount || 0) + 1;
  if (!job.skipped) job.skipped = [];
  if (job.skipped.length >= MAX_SKIPPED_DETAILS) return;
  const text = String(detail);
  job.skipped.push(
    text.length > MAX_SKIP_DETAIL_CHARS
      ? text.slice(0, MAX_SKIP_DETAIL_CHARS - 1) + '…'
      : text
  );
}

/**
 * Persists after every WRITE_EVERY_ATTEMPTS attempts, and otherwise leaves it
 * to the elapsed-time heartbeat. Counting attempts rather than successes is
 * what keeps a long run of failures both cheap and visible: the old
 * `files % 5` test never advanced while nothing succeeded, so it wrote on
 * every single failure.
 */
function afterAttempt_(job, state) {
  job.attempts = (job.attempts || 0) + 1;
  if (job.attempts % WRITE_EVERY_ATTEMPTS === 0) heartbeat_(job, state);
  else if (Date.now() - lastWriteAt_ >= WRITE_INTERVAL_MS) heartbeat_(job, state);
}

/**
 * Breadth-first walk over a queue of {srcId, dstId, depth} pairs.
 *
 * The recursion this replaces held its position in the tree in the V8 call
 * stack and in live Drive iterators, and neither survives the end of an
 * execution — which is precisely why a clone could not be resumed. A queue of
 * ids serialises; a call stack does not.
 *
 * Breadth-first rather than depth-first for three reasons: the queue needs no
 * depth semantics to round-trip, the top of the tree appears in Drive first so
 * the "Open folder" link is useful earlier, and it buys the invariant the
 * resume path depends on — a destination subfolder that exists but is not in
 * the queue was created by an aborted pass, and is therefore empty.
 */
function traverse_(job, state) {
  while (state.cursor || state.queue.length) {
    if (job.cancelled) return;
    if (!state.cursor) {
      // Never start a pass we cannot finish: the deadline is checked between
      // items, so a fresh pass needs the whole remaining budget in front of it.
      if (outOfTime_()) {
        state.paused = true;
        return;
      }
      const pair = state.queue.shift();
      state.cursor = {
        s: pair.s, d: pair.d, depth: pair.depth || 0, stage: 'files',
        ftok: null, gtok: null, restored: false, reconcile: false,
      };
      // Claim the folder before touching it. A pass that dies without this
      // would look untouched on resume, and its copied items would be made a
      // second time.
      if (!checkpoint_(job, state, false)) return;
    }
    runPass_(job, state);
    if (job.cancelled) return;
    if (state.paused) return;
    state.cursor = null;
    state.iter = null;
    state.queueDirty = true;
    // The finished pair leaves the stored queue here, which is also what
    // retires the cursor that named it — see readState_.
    if (!checkpoint_(job, state, true)) return;
  }
}

/** True once this slice has used its voluntary budget. */
function outOfTime_() {
  return Date.now() - sliceStartedAt_ >= SLICE_MS;
}

/**
 * One pass: copy every file of the cursor's source folder into its
 * destination, then create every subfolder and queue it.
 *
 * A pass that cannot list its source is skipped, not fatal — the same
 * tolerance the recursive version had for an unreadable subtree.
 */
function runPass_(job, state) {
  const cursor = state.cursor;
  let src;
  let dst;
  try {
    src = DriveApp.getFolderById(cursor.s);
    dst = DriveApp.getFolderById(cursor.d);
  } catch (err) {
    recordSkip_(job, err.message);
    return;
  }

  if (cursor.stage === 'files') {
    // A source folder that cannot be listed is skipped once, not twice: there
    // is no point asking the same folder for its subfolders.
    if (!copyFiles_(job, state, src, dst)) return;
    if (job.cancelled || state.paused) return;
    cursor.stage = 'folders';
  }

  createFolders_(job, state, src, dst);
}

/**
 * Files of one source folder. Nothing per-item is kept on the job.
 *
 * Three ways in: fresh from the queue, resumed from a continuation token, or —
 * when there is no usable token — replayed from the start against a multiset of
 * what the destination already holds. Only the third costs an extra listing,
 * and only one folder is ever in that state at a time.
 */
function copyFiles_(job, state, src, dst) {
  const cursor = state.cursor;
  const resumed = resumeIterator_(job, cursor, 'files', src, dst);
  if (!resumed) return false;
  const files = resumed.iter;
  const already = resumed.reconcile ? destFileCounts_(dst) : null;

  state.iter = files;
  while (files.hasNext()) {
    if (job.cancelled) return false;
    const file = files.next();
    let fileName = '(unreadable file)';
    try {
      fileName = file.getName();
      // Counted, not tested for membership: Drive permits duplicate names in
      // one folder, and a plain has/has-not check would silently drop the
      // second copy of a name that legitimately appears twice.
      if (already && already[fileName] > 0) {
        already[fileName] -= 1;
        continue;
      }
      job.discoveredFiles = (job.discoveredFiles || 0) + 1;
      file.makeCopy(fileName, dst);
      job.files++;
    } catch (err) {
      recordSkip_(job, fileName + ' — ' + err.message);
    }
    afterAttempt_(job, state);
    if (pauseHere_(job, state)) return true;
  }
  state.iter = null;
  return true;
}

/** Subfolders of one source folder, each queued once its twin exists. */
function createFolders_(job, state, src, dst) {
  const cursor = state.cursor;
  const resumed = resumeIterator_(job, cursor, 'folders', src, dst);
  if (!resumed) return;
  const folders = resumed.iter;
  const already = resumed.reconcile ? destFolderIndex_(dst) : null;
  if (already) {
    // Children created by the pass that was interrupted are already in the
    // destination, and may or may not have reached the stored queue. Drop them
    // all, then re-push exactly one pair each as the replay walks past them.
    state.queue = state.queue.filter(function (pair) {
      return !already.ids[pair.d];
    });
  }

  state.iter = folders;
  while (folders.hasNext()) {
    if (job.cancelled) return;
    const sub = folders.next();
    let subName = '(unreadable folder)';
    let newSub = null;
    try {
      subName = sub.getName();
      if (cursor.depth + 1 > MAX_DEPTH) {
        // Recorded before anything is created. An empty destination folder we
        // will never fill is worse than none at all: it looks copied, and the
        // skip list is the only place the user learns otherwise.
        recordSkip_(job, subName + ' — nested deeper than ' + MAX_DEPTH +
          ' levels, not copied');
        afterAttempt_(job, state);
        if (pauseHere_(job, state)) return;
        continue;
      }
      const existing = already && already.byName[subName];
      if (existing && existing.length) {
        // Its twin is already there. Reuse it rather than making a second one,
        // and let the queue visit it: an interrupted pass may have created it
        // and then died before filling it.
        newSub = existing.shift();
      } else {
        job.discoveredFolders = (job.discoveredFolders || 0) + 1;
        newSub = dst.createFolder(subName);
        job.folders++;
      }
    } catch (err) {
      recordSkip_(job, subName + ' — ' + err.message);
    }
    // Children are queued only once their destination exists, so a pair in the
    // queue always names a folder that is really there.
    if (newSub) pushPair_(job, state, sub.getId(), newSub.getId(), cursor.depth + 1);
    // Throttled like a file: a wide folder no longer forces one write each.
    afterAttempt_(job, state);
    if (pauseHere_(job, state)) return;
  }
  state.iter = null;
}

/**
 * Opens the source listing for one stage of a pass, resuming it from a stored
 * continuation token where there is a usable one.
 *
 * Returns null when the source cannot be listed — an unreadable subtree is a
 * skip, the same as it was under the recursive walk — and otherwise reports
 * whether the caller has to reconcile against the destination.
 */
function resumeIterator_(job, cursor, stage, src, dst) {
  // A stored token names the last *checkpoint*, not the last copy. Only a
  // clean pause captures one after the item in hand is done; a kill at the
  // hard limit leaves items copied past it, and resuming from it would make
  // every one of them a second time. Replay by name instead — slower by one
  // destination listing, and the only version that is correct.
  const token = cursor.reconcile
    ? null
    : (stage === 'files' ? cursor.ftok : cursor.gtok);
  if (token) {
    try {
      return {
        iter: stage === 'files'
          ? DriveApp.continueFileIterator(token)
          : DriveApp.continueFolderIterator(token),
        reconcile: false,
      };
    } catch (err) {
      // Expired, invalid, or issued by a build that no longer matches. The
      // position is lost, not the work — fall through and replay by name.
      recordSkip_(job, 'resume token expired — rechecking a folder by name');
    }
  }

  let iter;
  try {
    iter = stage === 'files' ? src.getFiles() : src.getFolders();
  } catch (err) {
    recordSkip_(job, err.message);
    return null;
  }
  // A cursor this execution popped off the queue names a folder that was
  // created but never opened, so it is empty and needs no reconciling. Paying a
  // destination listing for every one of those would double Drive traffic
  // across the whole tree.
  return { iter: iter, reconcile: !!cursor.restored };
}

/** Multiset of the destination's file names. */
function destFileCounts_(dst) {
  const counts = Object.create(null);
  const it = dst.getFiles();
  while (it.hasNext()) {
    let name = null;
    try {
      name = it.next().getName();
    } catch (err) {
      continue;
    }
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

/** The destination's child folders, by name and by id. */
function destFolderIndex_(dst) {
  const index = { byName: Object.create(null), ids: Object.create(null) };
  const it = dst.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    index.ids[folder.getId()] = true;
    let name = null;
    try {
      name = folder.getName();
    } catch (err) {
      continue;
    }
    if (!index.byName[name]) index.byName[name] = [];
    index.byName[name].push(folder);
  }
  return index;
}

/**
 * Checks the slice budget between items, and if it is spent, captures the
 * iterator position and asks the walk to unwind. The token is taken only once
 * the item in hand is fully processed, so resuming from it never repeats work
 * and never skips any.
 */
function pauseHere_(job, state) {
  if (!outOfTime_()) return false;
  captureTokens_(state);
  state.paused = true;
  return true;
}

/*
 * The depth cap is enforced in createFolders_, before a destination folder is
 * made, so the skip it records is true. By the time a pair gets here its twin
 * already exists and dropping it would strand an empty folder silently.
 */
function pushPair_(job, state, srcId, dstId, depth) {
  state.queue.push({ s: srcId, d: dstId, depth: depth });
}

/* ----------------------------------------------------- RESUME STATE */

/*
 * Three keys, not one. The job record is a single ≤9 kB value, and continuation
 * tokens are opaque, unbounded base64; cramming them plus a growing queue into
 * that value reproduces exactly the failure this file already carries a comment
 * about — an oversized write failing and stranding the job as "running".
 *
 *   cloneJob      status, counters, skips        every heartbeat
 *   cloneCursor   position inside one folder     every heartbeat
 *   cloneQueue.N  pending pairs, chunked         pass boundaries only
 *
 * All three carry the job id, and all three are checked on read. There is no
 * transaction across them, so a partial write is possible, and copying into a
 * target that belongs to a different job is the one failure worth refusing.
 */

/** When this slice started; the soft deadline is measured from it. */
var sliceStartedAt_ = 0;

function parseJson_(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/** UTF-8 byte length — the unit UserProperties measures its limit in. */
function byteLength_(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** The user lock, or null if it could not be had. Advisory in every caller. */
function tryLock_() {
  try {
    const lock = LockService.getUserLock();
    return lock.tryLock(LOCK_WAIT_MS) ? lock : null;
  } catch (err) {
    return null;
  }
}

function releaseLock_(lock) {
  if (!lock) return;
  try {
    lock.releaseLock();
  } catch (err) {
    // Nothing useful to do; the lock expires on its own.
  }
}

/** Reads the cursor and pending queue belonging to this job, or nothing. */
function readState_(job) {
  const props = PropertiesService.getUserProperties();
  const state = {
    cursor: null, queue: [], queueDirty: false, iter: null,
    paused: false, chunks: 0,
  };

  const cursor = parseJson_(props.getProperty(CURSOR_KEY) || '');
  if (cursor && cursor.jobId === job.id) {
    state.cursor = cursor;
    // Nothing in this execution created it, so its destination may already hold
    // part of the pass that was interrupted.
    state.cursor.restored = true;
  }

  // Probed rather than read from job.queueChunks: the count lives in the job
  // record, and a slice can die between writing the chunks and writing the job.
  let foreign = false;
  for (let i = 0; i < MAX_QUEUE_CHUNKS; i++) {
    const raw = props.getProperty(QUEUE_KEY_PREFIX + i);
    if (raw == null) break;
    state.chunks = i + 1;
    const chunk = parseJson_(raw);
    if (!chunk || chunk.id !== job.id) {
      foreign = true;
      break;
    }
    (chunk.q || []).forEach(function (pair) {
      state.queue.push(pair);
    });
  }
  if (foreign) {
    // Authoritative or nothing. Half a queue would copy part of the tree into a
    // target that is no longer this job's.
    throw new Error(
      'The saved position belongs to a different clone. Start over to clear it.'
    );
  }

  // A pass boundary is what removes a finished pair from the stored queue, so
  // the cursor and a queue entry can name the same folder. The cursor wins.
  if (state.cursor) {
    const claimed = state.cursor.d;
    state.queue = state.queue.filter(function (pair) {
      return pair.d !== claimed;
    });
  }
  return state;
}

/**
 * First slice of a job: the root pair is all the state there is.
 *
 * A job written before this build has neither cursor nor queue, and its target
 * may already hold part of a stalled copy. Seeding it as a cursor with no
 * continuation token drops it straight into the reconcile path, so it repairs
 * itself instead of being discarded or copied over twice.
 */
function seedState_(job, state, sourceId) {
  if (job.resumable) {
    state.queue = [{ s: sourceId, d: job.targetId, depth: 0 }];
    state.queueDirty = true;
  } else {
    state.cursor = {
      jobId: job.id, s: sourceId, d: job.targetId, depth: 0,
      stage: 'files', ftok: null, gtok: null, restored: true, reconcile: true,
    };
  }
  job.seeded = true;
}

/**
 * Snapshots the live iterator. Taken only once the item in hand is fully
 * processed, so resuming from the token repeats nothing and skips nothing.
 */
function captureTokens_(state) {
  if (!state.cursor || !state.iter) return;
  let token = null;
  try {
    token = state.iter.getContinuationToken();
  } catch (err) {
    token = null;
  }
  if (state.cursor.stage === 'files') state.cursor.ftok = token;
  else state.cursor.gtok = token;
}

/**
 * Stores the in-flight cursor, dropping its tokens if they will not fit.
 * A token is opaque and unbounded; one that cannot be stored costs the resume
 * its fast path — it falls back to reconciling by name — which is far cheaper
 * than a rejected write stranding the job.
 */
function writeCursor_(job, state) {
  const props = PropertiesService.getUserProperties();
  if (!state.cursor) {
    props.deleteProperty(CURSOR_KEY);
    return;
  }
  const cursor = {
    jobId: job.id,
    s: state.cursor.s,
    d: state.cursor.d,
    depth: state.cursor.depth || 0,
    stage: state.cursor.stage,
    ftok: state.cursor.ftok || null,
    gtok: state.cursor.gtok || null,
  };
  let value = JSON.stringify(cursor);
  if (byteLength_(value) > MAX_PROPERTY_BYTES) {
    cursor.ftok = null;
    cursor.gtok = null;
    value = JSON.stringify(cursor);
  }
  props.setProperty(CURSOR_KEY, value);
}

/** Writes the pending queue across as many values as it takes. */
function writeQueue_(job, state) {
  const props = PropertiesService.getUserProperties();
  const chunks = [];
  let batch = [];
  let bytes = 0;
  state.queue.forEach(function (pair) {
    const size = byteLength_(JSON.stringify(pair)) + 1;
    if (batch.length && bytes + size > QUEUE_CHUNK_BYTES) {
      chunks.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(pair);
    bytes += size;
  });
  if (batch.length) chunks.push(batch);
  if (chunks.length > MAX_QUEUE_CHUNKS) {
    throw new Error(
      'This template has more folders than one clone can keep track of (' +
        state.queue.length + ' still to visit).'
    );
  }

  chunks.forEach(function (pairs, i) {
    props.setProperty(QUEUE_KEY_PREFIX + i, JSON.stringify({ id: job.id, q: pairs }));
  });
  // A shrinking queue leaves the tail behind, and a stale chunk would be read
  // back as pending work on the next slice.
  const stale = Math.max(state.chunks, job.queueChunks || 0);
  for (let i = chunks.length; i < stale; i++) {
    props.deleteProperty(QUEUE_KEY_PREFIX + i);
  }
  state.chunks = chunks.length;
  job.queueChunks = chunks.length;
}

/**
 * Persists everything this job knows, under the user lock, and only while this
 * job is still the stored one. Returns false when it is not — the caller must
 * then stop, and must in particular schedule no continuation: a superseded
 * worker's trigger would later be deleted along with the live job's.
 */
function checkpoint_(job, state, withQueue) {
  const lock = tryLock_();
  try {
    const stored = readJob_();
    if (!stored || stored.id !== job.id) {
      job.cancelled = true;
      return false;
    }
    // The lock is advisory: losing it costs a heartbeat, never the id check.
    if (!lock) return true;
    if (withQueue || state.queueDirty) {
      writeQueue_(job, state);
      state.queueDirty = false;
    }
    captureTokens_(state);
    writeCursor_(job, state);
    job.pending = state.queue.length + (state.cursor ? 1 : 0);
    persistJob_(job);
    return true;
  } finally {
    releaseLock_(lock);
  }
}

/** Advisory progress write: cursor and job, never the queue. */
function heartbeat_(job, state) {
  checkpoint_(job, state, false);
}

/** Drops every resume key. Only a finished, reset or replaced job does this. */
function clearResumeState_(job) {
  const props = PropertiesService.getUserProperties();
  props.deleteProperty(CURSOR_KEY);
  for (let i = 0; i < MAX_QUEUE_CHUNKS; i++) {
    if (props.getProperty(QUEUE_KEY_PREFIX + i) == null) break;
    props.deleteProperty(QUEUE_KEY_PREFIX + i);
  }
  if (job) job.queueChunks = 0;
}

/**
 * Hands the rest of the tree to another slice.
 *
 * The order matters: checkpoint first, and create the trigger only if that
 * write reported the job still current. A worker superseded mid-slice — by
 * "Start over", or by a job the user started since — must exit silently, since
 * the trigger it would leave behind is deleted by whichever worker runs next.
 */
function pauseJob_(job, state) {
  if (job.slices >= MAX_SLICES) {
    // Chaining forever would exhaust the daily trigger runtime quota and die
    // mid-copy with nothing to show for it. Stop honestly instead; the position
    // is saved, and Resume picks it up.
    job.status = 'error';
    job.phase = 'error';
    job.error =
      'Paused after ' + job.slices + ' rounds of copying. Nothing is lost — ' +
      'choose Resume to carry on from here.';
    checkpoint_(job, state, state.queueDirty);
    return;
  }
  job.phase = 'paused';
  if (!checkpoint_(job, state, state.queueDirty)) return;
  ScriptApp.newTrigger(WORKER_FN).timeBased().after(1000).create();
}

/* ------------------------------------------------------------- CARDS */

function statusCard_(job) {
  if (!job) {
    // Reachable when stored state is cleared out from under an open card.
    // It needs a way back to the form, or the sidebar is a dead end.
    return CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle('Cloner'))
      .addSection(
        CardService.newCardSection()
          .addWidget(
            CardService.newTextParagraph().setText('No job found.')
          )
          .addWidget(
            CardService.newTextButton()
              .setText('Start over')
              .setOnClickAction(
                CardService.newAction().setFunctionName('onReset')
              )
          )
      )
      .build();
  }

  const view = jobView_(job);
  const titles = { running: 'Working…', done: 'Done', error: 'Failed' };
  const section = CardService.newCardSection()
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel(view.label)
        .setText(job.name)
        .setWrapText(true)
    )
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel(progressLabel_(view))
        .setText(bar_(view.percent))
        .setWrapText(false)
    )
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Copied so far')
        .setText(countsText_(view))
        .setWrapText(true)
    );

  if (view.paused && !view.stalled) {
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Paused')
        .setText(
          'This template is too big for one background run. The copy stopped ' +
            'at a saved point and continues on its own in a moment — nothing ' +
            'is lost, and nothing gets copied twice. Check progress again ' +
            'shortly.'
        )
        .setWrapText(true)
    );
  }

  if (view.stalled) {
    // Resume is the answer now: the position is saved, and the walk reconciles
    // the folder it was interrupted in rather than copying it again. "Start
    // over" is still offered, but it is the destructive-by-omission one — it
    // clears the card and leaves the half-filled folder behind, which then
    // blocks a new clone under the same name.
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Stalled')
        .setText(
          'No progress for ' +
            Math.floor(view.idleSeconds / 60) +
            ' min. The background copy was interrupted, and ' +
            '"' + view.name + '" holds only part of the template. Resume ' +
            'carries on from the last saved point without copying anything ' +
            'twice. Start over abandons this clone and keeps the folder — ' +
            'while it exists a new clone under the same name is refused, so ' +
            'delete or rename it first.'
        )
        .setWrapText(true)
    );
  }

  if (job.error) {
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Error')
        .setText(job.error)
        .setWrapText(true)
    );
  }

  if (view.skippedCount) {
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Skipped (' + view.skippedCount + ')')
        .setText(skippedText_(view))
        .setWrapText(true)
    );
  }

  // The destination folder exists from the moment the job starts and fills up
  // as the copy runs, so the link is useful long before the job is done.
  if (view.url) {
    section.addWidget(
      CardService.newTextButton()
        .setText('Open folder')
        .setOpenLink(CardService.newOpenLink().setUrl(view.url))
    );
  }

  if (job.status === 'running') {
    // Cards cannot poll, so progress advances only when the user asks for
    // it. One button, always present while running.
    section.addWidget(
      CardService.newTextButton()
        .setText('Check progress')
        .setOnClickAction(
          CardService.newAction().setFunctionName('onCheckProgress')
        )
    );

    if (view.stalled) {
      // Before "Start over", always: carrying on is the answer nearly every
      // time, and the destructive option should not be the first one to hand.
      section.addWidget(
        CardService.newTextButton()
          .setText('Resume')
          .setOnClickAction(CardService.newAction().setFunctionName('onResume'))
      );
      section.addWidget(
        CardService.newTextButton()
          .setText('Start over')
          .setOnClickAction(CardService.newAction().setFunctionName('onReset'))
      );
    }
  } else {
    if (job.status === 'error') {
      // A job that stopped at the slice cap says "choose Resume"; this is that
      // button. For a job that failed outright, resuming re-runs the walk and
      // fails again honestly — it never copies anything twice.
      section.addWidget(
        CardService.newTextButton()
          .setText('Resume')
          .setOnClickAction(CardService.newAction().setFunctionName('onResume'))
      );
    }
    section.addWidget(
      CardService.newTextButton()
        .setText('Start another')
        .setOnClickAction(CardService.newAction().setFunctionName('onReset'))
    );
  }

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(titles[job.status] || 'Cloner'))
    .addSection(section)
    .build();
}

/* ---------------------------------------------------------- PROGRESS */

/**
 * Normalises a stored job into everything the card needs to draw a bar.
 * Derived only — never written back to UserProperties.
 */
function jobView_(job) {
  if (!job) return null;

  const now = Date.now();
  const skipped = job.skipped || [];

  // Only a finished job has a percentage. Nothing knows the size of the tree
  // until the walk ends, and inventing a denominator produces a bar that
  // jumps backwards — indeterminate is the honest answer while running.
  const percent = job.status === 'done' ? 100 : null;

  return {
    status: job.status,
    // Jobs written by the counting-era version can still be in storage.
    phase: job.phase === 'counting' ? 'copying' : job.phase || 'copying',
    name: job.name || '',
    label: job.label || SOURCE_NAME,
    folders: job.folders || 0,
    files: job.files || 0,
    discoveredFolders: job.discoveredFolders || 0,
    discoveredFiles: job.discoveredFiles || 0,
    percent: percent,
    skipped: skipped,
    skippedCount: job.skippedCount != null ? job.skippedCount : skipped.length,
    error: job.error || '',
    url: job.url || '',
    idleSeconds: job.updatedAt ? Math.floor((now - job.updatedAt) / 1000) : 0,
    stalled:
      job.status === 'running' &&
      !!job.updatedAt &&
      now - job.updatedAt > STALL_MS,
    // Between slices: the work is checkpointed and another worker is queued.
    // Only true while the handover still looks healthy — once the heartbeat
    // goes quiet for STALL_MS the job is stalled, and saying "continuing" then
    // would be a promise nothing is keeping.
    paused: job.status === 'running' && job.phase === 'paused',
  };
}

function bar_(percent) {
  if (percent === null) return '▒'.repeat(BAR_CELLS);
  const filled = Math.round((percent / 100) * BAR_CELLS);
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

function progressLabel_(view) {
  if (view.percent === null) {
    return view.status === 'running' ? 'Copying…' : 'Progress';
  }
  return 'Progress — ' + view.percent + '%';
}

function countsText_(view) {
  if (view.status !== 'running') {
    return view.folders + ' folders, ' + view.files + ' files';
  }
  if (!view.discoveredFolders && !view.discoveredFiles) {
    return 'Starting the copy…';
  }
  // "discovered" is deliberate: it is a floor that grows as the walk goes on,
  // not a target the copy is working towards.
  return (
    view.folders + ' of ' + view.discoveredFolders + ' folders and ' +
    view.files + ' of ' + view.discoveredFiles + ' files discovered so far'
  );
}

/** Skip reasons for the card: the kept details, then a count of the rest. */
function skippedText_(view) {
  const shown = view.skipped.slice(0, MAX_SKIPPED_DETAILS);
  const hidden = view.skippedCount - shown.length;
  const lines = shown.slice();
  if (hidden > 0) lines.push('…and ' + hidden + ' more');
  return lines.join('<br>');
}

function notify_(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

/* ------------------------------------------------------------ STATE */

function readJob_() {
  const raw = PropertiesService.getUserProperties().getProperty(JOB_KEY);
  return raw ? JSON.parse(raw) : null;
}

var lastWriteAt_ = 0;
var jobSeq_ = 0;

/** Unique per job within a run; the sequence disambiguates same-millisecond ids. */
function newJobId_() {
  jobSeq_ += 1;
  return String(Date.now()) + '-' + jobSeq_;
}

/**
 * Unconditional write used to start or resume a job.
 */
function persistJob_(job) {
  job.updatedAt = Date.now();
  lastWriteAt_ = job.updatedAt;
  PropertiesService.getUserProperties().setProperty(JOB_KEY, JSON.stringify(job));
}

/**
 * Persists a worker update, but only while this job is still the stored one.
 * A trigger cannot be called back mid-execution, so "Start over" can delete
 * the record — or the user can start a new job — while a worker is still
 * copying; its next write would otherwise bring the dismissed job back or
 * overwrite the new one. Flagging the job cancelled unwinds the walk on the
 * next loop iteration. Returns whether the write happened.
 */
function writeJob_(job, state) {
  const stored = readJob_();
  if (!stored || stored.id !== job.id) {
    job.cancelled = true;
    return false;
  }
  persistJob_(job);
  return true;
}

/** Heartbeat write, rate-limited so we do not hammer PropertiesService. */
function touchJob_(job, state) {
  if (Date.now() - lastWriteAt_ >= WRITE_INTERVAL_MS) writeJob_(job, state);
}

function clearWorkerTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === WORKER_FN) ScriptApp.deleteTrigger(t);
  });
}
