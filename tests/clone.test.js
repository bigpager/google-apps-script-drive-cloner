/**
 * Behaviour tests for the clone flow. These describe what the user sees and
 * what the worker costs (Drive enumerations, UserProperties writes) — not how
 * Code.gs is structured internally.
 */

'use strict';

const assert = require('assert');
const stubs = require('./gas-stubs');
const { load } = require('./load');
const { test } = require('./runner');

/* ------------------------------------------------------------ fixtures */

function setup(spec, options) {
  const env = load(options);
  const { ctx, world } = env;

  const clients = new stubs.FakeFolder('Clients', world);
  env.registerAs(clients, ctx.CLIENTS_FOLDER_ID);

  const listings = new stubs.FakeFolder('Listings', world);
  env.registerAs(listings, ctx.LISTINGS_FOLDER_ID);

  const template = stubs.buildTree(spec, world);
  env.registerAs(template, ctx.TEMPLATES.renter.id);

  env.clients = clients;
  env.listings = listings;
  env.template = template;
  return env;
}

function createEvent(name) {
  return { parameters: { type: 'renter' }, formInput: { clientName: name } };
}

/** Kicks off a renter clone and returns the card response from onCreate. */
function start(env, name) {
  return env.ctx.onCreate(createEvent(name || 'Ricky Renter'));
}

function wideTree(fileCount, folderCount) {
  const files = [];
  for (let i = 0; i < fileCount; i++) files.push('file-' + i + '.txt');
  const folders = [];
  for (let i = 0; i < folderCount; i++) folders.push({ name: 'sub-' + i, files: [], folders: [] });
  return { name: 'Renter Template', files: files, folders: folders };
}

const NESTED = {
  name: 'Renter Template',
  files: ['a.txt', 'b.txt'],
  folders: [
    {
      name: 'Docs',
      files: ['c.txt'],
      folders: [{ name: 'Deep', files: ['d.txt'], folders: [] }],
    },
    { name: 'Photos', files: ['e.jpg'], folders: [] },
  ],
};

/** A slow world: every copy attempt burns `ms` of the slice budget. */
function slowWorld(ms, extra) {
  const opts = Object.assign({}, extra);
  const inner = opts.onAttempt;
  opts.onAttempt = (name, world) => {
    world.clock.advance(ms);
    if (inner) inner(name, world);
  };
  return opts;
}

/** Fails with the offending name if anything was copied or created twice. */
function assertCopiedOnce(env) {
  const files = stubs.nameCounts(env.world.stats.copiedFiles);
  const folders = stubs.nameCounts(env.world.stats.createdFolders);
  Object.keys(files).forEach((name) => {
    assert.strictEqual(files[name], 1, 'file "' + name + '" was copied ' + files[name] + ' times');
  });
  Object.keys(folders).forEach((name) => {
    assert.strictEqual(
      folders[name], 1, 'folder "' + name + '" was created ' + folders[name] + ' times'
    );
  });
}

/** The destination holds the template, entry for entry. */
function assertMirrors(env, target) {
  assert.deepStrictEqual(
    stubs.treePaths(target).sort(),
    stubs.treePaths(env.template).sort()
  );
}

/** Every folder id that belongs to the source template tree. */
function sourceIds(folder, out) {
  const acc = out || [];
  acc.push(folder.id);
  folder._folders.forEach((f) => sourceIds(f, acc));
  return acc;
}

function persistedJobs(env) {
  return env.world.stats.writeEntries
    .filter((e) => e.key === env.ctx.JOB_KEY)
    .map((e) => JSON.parse(e.value));
}

/** How many times the job record itself has been rewritten. */
function jobWrites(env) {
  return env.world.stats.writesByKey[env.ctx.JOB_KEY] || 0;
}

/* ------------------------------------------------- 1. single enumeration */

test('a missing client template creates no destination or background trigger', () => {
  const env = setup(NESTED);
  delete env.world.byId[env.ctx.TEMPLATES.renter.id];
  const response = start(env);
  assert.match(JSON.stringify(response), /Cannot open the template folder/);
  assert.strictEqual(env.clients._folders.length, 0);
  assert.strictEqual(env.ctx.readJob_(), null);
  assert.ok(!stubs.workerPending(env.world));
});

test('a missing listing template creates no destination or background trigger', () => {
  const env = setup(NESTED);
  const response = env.ctx.onCreateListing({ formInput: { listingName: 'Demo' } });
  assert.match(JSON.stringify(response), /Cannot open the template folder/);
  assert.strictEqual(env.listings._folders.length, 0);
  assert.strictEqual(env.ctx.readJob_(), null);
  assert.ok(!stubs.workerPending(env.world));
});

test('inherited object properties are not valid template choices', () => {
  const env = setup(NESTED);
  for (const type of ['constructor', '__proto__', 'toString']) {
    const response = env.ctx.onCreate({ parameters: { type }, formInput: { clientName: 'Demo' } });
    assert.match(JSON.stringify(response), /Unknown template type/);
  }
  assert.strictEqual(env.clients._folders.length, 0);
});

test('recovery indexes accept file and folder names matching object properties', () => {
  const env = setup({
    name: 'Template',
    files: ['__proto__', 'constructor', 'toString', '__proto__'],
    folders: [
      { name: '__proto__', files: [], folders: [] },
      { name: 'constructor', files: [], folders: [] },
      { name: 'toString', files: [], folders: [] },
    ],
  });
  const counts = env.ctx.destFileCounts_(env.template);
  assert.strictEqual(counts.__proto__, 2);
  assert.strictEqual(counts.constructor, 1);
  assert.strictEqual(counts.toString, 1);
  const index = env.ctx.destFolderIndex_(env.template);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual(index.byName[name].length, 1);
  }
});

test('the worker enumerates each source folder exactly once', () => {
  const env = setup(NESTED);
  start(env);
  const ids = sourceIds(env.template);
  env.ctx.runCloneJob();

  ids.forEach((id) => {
    assert.strictEqual(
      env.world.stats.getFiles[id],
      1,
      'getFiles on ' + id + ' ran ' + env.world.stats.getFiles[id] + ' times'
    );
    assert.strictEqual(
      env.world.stats.getFolders[id],
      1,
      'getFolders on ' + id + ' ran ' + env.world.stats.getFolders[id] + ' times'
    );
  });
});

