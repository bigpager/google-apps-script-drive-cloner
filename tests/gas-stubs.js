/**
 * Minimal fakes for the Apps Script globals Code.gs touches, plus a fake Drive
 * tree that records how many times each folder is enumerated and how many
 * times UserProperties is written. The counters are what the behaviour tests
 * assert on, so the fakes stay dumb and observable on purpose.
 */

'use strict';

/* --------------------------------------------------------------- CLOCK */

function makeClock(start) {
  const clock = {
    ms: start == null ? 1_000_000 : start,
    advance(by) {
      clock.ms += by;
    },
  };
  clock.Date = { now: () => clock.ms };
  return clock;
}

/* ------------------------------------------------------------- DRIVE */

/**
 * Drive iterators are resumable through an opaque continuation token. The fake
 * models one as a handle into a registry holding {snapshot, index}, so a test
 * can hand it back to DriveApp.continueFileIterator — or expire it and watch
 * the worker fall back to reconciling by name.
 *
 * `world` and `kind` are optional: the by-name lookups do not need tokens.
 */
function iterator(items, world, kind) {
  const snapshot = items.slice();
  let i = 0;
  return {
    hasNext: () => i < snapshot.length,
    next: () => snapshot[i++],
    getContinuationToken: () => {
      if (!world) throw new Error('this iterator issues no continuation token');
      return issueToken(world, kind, snapshot, i);
    },
  };
}

function issueToken(world, kind, snapshot, index) {
  const tokens = world.tokens;
  const id = kind + '-tok-' + ++tokens.seq;
  tokens.map[id] = { kind, snapshot, index };
  tokens.issued.push(id);
  // Real tokens are opaque base64 of unbounded length. Padding lets a test push
  // a cursor carrying one past the 9 kB property ceiling.
  return tokens.padding ? id + '|' + 'p'.repeat(tokens.padding) : id;
}

function resumeToken(world, kind, token) {
  const id = String(token).split('|')[0];
  const entry = world.tokens.map[id];
  if (!entry || world.tokens.expired[id] || entry.kind !== kind) {
    world.stats.expiredTokenUses.push(id);
    throw new Error('Invalid continuation token: ' + id);
  }
  world.stats.tokenResumes.push(id);
  return iterator(entry.snapshot.slice(entry.index), world, kind);
}

let nextId = 1;

class FakeFile {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.id = 'file-' + nextId++;
  }

  getName() {
    if (this.world.policy.failNames.has(this.name)) {
      throw new Error('name unreadable: ' + this.name);
    }
    return this.name;
  }

  getId() {
    return this.id;
  }

  makeCopy(name, dst) {
    const p = this.world.policy;
    if (p.onAttempt) p.onAttempt(name, this.world);
    if (p.failAllCopies || p.failCopyNames.has(name)) {
      throw new Error('copy denied: ' + name);
    }
    const copy = new FakeFile(name, this.world);
    dst._files.push(copy);
    this.world.stats.copiedFiles.push(name);
    if (p.onCopy) p.onCopy(name, this.world);
    return copy;
  }
}

class FakeFolder {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.id = 'folder-' + nextId++;
    this._files = [];
    this._folders = [];
    world.byId[this.id] = this;
  }

  getName() {
    if (this.world.policy.failNames.has(this.name)) {
      throw new Error('name unreadable: ' + this.name);
    }
    return this.name;
  }

  getId() {
    return this.id;
  }

  getUrl() {
    return 'https://drive.google.com/drive/folders/' + this.id;
  }

  getFiles() {
    bump(this.world.stats.getFiles, this.id);
    if (this.world.policy.failListNames.has(this.name)) {
      throw new Error('cannot list: ' + this.name);
    }
    return iterator(this._files, this.world, 'file');
  }

  getFolders() {
    bump(this.world.stats.getFolders, this.id);
    if (this.world.policy.failListNames.has(this.name)) {
      throw new Error('cannot list: ' + this.name);
    }
    return iterator(this._folders, this.world, 'folder');
  }

  getFoldersByName(name) {
    return iterator(this._folders.filter((f) => f.name === name));
  }

  getFilesByName(name) {
    return iterator(this._files.filter((f) => f.name === name));
  }

  createFolder(name) {
    const p = this.world.policy;
    if (p.onAttempt) p.onAttempt(name, this.world);
    if (p.failCreateNames.has(name)) {
      throw new Error('create denied: ' + name);
    }
    const sub = new FakeFolder(name, this.world);
    this._folders.push(sub);
    this.world.stats.createdFolders.push(name);
    if (p.onCreateFolder) p.onCreateFolder(name, this.world);
    return sub;
  }
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Multiset of the child names of one folder. Drive allows duplicate names in a
 * folder, so "did this land twice?" is a counting question, not a set question
 * — which is exactly what the no-duplicates assertions need.
 */
function nameCounts(names) {
  const counts = {};
  names.forEach((n) => {
    counts[n] = (counts[n] || 0) + 1;
  });
  return counts;
}

