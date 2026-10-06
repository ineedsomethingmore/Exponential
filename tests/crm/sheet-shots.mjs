/* Drives the CRM page fixture (tests/crm/sheet.html, synthetic data, no network) in headless Chrome:
 * screenshots, plus the behaviours that matter, checked against the fixture's in-memory store:
 *   1. the sheet loads every person except test rows, and the overview counts add up;
 *   2. typing into a cell writes ONE column to crm_people and ONE crm_audit line (surface app:sheet);
 *   3. a select cell (Stage) writes the chosen value; Escape cancels without a write;
 *   4. a realtime INSERT puts a new person on the sheet without a reload;
 *   5. the record opens from the name, shows the research findings and every DB column.
 *
 *   npx vite --port 5191 --strictPort &   then   node tests/crm/sheet-shots.mjs [outdir] [WxH]
 *
 * Claude, 6 Oct 2026. */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = process.argv[2] || '/tmp/crm-sheet-shots';
const [W, H] = (process.argv[3] || '1600x980').split('x').map(Number);
const BASE = process.env.BASE || 'http://localhost:5191/tests/crm/sheet.html';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9533 + Math.floor(Math.random() * 100);
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, `--user-data-dir=/tmp/crm-sheet-profile-${PORT}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } });
let endpoint = null;
for (let i = 0; i < 50 && !endpoint; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) endpoint = p.webSocketDebuggerUrl; } catch { await sleep(200); }
}
if (!endpoint) { console.error('no chrome'); process.exit(2); }
const ws = new WebSocket(endpoint);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
};
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const center = async (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2]; })()`);
const click = async (sel, count = 1) => {
  const c = await center(sel); if (!c) throw new Error('no element ' + sel);
  for (let n = 1; n <= count; n++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', clickCount: n });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', clickCount: n });
  }
  await sleep(120);
};
const key = async (k, code = k, text) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowDown: 40, ArrowRight: 39, Tab: 9, ' ': 32 }[k] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  await sleep(120);
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`) > 0) break; await sleep(250); }
await sleep(400);

// 1. load and counts
const rows = await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`);
const expected = await evaluate(`window.__db.crm_people.filter((p) => !(p.flags || []).includes('test')).length`);
check('sheet shows every person except test rows', rows === expected, `${rows} rows, ${expected} expected`);
const allCount = await evaluate(`document.querySelector('.cs-filter span').textContent`);
check('All filter count matches', Number(allCount) === expected, allCount);
await shot('1-overview-sheet');

// 2. type into Notes on row 1: typing opens the long-text editor with that letter; Save commits
const firstId = await evaluate(`document.querySelector('.cs-grid tbody td[data-cell]').dataset.cell.split(':')[0]`);
const cellSel = (key) => `td[data-cell="${firstId}:${key}"]`;
await click(cellSel('notes'));
await key('C', 'KeyC', 'C');
await sleep(150);
await send('Input.insertText', { text: 'alled, visiting Friday' });
await sleep(100);
await shot('2-editing-notes');
await click('.cs-pop .cs-menu-foot .pill');
await sleep(300);
const writes = JSON.parse(await evaluate(`JSON.stringify(window.__writes)`));
const upd = writes.find((x) => x.table === 'crm_people' && x.op === 'update');
const aud = writes.find((x) => x.table === 'crm_audit' && x.op === 'insert');
check('typing writes one column', !!upd && Object.keys(upd.patch).length === 1 && upd.patch.notes === 'Called, visiting Friday', JSON.stringify(upd?.patch));
check('the edit leaves an audit line', !!aud && aud.row.surface === 'app:sheet' && aud.row.actor_user_id === 'u-iain' && aud.row.after.notes === 'Called, visiting Friday', JSON.stringify(aud?.row?.after));
const cellText = await evaluate(`document.querySelector('${cellSel('notes')}').textContent`);
check('the cell shows the stored value', cellText === 'Called, visiting Friday', cellText);

// 3. Stage: Enter opens a menu of the person's type's stages; choosing writes it
await click(cellSel('_stage'));
await key('Enter', 'Enter', '\r');
await sleep(150);
await click('.cs-pop button[data-v="customer:engaged"]');
await sleep(300);
const stage = await evaluate(`window.__db.crm_people.find((p) => p.id === ${JSON.stringify(firstId)}).customer_stage`);
check('the Stage menu writes the stage', stage === 'engaged', stage);
check('and the cell reads In conversation', (await evaluate(`document.querySelector('${cellSel('_stage')}').textContent`)) === 'In conversation');

