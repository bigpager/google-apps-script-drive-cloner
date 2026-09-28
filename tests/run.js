#!/usr/bin/env node
/** Entry point: `node tests/run.js`. Exits non-zero if anything fails. */

'use strict';

require('./clone.test');
const { run } = require('./runner');

process.exit(run() ? 1 : 0);