test('copying starts before the whole tree is known', () => {
  // The first copy must land while deeper folders are still unvisited. An
  // up-front pass would have already listed every one of them.
  const env = setup(NESTED, {
    onCopy(name, world) {
      if (world.stats.copiedFiles.length === 1) {
        world.stats.enumeratedAtFirstCopy = Object.keys(world.stats.getFolders).slice();
      }
    },
  });
  start(env);
  const deep = env.template._folders
    .find((f) => f.name === 'Docs')
    ._folders.find((f) => f.name === 'Deep');
  env.ctx.runCloneJob();

  const seen = env.world.stats.enumeratedAtFirstCopy;
  assert.ok(seen, 'nothing was copied at all');
  assert.strictEqual(
    seen.indexOf(deep.id),
    -1,
    'the deepest folder was already enumerated before the first file copy'
  );
});

test('no persisted snapshot ever sits in a counting phase', () => {
  const env = setup(NESTED);
  start(env);
  env.ctx.runCloneJob();

  persistedJobs(env).forEach((job) => {
    assert.notStrictEqual(job.phase, 'counting', 'a snapshot was in phase "counting"');
  });
});

/* --------------------------------------------- 2. honest progress values */

test('progress stays indeterminate while running — no invented denominator', () => {
  const env = setup(NESTED, {
    onCopy(name, world) {
      if (world.stats.copiedFiles.length === 2) {
        world.stats.midSnapshot = JSON.parse(JSON.stringify(env.ctx.readJob_()));
      }
    },
  });
  start(env);
  env.ctx.runCloneJob();

  const snap = env.world.stats.midSnapshot;
  assert.ok(snap, 'no mid-run snapshot captured');
  const view = env.ctx.jobView_(snap);
  assert.strictEqual(view.status, 'running');
  assert.strictEqual(view.percent, null, 'a running job reported a percentage');
  assert.strictEqual(
    env.ctx.bar_(view.percent),
    '▒'.repeat(env.ctx.BAR_CELLS),
    'the bar showed a filled fraction with no real total'
  );
});

test('the card reports copied-of-discovered counts while running', () => {
  // Sampled past the first throttle boundary, so this is a snapshot the card
  // could really have drawn — not the job as it was created.
  const env = setup(wideTree(20, 0), {
    onCopy(name, world) {
      if (world.stats.copiedFiles.length === 12) {
        world.stats.midSnapshot = JSON.parse(JSON.stringify(env.ctx.readJob_()));
      }
    },
  });
  start(env);
  env.ctx.runCloneJob();

  const snap = env.world.stats.midSnapshot;
  assert.ok(snap, 'no mid-run snapshot captured');
  const view = env.ctx.jobView_(snap);
  assert.ok(view.files > 0, 'the persisted snapshot showed no copied files');
  assert.ok(
    view.discoveredFiles >= view.files,
    'discovered files (' + view.discoveredFiles + ') fell below copied (' + view.files + ')'
  );
  const text = env.ctx.countsText_(view);
  assert.ok(
    /discovered/i.test(text),
    'counts text did not mention discovery: ' + text
  );
  assert.ok(
    text.indexOf(String(view.discoveredFiles)) !== -1,
    'counts text omitted the discovered file count: ' + text
  );
});

test('a freshly started job says so instead of showing zeroes of nothing', () => {
  const env = setup(NESTED);
  start(env);
  const view = env.ctx.jobView_(env.ctx.readJob_());
  assert.strictEqual(view.percent, null);
  assert.strictEqual(env.ctx.countsText_(view), 'Starting the copy…');
});

test('a finished job reports a real 100% and final counts', () => {
  const env = setup(NESTED);
  start(env);
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.files, 5);
  assert.strictEqual(job.folders, 3);
  const view = env.ctx.jobView_(job);
  assert.strictEqual(view.percent, 100);
  const text = env.ctx.countsText_(view);
  assert.ok(text.indexOf('5') !== -1 && text.indexOf('3') !== -1, text);
});

/* ------------------------------------------------------ 3. Open folder */

test('Open folder is offered while the job is still running', () => {
  const env = setup(NESTED);
  start(env);
  const running = env.ctx.readJob_();
  assert.strictEqual(running.status, 'running');

  const card = env.ctx.statusCard_(running);
  const texts = stubs.buttonTexts(card);
  assert.ok(
    texts.indexOf('Open folder') !== -1,
    'running card buttons were: ' + JSON.stringify(texts)
  );
  const button = stubs
    .findAll(card, (n) => n.type === 'TextButton' && n.props.Text === 'Open folder')[0];
  assert.strictEqual(button.props.OpenLink.props.Url, running.url);
});

test('Open folder is still offered once the job is done', () => {
  const env = setup(NESTED);
  start(env);
  env.ctx.runCloneJob();
  const texts = stubs.buttonTexts(env.ctx.statusCard_(env.ctx.readJob_()));
  assert.ok(texts.indexOf('Open folder') !== -1, JSON.stringify(texts));
  assert.ok(texts.indexOf('Start another') !== -1, JSON.stringify(texts));
});

/* ------------------------------------------- 4. write throttling by work */

test('writes are throttled by copy attempts, not by successes', () => {
  // Nothing succeeds and the clock never moves: the only thing that can pace
  // the writes is the attempt count.
  //
  // Counted per key, not in total: resume state lives in three properties now,
  // so one heartbeat is several setProperty calls. What this has always been
  // about is how often the job record is rewritten.
  const env = setup(wideTree(20, 0), { failAllCopies: true });
  start(env);
  const before = jobWrites(env);
  env.ctx.runCloneJob();
  const during = jobWrites(env) - before;

  assert.ok(during >= 2, 'no progress writes at all during a failing run');
  assert.ok(
    during <= 8,
    'a run of 20 failures wrote the job ' + during + ' times; expected ~1 per ' +
      'attempt batch, so failures must not be treated as writable progress'
  );
});