function childNames(folder) {
  return {
    files: nameCounts(folder._files.map((f) => f.name)),
    folders: nameCounts(folder._folders.map((f) => f.name)),
  };
}

/** Every '/'-joined path in a folder tree, so two trees can be compared whole. */
function treePaths(folder, prefix, out) {
  const acc = out || [];
  const base = prefix || '';
  folder._files.forEach((f) => acc.push(base + f.name));
  folder._folders.forEach((sub) => {
    acc.push(base + sub.name + '/');
    treePaths(sub, base + sub.name + '/', acc);
  });
  return acc;
}

/**
 * spec: { name, files: [nameOrObj], folders: [spec] }
 */
function buildTree(spec, world) {
  const folder = new FakeFolder(spec.name, world);
  (spec.files || []).forEach((f) => {
    folder._files.push(new FakeFile(typeof f === 'string' ? f : f.name, world));
  });
  (spec.folders || []).forEach((s) => {
    folder._folders.push(buildTree(s, world));
  });
  return folder;
}

/* --------------------------------------------------------- CARDSERVICE */

/**
 * Every CardService builder becomes an inspectable node: setX() records a
 * prop, addX() records a child, build() returns the node itself.
 */
function node(type) {
  const target = { type, props: {}, children: [] };
  const self = new Proxy(target, {
    get(t, key) {
      if (key in t) return Reflect.get(t, key);
      if (typeof key !== 'string') return undefined;
      if (key === 'build') return () => t;
      if (key.startsWith('set')) {
        return (...args) => {
          t.props[key.slice(3)] = args.length === 1 ? args[0] : args;
          return self;
        };
      }
      if (key.startsWith('add')) {
        return (...args) => {
          t.children.push(args[0]);
          return self;
        };
      }
      // Navigation's pushCard/updateCard/popCard and anything else chainable.
      return (...args) => {
        t.props[key] = args.length === 1 ? args[0] : args;
        return self;
      };
    },
  });
  return self;
}

const CARD_FACTORIES = [
  'newCardBuilder', 'newCardHeader', 'newCardSection', 'newTextInput',
  'newTextButton', 'newTextParagraph', 'newDecoratedText', 'newDivider',
  'newAction', 'newOpenLink', 'newActionResponseBuilder', 'newNavigation',
  'newNotification',
];

function makeCardService() {
  const svc = {};
  CARD_FACTORIES.forEach((fn) => {
    svc[fn] = () => node(fn.replace(/^new/, ''));
  });
  return svc;
}

/** Depth-first walk over a built card/response node tree. */
function walk(n, visit) {
  if (!n || typeof n !== 'object' || !n.type) return;
  visit(n);
  (n.children || []).forEach((c) => walk(c, visit));
  Object.keys(n.props || {}).forEach((k) => walk(n.props[k], visit));
}

function findAll(n, predicate) {
  const hits = [];
  walk(n, (x) => {
    if (predicate(x)) hits.push(x);
  });
  return hits;
}

function buttonTexts(n) {
  return findAll(n, (x) => x.type === 'TextButton').map((b) => b.props.Text);
}

/** Returns the {TopLabel, Text} pairs of every DecoratedText in a card. */
function decorated(n) {
  return findAll(n, (x) => x.type === 'DecoratedText').map((d) => ({
    top: d.props.TopLabel,
    text: d.props.Text,
  }));
}

function decoratedByLabel(n, labelPrefix) {
  return decorated(n).find(
    (d) => typeof d.top === 'string' && d.top.indexOf(labelPrefix) === 0
  );
}

/* ------------------------------------------------------- PROPERTIES */

/**
 * Apps Script rejects any single property value over 9 kB. Code.gs keeps the
 * whole job in one value, so the cap is a real failure mode, not a nicety —
 * the fake enforces it byte-for-byte the way the platform does.
 */
const PROPERTY_VALUE_LIMIT_BYTES = 9 * 1024;

function makePropertiesService(world) {
  const stats = world.stats;
  const store = new Map();
  const userProps = {
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => {
      // A slice that runs past the hard execution limit is killed between two
      // statements, with no chance to finish what it was writing. `crashed` is
      // that guillotine: everything already stored stays, nothing more lands.
      if (world.crashed) throw new Error('Exceeded maximum execution time');
      const value = String(v);
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > PROPERTY_VALUE_LIMIT_BYTES) {
        stats.rejectedWrites.push(bytes);
        throw new Error(
          'Argument too large: value (' + bytes + ' bytes exceeds the ' +
            PROPERTY_VALUE_LIMIT_BYTES + ' byte limit)'
        );
      }
      stats.writes++;
      bump(stats.writesByKey, k);
      stats.writeSizes.push(value.length);
      stats.writeValues.push(value);
      stats.writeEntries.push({ key: k, value: value });
      store.set(k, value);
      // The one place a test can act *between* a worker's checkpoint and
      // whatever it does next — which is where a user hitting "Start over"
      // lands, and the only window in which a superseded worker can still
      // schedule a trigger.
      if (world.policy.onWrite) world.policy.onWrite(k, value, world);
      return userProps;
    },
    deleteProperty: (k) => {
      if (world.crashed) throw new Error('Exceeded maximum execution time');
      bump(stats.deletesByKey, k);
      store.delete(k);
      return userProps;
    },
  };
  return { getUserProperties: () => userProps, _store: store };
}

