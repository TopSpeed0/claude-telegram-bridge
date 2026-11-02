'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCANNER = path.join(__dirname, '..', 'scripts', 'leak-scan.js');
// Built at run time so this file itself holds no key-shaped text.
const FAKE = 'AKIA' + 'A'.repeat(16);
const OTHER = 'AKIA' + 'B'.repeat(16);

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-scan-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
  git('init', '-q');
  const commit = (text, msg) => { fs.writeFileSync(path.join(dir, 'a.txt'), text); git('add', '.'); git('commit', '-q', '-m', msg); };
  const scan = () => spawnSync('node', [SCANNER, '--history'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, LEAK_PATTERNS_FILE: path.join(dir, 'none.txt') },
  });
  return { dir, commit, scan };
}

test('a value HEAD marks as fake is accepted in older commits', () => {
  const r = repo();
  r.commit(`key = "${FAKE}"\n`, 'add test key');
  assert.equal(r.scan().status, 1, 'unmarked key is a finding');
  r.commit(`key = "${FAKE}" // leak-scan:allow\n`, 'mark it');
  const out = r.scan();
  assert.equal(out.status, 0, out.stderr);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('an unmarked value is still reported next to a marked one', () => {
  const r = repo();
  r.commit(`key = "${FAKE}" // leak-scan:allow\nother = "${OTHER}"\n`, 'two keys');
  const out = r.scan();
  assert.equal(out.status, 1);
  assert.match(out.stderr, /AWS key: AKIABB/);
  assert.doesNotMatch(out.stderr, /AKIAAA/);
  fs.rmSync(r.dir, { recursive: true, force: true });
});