test('an elapsed heartbeat writes even when nothing succeeds', () => {
  const env = setup(wideTree(20, 0), {
    failAllCopies: true,
    onAttempt(name, world) {
      world.clock.advance(3000); // longer than WRITE_INTERVAL_MS
    },
  });
  start(env);
  const before = env.world.stats.writes;
  env.ctx.runCloneJob();
  const during = env.world.stats.writes - before;

  assert.ok(
    during >= 15,
    'only ' + during + ' writes across 20 slow failing attempts; the elapsed ' +
      'heartbeat did not fire'
  );
});

test('creating folders inside one pass does not write unconditionally', () => {
  // Sampled as the last of the 20 subfolders is created, so this measures one
  // pass and not the whole run. Each pass ends in a checkpoint of its own —
  // that is the price of being resumable — but within a pass, creating a
  // folder is throttled exactly like copying a file.
  const env = setup(wideTree(0, 20), {
    onCreateFolder(name, world) {
      if (name === 'sub-19') world.stats.jobWritesAtPassEnd = jobWrites(env);
    },
  });
  start(env);
  const before = jobWrites(env);
  env.ctx.runCloneJob();
  const during = env.world.stats.jobWritesAtPassEnd - before;

  assert.ok(
    during <= 8,
    'creating 20 folders in one pass caused ' + during + ' job writes; folder ' +
      'creation is still writing unconditionally'
  );
});

test('the pending queue is written at pass boundaries, not per item', () => {
  // 40 files are one pass, and the queue does not change while it runs. The
  // queue is the one value that can grow without bound, so writing it on the
  // heartbeat instead of at pass boundaries is what the property-write quota
  // would notice first.
  const env = setup(wideTree(40, 0));
  start(env);
  env.ctx.runCloneJob();

  const queueWrites = Object.keys(env.world.stats.writesByKey)
    .filter((k) => k.indexOf(env.ctx.QUEUE_KEY_PREFIX) === 0)
    .reduce((n, k) => n + env.world.stats.writesByKey[k], 0);
  assert.ok(
    queueWrites <= 3,
    'one pass over 40 files wrote the queue ' + queueWrites + ' times'
  );
});

/* --------------------------------------------------- 5. bounded skip log */

test('skip details are capped while the total skipped count stays exact', () => {
  const env = setup(wideTree(100, 0), { failAllCopies: true });
  start(env);
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.skippedCount, 100, 'lost the true skipped total');
  assert.ok(
    job.skipped.length <= env.ctx.MAX_SKIPPED_DETAILS,
    'stored ' + job.skipped.length + ' skip details, cap is ' + env.ctx.MAX_SKIPPED_DETAILS
  );
  assert.ok(job.skipped.length > 0, 'kept no skip detail at all');
});

test('stored job size stays bounded when everything is skipped', () => {
  const env = setup(wideTree(400, 0), { failAllCopies: true });
  start(env);
  env.ctx.runCloneJob();

  const biggest = Math.max.apply(null, env.world.stats.writeSizes);
  assert.ok(
    biggest < 9000,
    'largest UserProperties write was ' + biggest + ' chars; the skip list is ' +
      'still growing without a bound (the per-property limit is 9 kB)'
  );
});

test('a single skip detail cannot be arbitrarily long', () => {
  const huge = 'x'.repeat(3000) + '.txt';
  const env = setup({ name: 'Renter Template', files: [huge], folders: [] }, {
    failAllCopies: true,
  });
  start(env);
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.skipped.length, 1);
  assert.ok(
    job.skipped[0].length <= 250,
    'skip detail was ' + job.skipped[0].length + ' chars'
  );
});

test('the card shows the true skipped total and summarises the remainder', () => {
  const env = setup(wideTree(100, 0), { failAllCopies: true });
  start(env);
  env.ctx.runCloneJob();

  const card = env.ctx.statusCard_(env.ctx.readJob_());
  const widget = stubs.decoratedByLabel(card, 'Skipped');
  assert.ok(widget, 'no Skipped widget on the card');
  assert.ok(
    widget.top.indexOf('100') !== -1,
    'skipped label did not show the true total: ' + widget.top
  );
  assert.ok(
    /\bmore\b/.test(widget.text),
    'card did not summarise the skipped entries it dropped: ' + widget.text
  );
});

/* ------------------------------------------------------- 6. regressions */

test('a clean run copies every file and folder into the target', () => {
  const env = setup(NESTED);
  start(env);
  env.ctx.runCloneJob();

  const target = env.clients._folders[0];
  assert.strictEqual(target.name, 'Ricky Renter');
  assert.deepStrictEqual(target._files.map((f) => f.name).sort(), ['a.txt', 'b.txt']);
  const docs = target._folders.find((f) => f.name === 'Docs');
  assert.ok(docs, 'Docs was not recreated');
  assert.deepStrictEqual(docs._files.map((f) => f.name), ['c.txt']);
  assert.ok(docs._folders.find((f) => f.name === 'Deep'), 'Deep was not recreated');
});

test('an unlistable subfolder is skipped, not fatal', () => {
  const env = setup(NESTED, { failListNames: ['Photos'] });
  start(env);
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.status, 'done', 'the run died on one bad folder: ' + job.error);
  assert.strictEqual(job.skippedCount, 1);
  assert.ok(/Photos/.test(job.skipped[0]), job.skipped[0]);
  // Everything outside the bad folder still made it across.
  assert.strictEqual(job.files, 4);
});

test('a file that cannot be copied is skipped and the rest continue', () => {
  const env = setup(NESTED, { failCopyNames: ['c.txt'] });
  start(env);
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.files, 4);
  assert.strictEqual(job.skippedCount, 1);
});

test('onCreate refuses a blank name and an existing client folder', () => {
  const env = setup(NESTED);
  const blank = env.ctx.onCreate({ parameters: { type: 'renter' }, formInput: { clientName: '  ' } });
  assert.ok(/Enter a client name/.test(JSON.stringify(blank)), JSON.stringify(blank));

  start(env, 'Ricky Renter');
  env.ctx.runCloneJob();
  env.ctx.onReset({});
  const dupe = start(env, 'Ricky Renter');
  assert.ok(/already exists/.test(JSON.stringify(dupe)), JSON.stringify(dupe));
});