/* ---------------------------------------------------------- LOCKSERVICE */

/**
 * `tryLock` either grants or refuses; there is no real contention to model in a
 * single-threaded test. `denyLock` is the interesting half — it exercises the
 * path where an advisory heartbeat is dropped rather than risking a write into
 * another worker's job.
 */
function makeLockService(world) {
  return {
    getUserLock: () => {
      world.stats.lockRequests++;
      let held = false;
      return {
        tryLock: () => {
          if (world.policy.denyLock) {
            world.stats.lockDenials++;
            return false;
          }
          held = true;
          world.stats.locksTaken++;
          return true;
        },
        releaseLock: () => {
          if (held) world.stats.lockReleases++;
          held = false;
        },
        hasLock: () => held,
      };
    },
  };
}

/* ----------------------------------------------------------- SCRIPTAPP */

function makeScriptApp(stats) {
  const triggerBuilder = {
    timeBased: () => triggerBuilder,
    after: () => triggerBuilder,
    create: () => {
      stats.triggersCreated++;
      // Registered, not just counted: a continuation trigger has to be
      // findable so the next slice can run and so clearWorkerTriggers_ can
      // delete it, which is the whole handover mechanism.
      const trigger = { getHandlerFunction: () => 'runCloneJob' };
      stats.triggers.push(trigger);
      return trigger;
    },
  };
  return {
    newTrigger: () => triggerBuilder,
    getProjectTriggers: () => stats.triggers.slice(),
    deleteTrigger: (t) => {
      const i = stats.triggers.indexOf(t);
      if (i !== -1) stats.triggers.splice(i, 1);
    },
  };
}

/** True while a worker slice is queued to run. */
function workerPending(world) {
  return world.stats.triggers.some((t) => t.getHandlerFunction() === 'runCloneJob');
}

/**
 * Drives the worker the way the trigger scheduler would: run a slice, and keep
 * running while the slice that just finished left another one queued. The cap
 * is what turns "chains forever" from a hanging test into a failing one.
 */
function runToCompletion(env, cap) {
  const limit = cap || 40;
  let slices = 0;
  while (workerPending(env.world)) {
    if (slices >= limit) {
      throw new Error('worker still chaining after ' + limit + ' slices');
    }
    slices++;
    env.ctx.runCloneJob();
  }
  return slices;
}

/* -------------------------------------------------------------- WORLD */

function makeWorld(options) {
  const opts = options || {};
  const stats = {
    getFiles: {},
    getFolders: {},
    copiedFiles: [],
    createdFolders: [],
    writes: 0,
    writesByKey: {},
    deletesByKey: {},
    writeSizes: [],
    writeValues: [],
    writeEntries: [],
    rejectedWrites: [],
    triggersCreated: 0,
    triggers: [],
    tokenResumes: [],
    expiredTokenUses: [],
    lockRequests: 0,
    locksTaken: 0,
    lockDenials: 0,
    lockReleases: 0,
  };
  const policy = {
    denyLock: !!opts.denyLock,
    failAllCopies: !!opts.failAllCopies,
    failCopyNames: new Set(opts.failCopyNames || []),
    failCreateNames: new Set(opts.failCreateNames || []),
    failListNames: new Set(opts.failListNames || []),
    failNames: new Set(opts.failNames || []),
    onCopy: opts.onCopy || null,
    onCreateFolder: opts.onCreateFolder || null,
    onAttempt: opts.onAttempt || null,
    onWrite: opts.onWrite || null,
  };
  const clock = makeClock(opts.startTime);
  const world = {
    stats,
    policy,
    clock,
    byId: {},
    crashed: false,
    tokens: { seq: 0, map: {}, expired: {}, issued: [], padding: opts.tokenPadding || 0 },
  };
  world.expireTokens = () => {
    world.tokens.issued.forEach((id) => {
      world.tokens.expired[id] = true;
    });
  };
  world.drive = {
    getFolderById: (id) => {
      const f = world.byId[id];
      if (!f) throw new Error('No item with the given ID could be found: ' + id);
      return f;
    },
    continueFileIterator: (token) => resumeToken(world, 'file', token),
    continueFolderIterator: (token) => resumeToken(world, 'folder', token),
  };
  return world;
}

module.exports = {
  PROPERTY_VALUE_LIMIT_BYTES,
  makeWorld,
  buildTree,
  FakeFolder,
  FakeFile,
  makeCardService,
  makePropertiesService,
  makeLockService,
  makeScriptApp,
  findAll,
  buttonTexts,
  decorated,
  decoratedByLabel,
  walk,
  nameCounts,
  childNames,
  treePaths,
  workerPending,
  runToCompletion,
};
