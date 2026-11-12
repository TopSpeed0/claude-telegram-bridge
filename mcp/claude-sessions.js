'use strict';
// The user's other Claude Code sessions on this machine, read from the files
// Claude Code keeps itself: ~/.claude/sessions/<pid>.json (the list ListAgents
// shows) and the transcripts in ~/.claude/projects/<folder>/<session id>.jsonl.
// Both are internal formats, so every field is checked and anything odd is skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claudeDir = (...parts) => path.join(os.homedir(), '.claude', ...parts);
const str = (v) => (typeof v === 'string' ? v : '');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Live sessions, most recently active first. exclude(session) drops the
// caller's own sessions.
function listLiveSessions({ dir = claudeDir('sessions'), alive = pidAlive, exclude = () => false } = {}) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch (_) { return []; }
  const byId = new Map();
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')); } catch (_) { continue; }
    if (!raw || typeof raw !== 'object') continue;
    const pid = Number(raw.pid);
    const sessionId = str(raw.sessionId);
    if (!Number.isInteger(pid) || pid <= 0 || !UUID.test(sessionId)) continue;
    const session = {
      pid,
      sessionId,
      name: str(raw.name).trim() || sessionId.slice(0, 8),
      cwd: str(raw.cwd),
      status: str(raw.status) || 'unknown',
      desktop: str(raw.entrypoint) === 'claude-desktop',
      socket: str(raw.messagingSocketPath),
      updatedAt: Number(raw.updatedAt) || Number(raw.startedAt) || 0,
    };
    if (exclude(session) || !alive(pid)) continue;
    const seen = byId.get(sessionId);
    if (!seen || seen.updatedAt < session.updatedAt) byId.set(sessionId, session);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Claude Code names a project folder after its path, every character other
// than a letter or digit turned into '-'.
const projectDirName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

function findTranscript(sessionId, cwd, { projects = claudeDir('projects') } = {}) {
  if (!UUID.test(str(sessionId))) return null;
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const file = path.join(projects, projectDirName(cwd), name);
    if (fs.existsSync(file)) return file;
  }
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch (_) { return null; }
  for (const dir of dirs) {
    const file = path.join(projects, dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The records of the last `maxBytes` of a transcript.
function readTail(file, maxBytes = 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf-8').split('\n');
    if (len < size) lines.shift(); // cut mid-record
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch (_) {}
    }
    return records;
  } catch (_) {
    return [];
  }
}

const since = (records, ms) => records.filter(r => r && Date.parse(r.timestamp) >= ms);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
}

// What started a turn: messages from other sessions, idle notices, and how
// many other prompts (the user's, a finished background task...).
function turnInputs(records) {
  const peers = [];
  const idle = [];
  let others = 0;
  for (const r of records) {
    if (!r || r.type !== 'user' || !r.message || r.isSidechain) continue;
    const content = r.message.content;
    if (r.origin && r.origin.kind === 'peer') {
      const body = str(r.origin.body) || textOf(content).replace(/^[\s\S]*?<cross-session-message[^>]*>\n?/, '').replace(/\n?<\/cross-session-message>[\s\S]*$/, '');
      peers.push({ name: str(r.origin.name) || 'another session', from: str(r.origin.from), body: body.trim() });
      continue;
    }
    const text = textOf(content);
    const notice = /^\[Cross-session idle notice\] "([^"]+)"/.exec(text);
    if (notice) { idle.push(notice[1]); continue; }
    if (Array.isArray(content) && content.length && content.every(c => c && c.type === 'tool_result')) continue;
    if (text.trim()) others++;
  }
  return { peers, idle, others };
}

// The last thing the session wrote as an answer, or null.
function lastAssistantText(records) {
  let last = null;
  for (const r of records) {
    if (!r || r.type !== 'assistant' || r.isSidechain || !r.message) continue;
    const text = textOf(r.message.content).trim();
    if (text) last = text;
  }
  return last;
}

// The folder the session last worked in, from its own records.
function transcriptCwd(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i] && typeof records[i].cwd === 'string' && records[i].cwd) return records[i].cwd;
  }
  return null;
}

module.exports = { listLiveSessions, projectDirName, findTranscript, readTail, since, turnInputs, lastAssistantText, transcriptCwd };