test('a second clone is refused while one is running', () => {
  const env = setup(NESTED);
  start(env, 'One');
  const second = start(env, 'Two');
  assert.ok(/already running/.test(JSON.stringify(second)), JSON.stringify(second));
});

test('a job stored in the old counting format still renders', () => {
  // An in-flight job written by the previous version can outlive a deploy.
  const env = setup(NESTED);
  const legacy = {
    status: 'running', phase: 'counting', type: 'renter', label: 'Renter',
    name: 'Legacy', targetId: 'x', url: 'https://drive.google.com/legacy',
    folders: 1, files: 2, totalFolders: 9, totalFiles: 40, total: 49,
    estimated: true, current: 'a.txt', startedAt: 1, skipped: ['a — boom'],
    error: '', updatedAt: env.world.clock.ms,
  };
  const view = env.ctx.jobView_(legacy);
  assert.strictEqual(view.percent, null, 'a stale total was used as a denominator');
  const card = env.ctx.statusCard_(legacy);
  assert.ok(stubs.buttonTexts(card).indexOf('Open folder') !== -1);
  const skipped = stubs.decoratedByLabel(card, 'Skipped');
  assert.ok(skipped && skipped.top.indexOf('1') !== -1, JSON.stringify(skipped));
});

test('the listing flow shares the same worker and progress shape', () => {
  const env = setup(NESTED);
  const listingTemplate = stubs.buildTree(
    { name: 'Listing Template', files: ['l1.txt'], folders: [{ name: 'L', files: ['l2.txt'], folders: [] }] },
    env.world
  );
  env.registerAs(listingTemplate, env.ctx.LISTING_TEMPLATE_ID);

  env.ctx.onCreateListing({ formInput: { listingName: '12 Main St' } });
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.status, 'done');
  assert.strictEqual(job.files, 2);
  assert.strictEqual(job.folders, 1);
  assert.strictEqual(job.phase, 'done');
});

/* ------------------------------------------ 7. the 9 kB property ceiling */

test('a file name larger than the property limit never reaches storage', () => {
  // The huge name lands on the fifth attempt, which is exactly where the
  // attempt-paced write fires — so whatever the worker keeps about the item
  // it is on has to survive a real setProperty.
  const huge = 'x'.repeat(10000) + '.txt';
  const env = setup({
    name: 'Renter Template',
    files: ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', huge],
    folders: [],
  });
  start(env);

  assert.doesNotThrow(
    () => env.ctx.runCloneJob(),
    'the worker died trying to persist a job carrying a raw 10 kB file name'
  );
  assert.deepStrictEqual(
    env.world.stats.rejectedWrites,
    [],
    'UserProperties rejected a write of ' + env.world.stats.rejectedWrites + ' bytes'
  );
  const biggest = Math.max.apply(null, env.world.stats.writeSizes);
  assert.ok(
    biggest < stubs.PROPERTY_VALUE_LIMIT_BYTES,
    'largest stored value was ' + biggest + ' chars'
  );

  const job = env.ctx.readJob_();
  assert.ok(job, 'no job left in storage at all');
  assert.strictEqual(
    job.status,
    'done',
    'the job was left as "' + job.status + '" — a failed write stranded it as running'
  );
  assert.strictEqual(job.files, 5, 'not every file was copied');
});

test('a folder name larger than the property limit never reaches storage', () => {
  const huge = 'd'.repeat(10000);
  const env = setup({
    name: 'Renter Template',
    files: ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt'],
    folders: [{ name: huge, files: [], folders: [] }],
  });
  start(env);

  assert.doesNotThrow(
    () => env.ctx.runCloneJob(),
    'the worker died trying to persist a job carrying a raw 10 kB folder name'
  );
  assert.deepStrictEqual(env.world.stats.rejectedWrites, []);
  const job = env.ctx.readJob_();
  assert.strictEqual(job.status, 'done', 'job left as "' + job.status + '"');
  assert.strictEqual(job.folders, 1);
});

test('the error path cannot be blocked by an oversized item name', () => {
  // A job already carrying a huge value — written by an older build, or read
  // back mid-run — must still be able to record its own failure.
  const env = setup(NESTED);
  const stuck = {
    status: 'running', phase: 'copying', type: 'renter', label: 'Renter',
    sourceId: env.ctx.TEMPLATES.renter.id, name: 'Ricky Renter',
    targetId: 'no-such-folder-id', url: 'https://drive.google.com/x',
    folders: 0, files: 0, discoveredFolders: 0, discoveredFiles: 0,
    attempts: 0, current: 'y'.repeat(10000), startedAt: env.world.clock.ms,
    skipped: [], skippedCount: 0, error: '', updatedAt: env.world.clock.ms,
  };
  // Seeded past setProperty on purpose: the point is what the worker does with
  // an oversized record, not whether one can be written today.
  env.props._store.set(env.ctx.JOB_KEY, JSON.stringify(stuck));

  assert.doesNotThrow(
    () => env.ctx.runCloneJob(),
    'the error-state write was itself rejected as too large'
  );
  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status,
    'error',
    'the job stayed "' + job.status + '" after failing — the user sees a clone ' +
      'that never finishes and cannot start another'
  );
  assert.ok(job.error, 'no error message was recorded');
});

/* ------------------------------------------- 8. recovery from a bad clone */

test('a stalled job tells the user to clear the partial folder before retrying', () => {
  const env = setup(NESTED);
  start(env);
  const job = env.ctx.readJob_();
  env.world.clock.advance(env.ctx.STALL_MS + 1000);

  const widget = stubs.decoratedByLabel(env.ctx.statusCard_(job), 'Stalled');
  assert.ok(widget, 'no Stalled widget on the card');
  const text = String(widget.text);
  assert.ok(
    text.indexOf(job.name) !== -1,
    'the recovery text did not name the partial folder: ' + text
  );
  assert.ok(
    /renam/i.test(text) && /(remove|delete)/i.test(text),
    'the recovery text did not tell the user to remove or rename the partial ' +
      'folder, which is what actually blocks a retry: ' + text
  );
  assert.ok(
    !/start over to retry the rest/i.test(text),
    'the card still promises Start over resumes the rest; it does not — the ' +
      'duplicate-name check refuses the retry while the partial folder exists: ' + text
  );
});

