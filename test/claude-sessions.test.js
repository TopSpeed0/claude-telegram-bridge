'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listLiveSessions, projectDirName, findTranscript, readTail, since, turnInputs, lastAssistantText, transcriptCwd } = require('../mcp/claude-sessions');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ID = (n) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

test('lists live sessions, newest first, and skips dead, own and broken entries', () => {
  const dir = tmp('cc-sessions-');
  const write = (pid, body) => fs.writeFileSync(path.join(dir, `${pid}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  write(11, { pid: 11, sessionId: ID(1), name: 'nas-prd volumes', cwd: '/w/a', status: 'idle', entrypoint: 'claude-desktop', messagingSocketPath: 'pipe-1', updatedAt: 100 });
  write(12, { pid: 12, sessionId: ID(2), cwd: '/w/b', status: 'busy', updatedAt: 300 });
  write(13, { pid: 13, sessionId: ID(3), name: 'gone', updatedAt: 500 });
  write(14, { pid: 14, sessionId: ID(4), name: 'the daemon itself', updatedAt: 400 });
  write(15, '{ not json');
  write(16, { pid: 16, sessionId: 'not-a-uuid' });
  fs.writeFileSync(path.join(dir, '17.abc.key'), 'secret');
  const list = listLiveSessions({ dir, alive: pid => pid !== 13, exclude: s => s.sessionId === ID(4) });
  assert.deepEqual(list.map(s => s.sessionId), [ID(2), ID(1)]);
  assert.equal(list[1].name, 'nas-prd volumes');
  assert.equal(list[1].desktop, true);
  assert.equal(list[1].socket, 'pipe-1');
  assert.equal(list[0].name, ID(2).slice(0, 8), 'a nameless session shows its id');
  assert.equal(list[0].status, 'busy');
  assert.deepEqual(listLiveSessions({ dir: path.join(dir, 'missing') }), []);
});

test('keeps one entry per session id', () => {
  const dir = tmp('cc-sessions-');
  fs.writeFileSync(path.join(dir, '21.json'), JSON.stringify({ pid: 21, sessionId: ID(5), name: 'old', updatedAt: 1 }));
  fs.writeFileSync(path.join(dir, '22.json'), JSON.stringify({ pid: 22, sessionId: ID(5), name: 'new', updatedAt: 2 }));
  assert.deepEqual(listLiveSessions({ dir, alive: () => true }).map(s => s.name), ['new']);
});

test('finds a transcript by folder, else in any project folder', () => {
  const projects = tmp('cc-projects-');
  const cwd = path.join('C:', 'code', 'vol_applog');
  fs.mkdirSync(path.join(projects, projectDirName(cwd)));
  fs.writeFileSync(path.join(projects, projectDirName(cwd), `${ID(1)}.jsonl`), '');
  fs.mkdirSync(path.join(projects, 'elsewhere'));
  fs.writeFileSync(path.join(projects, 'elsewhere', `${ID(2)}.jsonl`), '');
  assert.equal(findTranscript(ID(1), cwd, { projects }), path.join(projects, projectDirName(cwd), `${ID(1)}.jsonl`));
  assert.equal(findTranscript(ID(2), cwd, { projects }), path.join(projects, 'elsewhere', `${ID(2)}.jsonl`));
  assert.equal(findTranscript(ID(3), cwd, { projects }), null);
  assert.equal(findTranscript('../../etc/passwd', cwd, { projects }), null, 'only session ids');
  assert.equal(projectDirName('C:\\Users\\a b'), 'C--Users-a-b');
});

test('reads the tail of a transcript and what started a turn', () => {
  const file = path.join(tmp('cc-transcript-'), 't.jsonl');
  const rec = (ts, extra) => JSON.stringify({ timestamp: new Date(ts).toISOString(), cwd: '/w/x', ...extra });
  fs.writeFileSync(file, [
    rec(1000, { type: 'user', message: { role: 'user', content: 'old question' } }),
    rec(1000, { type: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } }),
    rec(5000, { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'uds:pipe-1', name: 'nas-prd volumes', body: 'Done: 3 volumes resized.' },
      message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:pipe-1">\nDone: 3 volumes resized.\n</cross-session-message>' } }),
    rec(5001, { type: 'user', isMeta: true, message: { role: 'user', content: '[Cross-session idle notice] "nas-prd volumes", which you asked to be notified about, is idle now.' } }),
    rec(5002, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    rec(5003, { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    rec(5004, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Noted.' }] } }),
    'not json',
  ].join('\n') + '\n');
  const records = readTail(file);
  assert.equal(records.length, 7);
  const turn = turnInputs(since(records, 5000));
  assert.deepEqual(turn.peers, [{ name: 'nas-prd volumes', from: 'uds:pipe-1', body: 'Done: 3 volumes resized.' }]);
  assert.deepEqual(turn.idle, ['nas-prd volumes']);
  assert.equal(turn.others, 0);
  assert.equal(turnInputs(records).others, 1, 'the old question');
  assert.equal(lastAssistantText(since(records, 5000)), 'Noted.');
  assert.equal(lastAssistantText(since(records, 9000)), null);
  assert.equal(transcriptCwd(records), '/w/x');
  assert.ok(readTail(file, 200).length < records.length, 'a short tail drops the cut first record');
  assert.deepEqual(readTail(path.join(os.tmpdir(), 'missing-transcript.jsonl')), []);
});

test('a peer record without origin.body falls back to the message text', () => {
  const { peers } = turnInputs([{ type: 'user', origin: { kind: 'peer', name: 'w' }, message: { content: 'Another Claude session sent a message:\n<cross-session-message from="x">\nhello there\n</cross-session-message>' } }]);
  assert.equal(peers[0].body, 'hello there');
});
