#!/usr/bin/env node
'use strict';
// Leak scanner: finds secrets and private names before they reach a public
// repo. Built-in rules catch what is never public anywhere (tokens, keys,
// private IPs, real e-mail addresses, Windows profile paths). Your own names
// (company, domain, hosts, clusters, people) go in a private pattern list
// that is never committed: .git/leak-patterns.txt (shared by all worktrees),
// or the file named by LEAK_PATTERNS_FILE. One JavaScript regex per line,
// case-insensitive; blank lines and lines starting with # are ignored.
// A line containing "leak-scan:allow" is skipped. In commit scans, a value
// that HEAD marks that way is also accepted in older commits that lack the mark.
//
// Usage:
//   node scripts/leak-scan.js              tracked files as they are on disk
//   node scripts/leak-scan.js --rev <sha>  every file in that commit
//   node scripts/leak-scan.js --history    every line ever added, in all branch and tag commits and messages
//   node scripts/leak-scan.js --pre-push   the commits being pushed (git hook; refs on stdin)
// Exit code 1 when something is found.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const root = git('rev-parse', '--show-toplevel').trim();
const commonDir = path.resolve(root, git('rev-parse', '--git-common-dir').trim());

const BUILT_IN = [
  ['private IPv4', /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/],
  ['e-mail address', /\b[A-Za-z0-9._%+-]+@(?!(?:[\w-]+\.)*example\.(?:com|org|net)\b|anthropic\.com\b|users\.noreply\.github\.com\b|github\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{20,})\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Atlassian token', /\bATATT[A-Za-z0-9_=-]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['auth header', /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{24,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Windows profile path', /\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<|YOUR|you\b|\$|%|\.\.\.)[A-Za-z0-9._-]{2,}/i],
];

function privateRules() {
  const file = process.env.LEAK_PATTERNS_FILE || path.join(commonDir, 'leak-patterns.txt');
  if (!fs.existsSync(file)) {
    console.error(`leak-scan: no private pattern list at ${file} — only the built-in rules ran.`);
    return [];
  }
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map((src) => {
      try { return ['private name', new RegExp(src, 'i')]; }
      catch (e) { throw new Error(`leak-scan: bad pattern in ${file}: ${src} (${e.message})`); }
    });
}
const RULES = [...BUILT_IN, ...privateRules()];

// Long secrets are shown masked; names are shown as found.
const show = (rule, text) => (/token|key|header/.test(rule) && text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-3)}` : text);

// Values on "leak-scan:allow" lines in HEAD: known fakes (test secrets),
// accepted in commit scans even where an older commit added them unmarked.
function knownFakes() {
  let lines = '';
  try { lines = git('grep', '-h', '-I', '-F', 'leak-scan:allow', 'HEAD'); } catch { return new Set(); } // no match: exit 1
  const fakes = new Set();
  for (const line of lines.split('\n')) for (const [, re] of RULES) { const m = re.exec(line); if (m) fakes.add(m[0]); }
  return fakes;
}
let fakes = new Set();

const findings = [];
function scanLine(where, line) {
  if (line.includes('leak-scan:allow')) return;
  for (const [rule, re] of RULES) {
    const m = re.exec(line);
    if (m && !fakes.has(m[0])) findings.push(`${where}: ${rule}: ${show(rule, m[0])}`);
  }
}
function scanText(where, text) {
  if (text.includes('\0')) return; // binary
  text.split(/\r?\n/).forEach((line, i) => scanLine(`${where}:${i + 1}`, line));
}

// Author / committer, message and added lines of the given commits (git log arguments).
function scanCommits(args) {
  fakes = knownFakes();
  let commit = '', file = '', lineNo = 0, inMessage = false;
  const out = git('log', '-p', '--no-color', '--unified=0', '--format=@@commit %h%n@@who %an <%ae> / %cn <%ce>%n%B%n@@end', ...args);
  for (const line of out.split('\n')) {
    if (line.startsWith('@@commit ')) { commit = line.slice(9); inMessage = true; continue; }
    if (line.startsWith('@@who ')) { scanLine(`${commit} (author)`, line.slice(6)); continue; }
    if (line === '@@end') { inMessage = false; continue; }
    if (inMessage) { scanLine(`${commit} (message)`, line); continue; }
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (line.startsWith('+')) scanLine(`${commit} ${file}:${lineNo++}`, line.slice(1));
  }
}

const mode = process.argv[2] || '--tree';
if (mode === '--tree') {
  for (const f of git('ls-files', '-z').split('\0').filter(Boolean)) {
    const full = path.join(root, f);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) scanText(f, fs.readFileSync(full, 'utf8'));
  }
} else if (mode === '--rev') {
  const rev = process.argv[3] || 'HEAD';
  for (const f of git('ls-tree', '-r', '-z', '--name-only', rev).split('\0').filter(Boolean)) {
    scanText(`${rev}:${f}`, git('show', `${rev}:${f}`));
  }
} else if (mode === '--history') {
  // Branches and tags only: local tool refs (stashes, agent checkpoints) are never pushed.
  scanCommits(['--branches', '--tags']);
} else if (mode === '--pre-push') {
  const zero = /^0+$/;
  for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(' ');
    if (zero.test(localSha)) continue; // deleting a branch
    scanCommits(zero.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`]);
  }
} else {
  console.error('Usage: node scripts/leak-scan.js [--tree | --rev <sha> | --history | --pre-push]');
  process.exit(2);
}

if (findings.length) {
  console.error(`leak-scan: ${findings.length} finding(s):`);
  for (const f of [...new Set(findings)]) console.error(`  ${f}`);
  console.error('Fix them (or mark a deliberate example line with "leak-scan:allow") and try again.');
  process.exit(1);
}
console.log('leak-scan: clean');
