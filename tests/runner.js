/** Tiny test runner: collect with test(), run with run(). No dependencies. */

'use strict';

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function run() {
  let failed = 0;
  cases.forEach((c) => {
    try {
      c.fn();
      console.log('  PASS  ' + c.name);
    } catch (err) {
      failed++;
      console.log('  FAIL  ' + c.name);
      console.log('        ' + String(err.message).split('\n').join('\n        '));
    }
  });
  console.log('');
  console.log(
    (failed ? 'RED  ' : 'GREEN') + '  ' + (cases.length - failed) + '/' +
      cases.length + ' passing, ' + failed + ' failing'
  );
  return failed;
}

module.exports = { test, run, cases };