/* --------------------------------------------------- 9. reset cancellation */

test('a reset while the worker is copying is not undone by that worker', () => {
  let reset = false;
  const env = setup(wideTree(20, 0), {
    onCopy(name, world) {
      if (reset || world.stats.copiedFiles.length !== 3) return;
      reset = true;
      env.ctx.onReset({});
    },
  });
  start(env);
  assert.doesNotThrow(() => env.ctx.runCloneJob());

  assert.strictEqual(
    env.ctx.readJob_(),
    null,
    'the dismissed job was resurrected by the worker that was already running'
  );
  assert.ok(
    env.world.stats.copiedFiles.length < 20,
    'the cancelled worker copied all 20 files; it never noticed the reset'
  );
});

test('a job started after a reset is not clobbered by the old worker', () => {
  let switched = false;
  const env = setup(wideTree(20, 0), {
    onCopy(name, world) {
      if (switched || world.stats.copiedFiles.length !== 3) return;
      switched = true;
      env.ctx.onReset({});
      env.ctx.onCreate({
        parameters: { type: 'renter' },
        formInput: { clientName: 'Second Client' },
      });
    },
  });
  start(env, 'First Client');
  env.ctx.runCloneJob();

  const handover = env.ctx.readJob_();
  assert.ok(handover, 'the newly started job was deleted');
  assert.strictEqual(
    handover.name,
    'Second Client',
    'the superseded worker overwrote the job the user had just started'
  );

  // And the replacement still runs to completion like any other job.
  env.ctx.runCloneJob();
  const finished = env.ctx.readJob_();
  assert.strictEqual(finished.name, 'Second Client');
  assert.strictEqual(finished.status, 'done', 'the new job could not finish');
  assert.strictEqual(finished.files, 20);
});

test('a stalled running job still offers Open folder and Start over', () => {
  const env = setup(NESTED);
  start(env);
  const job = env.ctx.readJob_();
  env.world.clock.advance(env.ctx.STALL_MS + 1000);
  const view = env.ctx.jobView_(job);
  assert.strictEqual(view.stalled, true);
  const texts = stubs.buttonTexts(env.ctx.statusCard_(job));
  assert.ok(texts.indexOf('Open folder') !== -1, JSON.stringify(texts));
  assert.ok(texts.indexOf('Start over') !== -1, JSON.stringify(texts));
});

/* --------------------------------------------------- 10. resumable cloning */

test('a clone too big for one slice finishes across several slices', () => {
  // 33 items at 20 s each is far past any single-execution budget, so the
  // worker has to checkpoint, hand over to another slice, and pick up exactly
  // where it left off — without copying anything a second time.
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000));
  start(env);
  const slices = stubs.runToCompletion(env);

  assert.ok(slices > 1, 'the whole tree fitted in one slice; nothing was resumed');
  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'done', 'job ended as "' + job.status + '": ' + job.error
  );
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

