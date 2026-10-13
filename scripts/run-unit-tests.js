#!/usr/bin/env node
/*
 * Runs every *.test.js in the repo root, one process each, and prints a tally.
 *
 * Why not one big `&&` chain in package.json? Because the first failure hides
 * everything after it, and the chain has been growing since 2.2.x. This keeps
 * going, then exits non-zero if anything went wrong. Boring, which is the point.
 *
 * Needs `npm ci --ignore-scripts` plus `npm rebuild better-sqlite3` first. The
 * default postinstall pulls in electron-builder's native rebuild, which a CI
 * box doesn't need just to check a regex.
 *
 * Wishlist: run these in parallel. Not today. Half of them poke at temp dirs and
 * I'd rather not debug a race on a wet Sunday.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const only = process.argv[2]; // optional substring filter, handy when one test is being awkward
const files = fs
  .readdirSync(root)
  .filter((f) => f.endsWith('.test.js') && (!only || f.includes(only)))
  .sort();

const failed = [];
for (const file of files) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const ok = result.status === 0;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file} (${secs}s)`);
  if (!ok) {
    failed.push(file);
    // Only the tail. Nobody wants 400 lines of stack in a CI log.
    const out = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
    console.log(out.replace(/^/gm, '     '));
  }
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) {
  console.log(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
