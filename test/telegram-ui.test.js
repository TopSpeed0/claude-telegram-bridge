'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTables, richTables, richMarkdown, preBlock } = require('../mcp/telegram-ui');

test('rich Markdown keeps line breaks, but not inside tables or code', () => {
  const md = 'Line one\nLine two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode a\ncode b\n```\nend';
  assert.equal(richMarkdown(md), 'Line one  \nLine two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode a\ncode b\n```  \nend');
});

const mark = (i) => `@@T${i}@@`;

test('a narrow table becomes an aligned monospace block', () => {
  const md = 'Before\n| Vol | Used |\n|---|---:|\n| vol1 | 80% |\n| data_2 | 5% |\nAfter';
  const { text, tables } = extractTables(md, mark);
  assert.equal(text, 'Before\n@@T0@@\nAfter');
  assert.equal(tables[0], '<pre>Vol     Used\n────────────\nvol1    80%\ndata_2  5%</pre>');
});

test('a wide table becomes one line per row, escaped, without raw pipes', () => {
  const md = '| # | Time | Alert | Affected VM |\n|---|------|-------|-------------|\n'
    + '| 1 | 00:52:50 | Disk I/O write latency high | Own_PC_Default_romaster9.cgnt_OWNPC2 |\n'
    + '| 2 | 00:52:48 | **Read** <latency> | `vm2` |';
  const { text, tables } = extractTables(md, mark);
  assert.equal(text, '@@T0@@');
  assert.equal(tables[0], '• <b>1</b> · 00:52:50 · Disk I/O write latency high · Own_PC_Default_romaster9.cgnt_OWNPC2\n'
    + '• <b>2</b> · 00:52:48 · Read &lt;latency&gt; · vm2');
});

test('leaves text with stray pipes alone', () => {
  const md = 'Run: grep x | sort\nA | B without a rule line';
  assert.deepEqual(extractTables(md, mark), { text: md, tables: [] });
});

test('in a rich message, narrow tables stay tables and wide ones become aligned code', () => {
  const narrow = '| Tip | Why | Priority |\n|---|---|---|\n| Keep aggr under 85% | WAFL needs room | 🔴 High |';
  const wide = '| Volume | SVM | Size | Used | State |\n|---|---|---|---|---|\n| vol_applog | prod | 171 GB | 91% 🔴 | online |\n| vol_db | prod | 7.7 TB | 62% | online |';
  const out = richTables(`Tips\n${narrow}\n\nVolumes\n${wide}\nEnd`, 4);
  assert.equal(out, `Tips\n${narrow}\n\nVolumes\n`
    + '```\nVolume      SVM   Size    Used    State\n'
    + `${'─'.repeat(40)}\n`
    + 'vol_applog  prod  171 GB  91% 🔴  online\n'
    + 'vol_db      prod  7.7 TB  62%     online\n```\nEnd');
});

test('a data table up to 60 wide stays monospace, emoji counted as two cells', () => {
  const md = '| Volume | SVM | Used | State |\n|---|---|---|---|\n| vol_applog | prod | 91% 🔴 | online |\n| vol_db | prod | 62% | online |';
  const { tables } = extractTables(md, mark);
  assert.equal(tables[0], '<pre>Volume      SVM   Used    State\n'
    + `${'─'.repeat(32)}\n`
    + 'vol_applog  prod  91% 🔴  online\n'
    + 'vol_db      prod  62%     online</pre>');
});

test('a code block keeps its fence language as a Telegram label', () => {
  assert.equal(preBlock('Get-Item <x> & y', 'powershell'), '<pre><code class="language-powershell">Get-Item &lt;x&gt; &amp; y</code></pre>');
  assert.equal(preBlock('plain', ''), '<pre>plain</pre>');
  assert.equal(preBlock('odd', 'a"b'), '<pre>odd</pre>');
  const long = Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(preBlock(long, 'bash'), `<blockquote expandable><pre><code class="language-bash">${long}</code></pre></blockquote>`);
});

test('a progress line in Telegram HTML becomes Markdown for a rich draft', () => {
  const { htmlLineToMarkdown } = require('../mcp/telegram-ui');
  assert.equal(htmlLineToMarkdown('💻 <code>git status &amp;&amp; ls</code>'), '💻 `git status && ls`');
  assert.equal(htmlLineToMarkdown('📖 Read <code>a&lt;b&gt;.md</code>'), '📖 Read `a<b>.md`');
  assert.equal(htmlLineToMarkdown('💻 <code>echo `x`</code>'), '💻 `` echo `x` ``');
  assert.equal(htmlLineToMarkdown('🤖 Agent: check &amp; report'), '🤖 Agent: check & report');
});

test('only long code blocks and long quotes keep an answer in HTML', () => {
  const { collapsesOnlyInHtml } = require('../mcp/telegram-ui');
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  assert.equal(collapsesOnlyInHtml(`ok\n\n\`\`\`bash\n${lines(12)}\n\`\`\``), false);
  assert.equal(collapsesOnlyInHtml(`ok\n\n\`\`\`bash\n${lines(13)}\n\`\`\``), true);
  assert.equal(collapsesOnlyInHtml('> a\n> b\n> c\n> d\nend'), false);
  assert.equal(collapsesOnlyInHtml('> a\n> b\n> c\n> d\n> e'), true);
  assert.equal(collapsesOnlyInHtml('| a | b |\n|---|---|\n| 1 | 2 |'), false);
});