// 3a. Type: several allowed, saved together
await click(cellSel('types'));
await key('Enter', 'Enter', '\r');
await sleep(150);
await evaluate(`[...document.querySelectorAll('.cs-pop .cs-menu-check')].find((l) => l.textContent === 'Investor').querySelector('input').click()`);
await click('.cs-pop .cs-menu-foot .pill');
await sleep(300);
const types = await evaluate(`JSON.stringify(window.__db.crm_people.find((p) => p.id === ${JSON.stringify(firstId)}).types)`);
check('Type saves several types', types === '["customer","investor"]', types);

// 3b0. Due: a quick date writes tomorrow
await click(cellSel('next_action_due'));
await key('Enter', 'Enter', '\r');
await sleep(150);
await evaluate(`[...document.querySelectorAll('.cs-pop .cs-quick button')].find((b) => b.textContent === 'Tomorrow').click()`);
await sleep(300);
const due = await evaluate(`window.__db.crm_people.find((p) => p.id === ${JSON.stringify(firstId)}).next_action_due`);
const tmr = await evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
check('Due takes a quick date', due === tmr, `${due} vs ${tmr}`);

// 3b1. Next step: kind and text are saved together; Escape on a new edit writes nothing
await click(cellSel('next_action'));
await key('Enter', 'Enter', '\r');
await sleep(150);
await evaluate(`[...document.querySelectorAll('.cs-pop .cs-quick button')].find((b) => b.textContent === 'Call').click()`);
await evaluate(`(() => { const t = document.querySelector('.cs-pop textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Call about the visit'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(100);
await click('.cs-pop .cs-menu-foot .pill');
await sleep(300);
const step = await evaluate(`JSON.stringify((({ next_action, next_action_kind }) => ({ next_action, next_action_kind }))(window.__db.crm_people.find((p) => p.id === ${JSON.stringify(firstId)})))`);
check('Next step saves its text and kind together', step === '{"next_action":"Call about the visit","next_action_kind":"call"}', step);
const before = await evaluate(`window.__writes.length`);
await click(cellSel('next_action'));
await key('X', 'KeyX', 'X');
await sleep(150);
await key('Escape', 'Escape');
await sleep(200);
check('Escape cancels without a write', (await evaluate(`window.__writes.length`)) === before);

// 3b2. Peek: a cut-off value shows in full under the selected cell
const longId = await evaluate(`(() => { const p = window.__db.crm_people.find((x) => (window.__db.crm_submissions.find((s) => s.person_id === x.id && (s.text_body || '').length > 60))); return p && p.id; })()`);
await click(`td[data-cell="${longId}:_said"]`);
await sleep(200);
const peek = await evaluate(`(document.querySelector('.cs-peek') || {}).textContent || ''`);
check('a cut-off value shows in full on one click', peek.length > 60, peek.slice(0, 60));
await shot('2c-peek');

// 3b3. Resize: dragging a header edge widens the column and is remembered
const w0 = await evaluate(`document.querySelector('${cellSel('notes')}').getBoundingClientRect().width`);
await sleep(100);
const hc = await evaluate(`(() => { const th = [...document.querySelectorAll('.cs-grid thead th')].find((t) => t.textContent.startsWith('Notes')); th.scrollIntoView({ inline: 'center', block: 'nearest' }); const r = th.querySelector('.cs-resize').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hc[0], y: hc[1], button: 'left', clickCount: 1 });
for (let k = 1; k <= 8; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hc[0] + k * 15, y: hc[1], button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hc[0] + 120, y: hc[1], button: 'left', clickCount: 1 });
await sleep(200);
const w1 = await evaluate(`document.querySelector('${cellSel('notes')}').getBoundingClientRect().width`);
const saved = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('exponential-crm-view-v1')).widths.notes; } catch (e) { return null; } })()`);
check('dragging a header edge resizes and is remembered', w1 > w0 + 80 && saved > 0, `${w0} -> ${w1}, saved ${saved}`);

// 3b4. Columns: an optional column can be shown
await click('.cs-cols-wrap > button');
await evaluate(`[...document.querySelectorAll('.cs-cols label')].find((l) => l.textContent === 'Company').querySelector('input').click()`);
await sleep(200);
check('an optional column can be shown', (await evaluate(`[...document.querySelectorAll('.cs-grid thead th')].some((t) => t.textContent.startsWith('Company'))`)) === true);
await evaluate(`[...document.querySelectorAll('.cs-cols label')].find((l) => l.textContent === 'Company').querySelector('input').click()`);
await click('.cs-cols-wrap > button');

// 3b. the chat box sends with the member's token and shows the agent's reply and what changed
await click('.cs-overview .cs-chat-in textarea');
await send('Input.insertText', { text: 'Called Avery, sending the deck' });
await key('Enter', 'Enter', '\r');
for (let i = 0; i < 20; i++) { if (await evaluate(`document.querySelectorAll('.cs-overview .cs-turn.agent:not(.busy)').length`)) break; await sleep(150); }
const chat = await evaluate(`JSON.stringify({ calls: window.__chat.length, auth: window.__chat[0] && window.__chat[0].auth, msg: window.__chat[0] && window.__chat[0].body.message, reply: (document.querySelector('.cs-overview .cs-turn.agent p') || {}).textContent, applied: (document.querySelector('.cs-overview .cs-turn.agent li') || {}).textContent })`);
const ch = JSON.parse(chat);
check('the chat box sends the message with the session token', ch.calls === 1 && ch.auth === 'Bearer fixture-token' && ch.msg === 'Called Avery, sending the deck', chat);
check('and shows the reply with what changed', /Noted/.test(ch.reply || '') && /Next step/.test(ch.applied || ''), chat);
await shot('2b-chat');

// 4. realtime insert
await evaluate(`window.__rt.crm_people({ eventType: 'INSERT', new: { ...window.__db.crm_people[0], id: 'p-new', name: 'Brand New Lead', email_normalized: 'new@example.test', source_at: new Date().toISOString(), last_inbound_at: new Date().toISOString(), last_outbound_at: null, flags: [] }, old: {} })`);
await sleep(300);
check('a realtime insert appears without reload', (await evaluate(`[...document.querySelectorAll('.cs-name span')].some((s) => s.textContent === 'Brand New Lead')`)) === true);
check('and is counted in New', (await evaluate(`document.querySelector('.cs-stat strong').textContent`)) !== '0');

// 5. record
await click(`tr:has(td[data-cell^="p-002:"]) .cs-open`);
await sleep(400);
const rec = await evaluate(`JSON.stringify({ open: !!document.querySelector('.cs-record'), findings: document.querySelectorAll('.cs-findings li').length, raw: document.querySelectorAll('.cs-raw tr').length, timeline: document.querySelectorAll('.cs-msg').length })`);
const r = JSON.parse(rec);
check('the record opens with research and every column', r.open && r.findings > 0 && r.raw > 40, rec);
check('no raw ISO timestamps in the record', !(await evaluate(`/\\d{4}-\\d{2}-\\d{2}T\\d{2}:/.test([...document.querySelectorAll('.cs-record .cs-rec-sec')].filter((x) => !x.querySelector('.cs-raw')).map((x) => x.innerText).join(' '))`)));
await shot('3-record');
// the record lists changes, and Undo puts the earlier value back (recorded as a new edit)
await key('Escape', 'Escape');
await click(`tr:has(td[data-cell^="${firstId}:"]) .cs-open`);
await sleep(400);
const hist = await evaluate(`document.querySelectorAll('.cs-record .cs-change').length`);
check('the record shows its change history', hist > 0, String(hist));
const undoBtn = await evaluate(`(() => { const rows = [...document.querySelectorAll('.cs-record .cs-change-row')]; const r = rows.find((x) => x.querySelector('.cs-change-f').textContent === 'Notes' && !x.querySelector('.cs-undo').disabled); if (!r) return false; r.querySelector('.cs-undo').click(); return true; })()`);
await sleep(400);
const notesNow = await evaluate(`window.__db.crm_people.find((p) => p.id === ${JSON.stringify(firstId)}).notes`);
check('Undo restores the earlier notes', undoBtn && (notesNow === null || notesNow === undefined), String(notesNow));
await shot('3b-history');
await key('Escape', 'Escape');

// filters
await click('.cs-stat:nth-child(2)');
await sleep(200);
await shot('4-filter-not-contacted');

// dark
await send('Page.navigate', { url: BASE + '?dark' });
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`) > 0) break; await sleep(250); }
await sleep(400);
await shot('5-dark');

check('no page errors', logs.length === 0, logs.join(' | '));
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(results.every((x) => x.ok) ? 'ALL PASS' : 'SOME FAILED', OUT);
process.exit(results.every((x) => x.ok) ? 0 : 1);
