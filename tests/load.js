/**
 * Loads Code.gs into a fresh V8 context wired to the fakes in gas-stubs.js.
 * Every helper in Code.gs (including the private `name_` ones) is reachable on
 * the returned context, so tests can drive the worker directly.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const stubs = require('./gas-stubs');

const CODE_PATH = path.join(__dirname, '..', 'Code.gs');

/** Pins a fake folder to a fixed Drive id so DriveApp.getFolderById finds it. */
function registerAs(world, folder, id) {
  delete world.byId[folder.id];
  folder.id = id;
  world.byId[id] = folder;
  return folder;
}

function load(options) {
  const world = stubs.makeWorld(options);
  const props = stubs.makePropertiesService(world);

  const sandbox = {
    CardService: stubs.makeCardService(),
    DriveApp: world.drive,
    PropertiesService: props,
    LockService: stubs.makeLockService(world),
    ScriptApp: stubs.makeScriptApp(world.stats),
    Date: world.clock.Date,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Error,
    Set,
    Map,
    RegExp,
    isNaN,
    console,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(CODE_PATH, 'utf8');
  // Top-level `function`s are var-scoped and land on the sandbox by
  // themselves, but `const`/`let` stay in the script's lexical scope, so the
  // tests would never see the tuning constants. Re-export them by name.
  const lexical = [];
  source.split('\n').forEach((line) => {
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) lexical.push(m[1]);
  });
  const epilogue = lexical
    .map((n) => 'globalThis.' + n + ' = ' + n + ';')
    .join('\n');

  vm.runInContext(source + '\n' + epilogue + '\n', context, {
    filename: CODE_PATH,
  });

  return { ctx: context, world, props, registerAs: (f, id) => registerAs(world, f, id) };
}

module.exports = { load, registerAs, CODE_PATH };