test('the top-level skeleton is created before anything nested', () => {
  // Breadth-first, not depth-first: the queue that makes a clone resumable has
  // no depth semantics, and the user's "Open folder" link is worth more when
  // the top of the tree is already there.
  const env = setup(NESTED);
  start(env);
  const byTheWorker = env.world.stats.createdFolders.length; // skip the target
  env.ctx.runCloneJob();

  assert.deepStrictEqual(
    env.world.stats.createdFolders.slice(byTheWorker),
    ['Docs', 'Photos', 'Deep'],
    'folders were created depth-first'
  );
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

/* ------------------------------------------------ 11. persisted resume state */

/** A root holding `n` subfolders, each with one uniquely named file. */
function wideNested(n) {
  const folders = [];
  for (let i = 0; i < n; i++) {
    folders.push({ name: 'sub-' + i, files: ['f-' + i + '.txt'], folders: [] });
  }
  return { name: 'Renter Template', files: [], folders: folders };
}

function storeKeys(env, prefix) {
  return Array.from(env.props._store.keys()).filter((k) => k.indexOf(prefix) === 0);
}

test('a pending queue too wide for one property value is chunked, not rejected', () => {
  // 400 queued pairs is far more than the 9 kB a single UserProperties value
  // holds. Chunking is what stops a wide template from stranding the job on a
  // rejected write.
  const env = setup(wideNested(400), {
    onCopy(name, world) {
      if (world.stats.sampled) return;
      world.stats.sampled = true;
      world.stats.queueChunkKeys = storeKeys(env, 'cloneQueue.').length;
      world.stats.queueDepth = env.ctx.readState_(env.ctx.readJob_()).queue.length;
    },
  });
  start(env);
  env.ctx.runCloneJob();

  assert.deepStrictEqual(
    env.world.stats.rejectedWrites, [],
    'UserProperties rejected a write of ' + env.world.stats.rejectedWrites + ' bytes'
  );
  assert.ok(
    env.world.stats.queueChunkKeys > 1,
    '400 queued pairs were stored in ' + env.world.stats.queueChunkKeys + ' value(s)'
  );
  assert.ok(
    env.world.stats.queueDepth > 300,
    'the stored queue held only ' + env.world.stats.queueDepth + ' pairs'
  );
  assert.strictEqual(env.ctx.readJob_().status, 'done');
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

test('a continuation token too large to store degrades instead of failing', () => {
  // Tokens are opaque and unbounded. One that does not fit must cost the job
  // its fast resume, not its ability to checkpoint at all.
  const env = setup(wideTree(30, 0), {
    tokenPadding: 12000,
    onCopy(name, world) {
      const raw = env.props._store.get('cloneCursor');
      if (raw) world.stats.storedCursor = JSON.parse(raw);
    },
  });
  start(env);
  assert.doesNotThrow(() => env.ctx.runCloneJob());

  assert.deepStrictEqual(env.world.stats.rejectedWrites, []);
  const cursor = env.world.stats.storedCursor;
  assert.ok(cursor, 'no cursor was persisted at all');
  assert.ok(!cursor.ftok, 'an unstorable token was written into the cursor anyway');
  assert.strictEqual(env.ctx.readJob_().status, 'done');
  assertCopiedOnce(env);
});

test('resume state is honoured only while it carries the current job id', () => {
  const env = setup(NESTED);
  start(env);
  const job = env.ctx.readJob_();
  const target = env.clients._folders[0];
  const docs = env.template._folders.find((f) => f.name === 'Docs');

  // A slice that already finished the root pass and queued Docs.
  function seedQueue(id) {
    const dst = target.createFolder('Docs');
    job.seeded = true;
    env.props._store.set(env.ctx.JOB_KEY, JSON.stringify(job));
    env.props._store.set(
      env.ctx.QUEUE_KEY_PREFIX + '0',
      JSON.stringify({ id: id, q: [{ s: docs.id, d: dst.id, depth: 1 }] })
    );
    return dst;
  }

  const mine = seedQueue(job.id);
  env.ctx.runCloneJob();
  assert.deepStrictEqual(
    mine._files.map((f) => f.name), ['c.txt'],
    'the stored queue was not picked up where the previous slice left it'
  );
  assert.deepStrictEqual(
    target._files.map((f) => f.name), [],
    'the root pass was redone even though the queue said it was finished'
  );

  // The same state, stamped by a job the user has since replaced.
  const env2 = setup(NESTED);
  start(env2);
  const job2 = env2.ctx.readJob_();
  const target2 = env2.clients._folders[0];
  const docs2 = env2.template._folders.find((f) => f.name === 'Docs');
  const stranger = target2.createFolder('Docs');
  job2.seeded = true;
  env2.props._store.set(env2.ctx.JOB_KEY, JSON.stringify(job2));
  env2.props._store.set(
    env2.ctx.QUEUE_KEY_PREFIX + '0',
    JSON.stringify({ id: 'a-job-the-user-replaced', q: [{ s: docs2.id, d: stranger.id, depth: 1 }] })
  );
  env2.ctx.runCloneJob();
  assert.deepStrictEqual(
    stranger._files.map((f) => f.name), [],
    'copied into a folder that belonged to a different job'
  );
});

/* ------------------------------------------------ 12. slicing and handover */

/** Runs one slice of a clone big enough that it cannot finish in one. */
function firstSlice(env) {
  env.ctx.runCloneJob();
  assert.ok(
    stubs.workerPending(env.world),
    'the first slice finished the whole tree; there is no handover to test'
  );
  return env.ctx.readJob_();
}

test('a slice checkpoints its position before handing over', () => {
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000));
  start(env);
  const job = firstSlice(env);

  assert.strictEqual(job.status, 'running', 'a paused job is not a stopped job');
  assert.strictEqual(job.phase, 'paused');
  const cursor = JSON.parse(env.props._store.get(env.ctx.CURSOR_KEY));
  assert.strictEqual(cursor.jobId, job.id, 'the cursor was not stamped with the job id');
  assert.strictEqual(
    cursor.s, env.template.id,
    'the stored cursor did not name the folder the slice was working on'
  );
  assert.ok(cursor.ftok, 'no continuation token was captured for the in-flight listing');
});

test('a reset between slices stops the chain dead', () => {
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000));
  start(env);
  firstSlice(env);
  const copied = env.world.stats.copiedFiles.length;

  env.ctx.onReset({});
  assert.ok(
    !stubs.workerPending(env.world),
    'the queued continuation outlived the job it belonged to'
  );
  assert.deepStrictEqual(
    storeKeys(env, env.ctx.QUEUE_KEY_PREFIX), [],
    'the pending queue was left behind for the next job to read'
  );

  // And if the trigger had already been dispatched, the slice it starts must
  // find nothing to do rather than carry on copying into a dismissed job.
  env.ctx.runCloneJob();
  assert.strictEqual(env.ctx.readJob_(), null, 'the reset job came back');
  assert.strictEqual(
    env.world.stats.copiedFiles.length, copied,
    'the worker kept copying after the job was dismissed'
  );
});

test('a worker superseded at its last checkpoint schedules no continuation', () => {
  // The dangerous move is not the write — writeJob_ already refuses that — but
  // the trigger. A superseded worker that schedules one has it deleted by the
  // next slice to run, taking the live job's handover with it.
  //
  // The job is replaced during the slice's final checkpoint, so every id guard
  // on the way here has already passed and the trigger is the last thing left
  // that can still do damage.
  let switched = false;
  // Disarmed until the slice starts: the job's own first write happens while
  // onCreate is still running, long before there is a worker to supersede.
  let sliceStart = Infinity;
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000, {
    onWrite(key, value, world) {
      if (switched || key !== env.ctx.JOB_KEY) return;
      if (world.clock.ms - sliceStart < env.ctx.SLICE_MS) return;
      switched = true;
      env.ctx.onReset({});
      env.ctx.onCreate({
        parameters: { type: 'renter' },
        formInput: { clientName: 'Second Client' },
      });
    },
  }));
  start(env, 'First Client');

  sliceStart = env.world.clock.ms;
  const before = env.world.stats.triggersCreated;
  env.ctx.runCloneJob();
  assert.ok(switched, 'the slice never reached its deadline; nothing was superseded');

  assert.strictEqual(
    env.world.stats.triggersCreated - before, 1,
    'the superseded worker scheduled a continuation on top of the new job\'s'
  );
  assert.ok(
    stubs.workerPending(env.world),
    'the new job lost the trigger it had just scheduled'
  );
  assert.strictEqual(env.ctx.readJob_().name, 'Second Client');
});

test('a worker superseded mid-pass leaves the new job alone', () => {
  let switched = false;
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000, {
    onCopy(name, world) {
      if (switched || world.stats.copiedFiles.length !== 5) return;
      switched = true;
      env.ctx.onReset({});
      env.ctx.onCreate({
        parameters: { type: 'renter' },
        formInput: { clientName: 'Second Client' },
      });
    },
  }));
  start(env, 'First Client');

  const before = env.world.stats.triggersCreated;
  env.ctx.runCloneJob();
  assert.ok(switched, 'the second job was never started; nothing was superseded');

  assert.strictEqual(
    env.world.stats.triggersCreated - before, 1,
    'the superseded worker scheduled a continuation of its own'
  );
  const second = env.clients._folders.find((f) => f.name === 'Second Client');
  assert.deepStrictEqual(
    second._files.map((f) => f.name), [],
    'the superseded worker copied into the target of the job that replaced it'
  );
  assert.strictEqual(env.ctx.readJob_().name, 'Second Client');
});

test('a clone that will not stop chaining stops honestly instead', () => {
  // 120 files at a minute each is more than MAX_SLICES rounds of copying.
  // Time-driven triggers share a daily runtime quota, so chaining until it runs
  // out means dying mid-copy with no explanation; stopping is the honest end.
  const env = setup(wideTree(120, 0), slowWorld(60 * 1000));
  start(env);
  const slices = stubs.runToCompletion(env, 60);

  assert.strictEqual(slices, env.ctx.MAX_SLICES, 'chained ' + slices + ' times');
  const job = env.ctx.readJob_();
  assert.strictEqual(job.status, 'error', 'job ended as "' + job.status + '"');
  assert.ok(/resume/i.test(job.error), 'the message does not mention Resume: ' + job.error);
  assert.ok(
    env.props._store.get(env.ctx.CURSOR_KEY),
    'the job stopped without saving where it had got to'
  );
  assertCopiedOnce(env);
});

/* ------------------------------ 11. reconciling after a broken slice */

/*
 * A clean pause writes its continuation tokens and then goes. Everything else —
 * the hard 6-minute kill, a crash, a token that has aged out — leaves a stored
 * position that lags what actually reached Drive. Resuming from that position
 * as if it were exact is what makes a copy land twice, so these tests describe
 * the destination, not the bookkeeping.
 */

/** Kills the slice the way the hard limit does: mid-copy, with no warning. */
function killAfterCopies(n) {
  return {
    onCopy(name, world) {
      if (world.stats.copiedFiles.length === n) world.crashed = true;
    },
  };
}

/** Runs slices by hand until the job stops being "running". */
function resumeUntilSettled(env, cap) {
  const limit = cap || 20;
  let slices = 0;
  let job = env.ctx.readJob_();
  while (job && job.status === 'running') {
    if (slices >= limit) {
      throw new Error('still running after ' + limit + ' resume slices');
    }
    slices++;
    env.ctx.runCloneJob();
    job = env.ctx.readJob_();
  }
  return slices;
}

test('a slice killed mid-folder does not copy the un-checkpointed files twice', () => {
  const env = setup(wideTree(20, 0), killAfterCopies(7));
  start(env);

  assert.throws(
    () => env.ctx.runCloneJob(),
    'the fake kill never fired — the slice ran to the end and there is nothing ' +
      'to recover from'
  );
  const beforeKill = env.world.stats.copiedFiles.length;
  assert.ok(
    beforeKill > 0 && beforeKill < 20,
    'the kill landed at the wrong moment (' + beforeKill + ' of 20 copied)'
  );
  assert.strictEqual(
    env.ctx.readJob_().status,
    'running',
    'a killed execution cannot write, so the job must still read as "running"'
  );

  // The next slice. Everything the killed one did to Drive is still there;
  // everything it knew is gone except its last checkpoint.
  env.world.crashed = false;
  resumeUntilSettled(env);

  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'done', 'the job ended as "' + job.status + '": ' + job.error
  );
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

test('a resume whose continuation token has expired still copies each file once', () => {
  // 33 items at 20 s each pauses cleanly, then the token ages out before the
  // continuation trigger fires. The position is lost; the copied files are not.
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000));
  start(env);
  env.ctx.runCloneJob();

  assert.strictEqual(
    env.ctx.readJob_().phase, 'paused', 'the first slice did not pause'
  );
  env.world.expireTokens();
  stubs.runToCompletion(env);

  assert.ok(
    env.world.stats.expiredTokenUses.length > 0,
    'no expired token was ever presented; the fallback was never exercised'
  );
  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'done', 'the job ended as "' + job.status + '": ' + job.error
  );
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

test('duplicate names in the template survive a resume intact', () => {
  // Drive lets one folder hold two children with the same name, so "is this
  // already copied?" is a counting question. A set-based check would drop the
  // second "notes.txt" and the second "Shared" on every resume.
  const DUPLICATES = {
    name: 'Renter Template',
    files: ['notes.txt', 'notes.txt', 'unique.txt'],
    folders: [
      { name: 'Shared', files: ['x.txt'], folders: [] },
      { name: 'Shared', files: ['y.txt'], folders: [] },
    ],
  };
  const env = setup(DUPLICATES, {
    onCreateFolder(name, world) {
      // Killed once the first "Shared" twin exists but before the pass that
      // made it could checkpoint. Keyed on the name, not a count: onCreate
      // makes the destination folder itself before the worker ever runs.
      if (name === 'Shared') world.crashed = true;
    },
  });
  start(env);
  assert.throws(() => env.ctx.runCloneJob(), 'the fake kill never fired');

  env.world.crashed = false;
  resumeUntilSettled(env);

  const target = env.clients._folders[0];
  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'done', 'the job ended as "' + job.status + '": ' + job.error
  );
  assert.deepStrictEqual(
    stubs.childNames(target),
    stubs.childNames(env.template),
    'the resumed clone lost or duplicated a same-named child'
  );
  assertMirrors(env, target);
});

/* ---------------------------- 12. what the card says, and what Resume does */

/** A single chain of `depth` nested folders with a file at the bottom. */
function deepTree(depth) {
  let spec = { name: 'level-' + depth, files: ['leaf.txt'], folders: [] };
  for (let i = depth - 1; i >= 1; i--) {
    spec = { name: 'level-' + i, files: [], folders: [spec] };
  }
  return { name: 'Renter Template', files: [], folders: [spec] };
}

test('a paused job says it is continuing by itself, not that it has stalled', () => {
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000));
  start(env);
  env.ctx.runCloneJob();

  const job = env.ctx.readJob_();
  assert.strictEqual(job.phase, 'paused', 'the first slice did not pause');
  assert.strictEqual(job.status, 'running', 'a pause is not the end of the job');
  assert.strictEqual(
    env.ctx.jobView_(job).stalled,
    false,
    'a job in the middle of handing over was reported as stalled'
  );

  const card = env.ctx.statusCard_(job);
  const widget = stubs.decoratedByLabel(card, 'Paused');
  assert.ok(
    widget,
    'the card says nothing about the pause, so a user watching it sees ' +
      'progress simply stop: ' + JSON.stringify(stubs.decorated(card))
  );
  assert.ok(
    /continu/i.test(String(widget.text)),
    'the text does not say the copy carries on by itself: ' + widget.text
  );
  assert.strictEqual(
    stubs.buttonTexts(card).indexOf('Resume'),
    -1,
    'a job that resumes itself asked the user to resume it'
  );
});

test('a stalled job offers Resume before Start over', () => {
  const env = setup(NESTED);
  start(env);
  const job = env.ctx.readJob_();
  env.world.clock.advance(env.ctx.STALL_MS + 1000);

  const card = env.ctx.statusCard_(job);
  const texts = stubs.buttonTexts(card);
  const resume = texts.indexOf('Resume');
  const over = texts.indexOf('Start over');
  assert.ok(
    resume !== -1,
    'a stalled job offered no way to carry on, so the only exit is discarding ' +
      'a half-copied folder: ' + JSON.stringify(texts)
  );
  assert.ok(over !== -1, 'Start over is gone; a bad clone can no longer be discarded');
  assert.ok(
    resume < over,
    'Start over is offered ahead of Resume, which pushes the destructive ' +
      'choice first: ' + JSON.stringify(texts)
  );

  const text = String(stubs.decoratedByLabel(card, 'Stalled').text);
  assert.ok(
    /resume/i.test(text),
    'the recovery text never mentions Resume: ' + text
  );
});

test('Resume carries on into the same folder instead of starting a new clone', () => {
  const env = setup(wideTree(30, 3), slowWorld(20 * 1000));
  start(env);
  env.ctx.runCloneJob();
  const paused = env.ctx.readJob_();

  // The continuation never fires — dispatch failed, the quota ran out, the
  // execution died. This is the state the user is actually looking at.
  env.world.stats.triggers.length = 0;
  env.world.clock.advance(env.ctx.STALL_MS + 1000);
  const foldersBefore = env.clients._folders.length;
  const copiedBefore = env.world.stats.copiedFiles.length;

  env.ctx.onResume({});

  const job = env.ctx.readJob_();
  assert.ok(job, 'Resume cleared the job');
  assert.strictEqual(job.id, paused.id, 'Resume started a different job');
  assert.strictEqual(
    job.targetId, paused.targetId, 'Resume pointed the clone at another folder'
  );
  assert.strictEqual(
    env.clients._folders.length,
    foldersBefore,
    'Resume created a second client folder; the first one is now orphaned'
  );
  assert.ok(stubs.workerPending(env.world), 'Resume queued no worker');
  assert.strictEqual(
    env.ctx.jobView_(job).stalled, false, 'the card still reads as stalled'
  );

  stubs.runToCompletion(env);
  const done = env.ctx.readJob_();
  assert.strictEqual(
    done.status, 'done', 'the resumed job ended as "' + done.status + '": ' + done.error
  );
  assert.ok(
    env.world.stats.copiedFiles.length > copiedBefore,
    'Resume finished without copying anything that was still outstanding'
  );
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

test('Resume after the slice cap gets a fresh budget rather than stopping again', () => {
  const env = setup(wideTree(120, 0), slowWorld(60 * 1000));
  start(env);
  stubs.runToCompletion(env, 60);
  assert.strictEqual(
    env.ctx.readJob_().status, 'error', 'the job did not hit the slice cap'
  );

  env.ctx.onResume({});
  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'running', 'Resume left the capped job in "' + job.status + '"'
  );
  assert.ok(
    job.slices < env.ctx.MAX_SLICES,
    'Resume kept the spent slice count, so the job stops again immediately'
  );
  assert.strictEqual(job.error, '', 'the old cap message is still on the card');

  stubs.runToCompletion(env, 60);
  assertCopiedOnce(env);
});

test('a legacy job with no saved position repairs itself instead of copying twice', () => {
  const env = setup(NESTED, killAfterCopies(2));
  start(env);
  assert.throws(() => env.ctx.runCloneJob(), 'the fake kill never fired');
  env.world.crashed = false;

  // Rewritten as the previous build would have stored it: no `resumable`
  // marker, and no cursor or queue anywhere. The destination already holds
  // part of the template, which is the whole problem.
  const legacy = env.ctx.readJob_();
  delete legacy.resumable;
  delete legacy.seeded;
  delete legacy.queueChunks;
  legacy.phase = 'copying';
  env.props._store.set(env.ctx.JOB_KEY, JSON.stringify(legacy));
  env.props._store.delete(env.ctx.CURSOR_KEY);
  for (let i = 0; i < 5; i++) env.props._store.delete(env.ctx.QUEUE_KEY_PREFIX + i);

  resumeUntilSettled(env);

  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'done', 'the job ended as "' + job.status + '": ' + job.error
  );
  assertCopiedOnce(env);
  assertMirrors(env, env.clients._folders[0]);
});

test('a tree deeper than the cap is recorded as a skip rather than followed', () => {
  // Drive folders may have several parents, so a "tree" can contain a cycle.
  // A visited set would be unbounded; the depth cap is what keeps a cycle from
  // chaining slices until the daily quota dies.
  const env = setup(deepTree(30));
  assert.ok(env.ctx.MAX_DEPTH < 30, 'the fixture is no longer deeper than the cap');
  start(env);
  stubs.runToCompletion(env, 60);

  const job = env.ctx.readJob_();
  assert.strictEqual(
    job.status, 'done', 'the job ended as "' + job.status + '": ' + job.error
  );
  assert.strictEqual(
    job.folders,
    env.ctx.MAX_DEPTH,
    'the walk did not stop at the cap; it copied ' + job.folders + ' levels'
  );
  assert.ok(job.skippedCount > 0, 'the cap was hit but nothing was recorded');
  assert.ok(
    job.skipped.some((s) => /deep/i.test(s)),
    'the skip never says why it was left out: ' + JSON.stringify(job.skipped)
  );
});
