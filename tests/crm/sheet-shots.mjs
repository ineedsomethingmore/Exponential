/* Drives the CRM page fixture (tests/crm/sheet.html, synthetic data, no network) in headless Chrome:
 * screenshots, plus the behaviours that matter, checked against the fixture's in-memory store:
 *   1. the sheet loads every person except test rows; no status filters, one type filter; every column editable;
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
const key = async (k, code = k, text, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, modifiers, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowDown: 40, ArrowRight: 39, Tab: 9, ' ': 32, z: 90, Z: 90 }[k] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers });
  await sleep(120);
};
const person = (id) => evaluate(`JSON.stringify(window.__db.crm_people.find((p) => p.id === ${JSON.stringify(id)}))`).then((j) => JSON.parse(j));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`) > 0) break; await sleep(250); }
await sleep(400);

// 1. load and counts
const rows = await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`);
const expected = await evaluate(`window.__db.crm_people.filter((p) => !(p.flags || []).includes('test') && !p.archived_at).length`);
check('sheet shows every person except test and archived rows', rows === expected, `${rows} rows, ${expected} expected`);
const heads = () => evaluate(`[...document.querySelectorAll('.cs-grid thead th[data-col]')].map((t) => t.dataset.col).join(',')`);
check('In charge is the column right after Name', (await heads()).startsWith('name,in_charge_user_id,types'), await heads());
check('no status pills above the sheet, one type filter labelled as a filter',
  (await evaluate(`document.querySelectorAll('.cs-filters').length`)) === 0 && (await evaluate(`document.querySelector('select.cs-type option:checked').textContent`)) === 'Type filter');
// the four counters on the left stay, and filter the sheet (iain, 7 Oct)
check('the left panel keeps its four counters', (await evaluate(`[...document.querySelectorAll('.cs-overview .cs-stat span')].map((x) => x.textContent).join('|')`)) === 'New 48h|Not contacted|Our turn|Due');
const dueN = Number(await evaluate(`[...document.querySelectorAll('.cs-stat')].find((b) => b.textContent.endsWith('Due')).querySelector('strong').textContent`));
await evaluate(`[...document.querySelectorAll('.cs-stat')].find((b) => b.textContent.endsWith('Due')).click()`);
await sleep(250);
const dueRows = await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`);
check('a counter filters the sheet to its people, and shows it can be cleared', dueRows === dueN && dueN > 0 && (await evaluate(`!!document.querySelector('.cs-bar .cs-filter.on')`)), `${dueRows} rows, counter ${dueN}`);
await shot('1b-due-filter');
await evaluate(`[...document.querySelectorAll('.cs-stat')].find((b) => b.textContent.endsWith('Due')).click()`);
await sleep(250);
check('clicking it again shows everyone', (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`)) === expected);
check('every column is editable (no read-only header)', (await evaluate(`document.querySelectorAll('.cs-grid thead th.ro').length`)) === 0);
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

// 2a. ⌘Z / Ctrl+Z on the sheet takes the edit back (written to the database), ⌘⇧Z puts it forward again
await click(cellSel('notes'));
await key('z', 'KeyZ', undefined, 2);
await sleep(300);
const undone = (await person(firstId)).notes;
await key('z', 'KeyZ', undefined, 2 | 8);
await sleep(300);
const redone = (await person(firstId)).notes;
check('Ctrl+Z undoes the last edit in the database, Ctrl+Shift+Z redoes it', (undone === null || undone === undefined) && redone === 'Called, visiting Friday', `${undone} / ${redone}`);

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

// 3a1. Other is a type, and the type filter finds it
await click(cellSel('types'));
await key('Enter', 'Enter', '\r');
await sleep(150);
check('the Type editor offers Other', (await evaluate(`[...document.querySelectorAll('.cs-pop .cs-menu-check')].some((l) => l.textContent === 'Other')`)) === true);
await key('Escape', 'Escape');
await sleep(150);
const otherCount = await evaluate(`[...document.querySelectorAll('select.cs-type option')].find((o) => o.value === 'other').textContent`);
check('the type filter counts Other', /Other \(1\)/.test(otherCount), otherCount);

// 3a2. the derived columns are editable too: Came from (a label on the attribution), Their message (the submission)
await click(cellSel('_from'));
await key('Enter', 'Enter', '\r');
await sleep(150);
await evaluate(`(() => { const i = document.querySelector('input.cs-edit'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Intro from a friend'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await key('Enter', 'Enter', '\r');
await sleep(300);
const from = (await person(firstId)).attribution;
check('Came from is editable and stored', from && from.label === 'Intro from a friend' && (await evaluate(`document.querySelector('${cellSel('_from')}').textContent`)) === 'Intro from a friend', JSON.stringify(from));
const saidId = await evaluate(`(window.__db.crm_submissions.find((s) => s.person_id === ${JSON.stringify(firstId)}) || {}).id || null`);
await click(cellSel('_said'));
await key('Enter', 'Enter', '\r');
await sleep(150);
await evaluate(`(() => { const t = document.querySelector('.cs-pop textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Wants a visit in November'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await click('.cs-pop .cs-menu-foot .pill');
await sleep(400);
const sub = JSON.parse(await evaluate(`JSON.stringify(window.__db.crm_submissions.filter((s) => s.person_id === ${JSON.stringify(firstId)}).map((s) => ({ id: s.id, text: s.text_body })))`));
const subAudit = await evaluate(`window.__writes.some((w) => w.table === 'crm_audit' && w.row.target_table === 'crm_submissions' && w.row.after.text_body === 'Wants a visit in November')`);
check('Their message is editable: the submission text changes, with an audit line', sub.some((x) => x.text === 'Wants a visit in November') && subAudit && (await evaluate(`document.querySelector('${cellSel('_said')}').textContent`)) === 'Wants a visit in November', JSON.stringify(sub) + ' ' + saidId);

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
const saved = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('exponential-crm-view-v2:team-fixture:u-iain')).widths.notes; } catch (e) { return null; } })()`);
check('dragging a header edge resizes and is remembered', w1 > w0 + 80 && saved > 0, `${w0} -> ${w1}, saved ${saved}`);

// 3b4. Columns: an optional column can be shown
await click('.cs-cols-wrap > button');
await evaluate(`[...document.querySelectorAll('.cs-cols label')].find((l) => l.textContent === 'Company').querySelector('input').click()`);
await sleep(200);
check('an optional column can be shown', (await evaluate(`[...document.querySelectorAll('.cs-grid thead th')].some((t) => t.textContent.startsWith('Company'))`)) === true);
await evaluate(`[...document.querySelectorAll('.cs-cols label')].find((l) => l.textContent === 'Company').querySelector('input').click()`);
await click('.cs-cols-wrap > button');

// 3b5. In charge: Take puts me in charge (one column + one audit line), ⌘Z takes it back; the cell's menu picks anyone
await evaluate(`document.querySelector('.cs-grid-wrap').scrollLeft = 0`);
const freeId = await evaluate(`(() => { const td = [...document.querySelectorAll('td[data-cell$=":in_charge_user_id"]')].find((t) => t.querySelector('.cs-take')); return td && td.dataset.cell.split(':')[0]; })()`);
const nW = await evaluate(`window.__writes.length`);
await click(`td[data-cell="${freeId}:in_charge_user_id"] .cs-take`);
await sleep(300);
const tw = JSON.parse(await evaluate(`JSON.stringify(window.__writes.slice(${nW}))`));
check('Take puts me in charge: one column written, one audit line', (await person(freeId)).in_charge_user_id === 'u-iain'
  && tw.some((w) => w.table === 'crm_people' && JSON.stringify(w.patch) === '{"in_charge_user_id":"u-iain"}')
  && tw.some((w) => w.table === 'crm_audit' && w.row.surface === 'app:sheet' && w.row.after.in_charge_user_id === 'u-iain'), JSON.stringify(tw).slice(0, 300));
check('and the cell shows who', /Alex M\./.test(await evaluate(`document.querySelector('td[data-cell="${freeId}:in_charge_user_id"]').textContent`)));
await shot('2d-in-charge');
await click(`td[data-cell="${freeId}:notes"]`);
await key('z', 'KeyZ', undefined, 2);
await sleep(300);
check('Ctrl+Z lets go again', !(await person(freeId)).in_charge_user_id);
await evaluate(`document.querySelector('.cs-grid-wrap').scrollLeft = 0`);
const ic = await evaluate(`(() => { const r = document.querySelector('td[data-cell="${freeId}:in_charge_user_id"]').getBoundingClientRect(); return [r.right - 8, r.top + r.height / 2]; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ic[0], y: ic[1], button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ic[0], y: ic[1], button: 'left', clickCount: 1 });
await sleep(120);
await key('Enter', 'Enter', '\r');
await sleep(150);
const opts = await evaluate(`[...document.querySelectorAll('.cs-pop button[data-v]')].map((b) => b.textContent).join('|')`);
check('the In charge menu lists the team, me first', opts.startsWith('Alex Morgan (you)') && opts.includes('Sam Lee') && opts.includes('Kim Park'), opts);
await click('.cs-pop button[data-v="u-rasmus"]');
await sleep(300);
check('choosing a colleague puts them in charge', (await person(freeId)).in_charge_user_id === 'u-rasmus');

// 3b6. Move a column: drag the Due header in front of Type; the order is this member's own (machine and account)
await evaluate(`document.querySelector('.cs-grid-wrap').scrollLeft = 0`);
await sleep(100);
const hdr = async (col) => evaluate(`(() => { const r = document.querySelector('thead th[data-col="${col}"]').getBoundingClientRect(); return [r.left, r.top + r.height / 2, r.width]; })()`);
const [dx, dy, dw] = await hdr('next_action_due');
const [tx] = await hdr('types');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dx + dw / 2, y: dy, button: 'left', clickCount: 1 });
for (let k = 1; k <= 10; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dx + dw / 2 + ((tx + 8) - (dx + dw / 2)) * k / 10, y: dy, button: 'left', buttons: 1 });
await shot('2e-column-drag');
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx + 8, y: dy, button: 'left', clickCount: 1 });
await sleep(900);
const order = await heads();
check('dragging a header moves the column', order.startsWith('name,in_charge_user_id,next_action_due,types'), order);
check('and a drag does not sort', (await evaluate(`!document.querySelector('thead th[data-col="next_action_due"] i')`)) === true);
const mine = JSON.parse(await evaluate(`JSON.stringify((window.__db.crm_user_views.find((r) => r.user_id === 'u-iain') || {}).view || null)`));
const local = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('exponential-crm-view-v2:team-fixture:u-iain')).order.slice(0, 4).join(','); } catch (e) { return null; } })()`);
const theirs = await evaluate(`JSON.stringify(window.__db.crm_user_views.find((r) => r.user_id === 'u-rasmus').view.order)`);
check("the new order is saved to my account and this machine, and nobody else's view changes", !!mine && mine.order.slice(0, 4).join(',') === 'name,in_charge_user_id,next_action_due,types'
  && local === 'name,in_charge_user_id,next_action_due,types' && theirs === '["name","notes","types"]', `${mine && mine.order.slice(0, 4)} | ${local} | ${theirs}`);

// 3b. the chat: a conversation that shows what the agent is doing, what it changed (with Undo), and its questions
check('the chat is visible before anything is sent', (await evaluate(`!!document.querySelector('.cs-overview .cs-chat-log .cs-chat-empty')`)) === true);
await click('.cs-overview .cs-chat-in textarea');
await send('Input.insertText', { text: 'Called Avery, sending the deck' });
await key('Enter', 'Enter', '\r');
let live = '';
for (let i = 0; i < 20 && !/Reading the CRM/.test(live); i++) { live = await evaluate(`[...document.querySelectorAll('.cs-overview .cs-turn.busy p')].map((p) => p.textContent).join(' | ')`) || ''; await sleep(60); }
check('while it works, the chat shows what the agent is doing', /Reading the CRM/.test(live || ''), live);
await shot('2b0-chat-working');
for (let i = 0; i < 30; i++) { if (await evaluate(`document.querySelectorAll('.cs-overview .cs-turn.agent:not(.busy)').length`)) break; await sleep(150); }
const chat = await evaluate(`JSON.stringify({ calls: window.__chat.length, auth: window.__chat[0] && window.__chat[0].auth, msg: window.__chat[0] && window.__chat[0].body.message, stream: window.__chat[0] && window.__chat[0].body.stream, reply: (document.querySelector('.cs-overview .cs-turn.agent p') || {}).textContent, applied: (document.querySelector('.cs-overview .cs-turn.agent .cs-applied') || {}).textContent })`);
const ch = JSON.parse(chat);
check('the chat sends the message with the session token, streaming', ch.calls === 1 && ch.auth === 'Bearer fixture-token' && ch.msg === 'Called Avery, sending the deck' && ch.stream === true, chat);
check('and shows the reply and each change, before and after', /Noted/.test(ch.reply || '') && /Next step/.test(ch.applied || '') && /→/.test(ch.applied || ''), chat);
const chatPerson = await evaluate(`window.__db.crm_people[0].id`);
await evaluate(`document.querySelector('.cs-overview .cs-applied .cs-undo').click()`);
await sleep(400);
const afterUndo = await person(chatPerson);
check('Undo on a chat turn puts the values back', afterUndo.next_action_kind !== 'email' && !/Send the deck/.test(afterUndo.next_action || ''), JSON.stringify({ a: afterUndo.next_action, k: afterUndo.next_action_kind }));
await click('.cs-overview .cs-chat-in textarea');
await send('Input.insertText', { text: 'Jordan is coming Friday' });
await key('Enter', 'Enter', '\r');
for (let i = 0; i < 30; i++) { if (await evaluate(`document.querySelectorAll('.cs-overview .cs-asks').length`)) break; await sleep(150); }
const asks = await evaluate(`(document.querySelector('.cs-overview .cs-asks p') || {}).textContent || ''`);
const conv = await evaluate(`JSON.stringify(window.__chat[1] && window.__chat[1].body.conversation)`);
check('the agent can ask back, and the earlier turns (with what it changed) travel with the next message', /Jordan Sample/.test(asks) && /Changed: /.test(conv || '') && JSON.parse(conv).length >= 2, asks + ' ' + (conv || '').slice(0, 160));
await shot('2b-chat');

// 4. realtime insert
await evaluate(`window.__rt.crm_people({ eventType: 'INSERT', new: { ...window.__db.crm_people[0], id: 'p-new', name: 'Brand New Lead', email_normalized: 'new@example.test', source_at: new Date().toISOString(), last_inbound_at: new Date().toISOString(), last_outbound_at: null, flags: [] }, old: {} })`);
await sleep(300);
check('a realtime insert appears without reload', (await evaluate(`[...document.querySelectorAll('.cs-name span')].some((s) => s.textContent === 'Brand New Lead')`)) === true);
check('and is listed under New in Today', (await evaluate(`[...document.querySelectorAll('.cs-ov-sec')].some((sec) => sec.querySelector('h2').textContent.startsWith('New') && sec.textContent.includes('Brand New Lead'))`)) === true);

// 5. record
await click(`tr:has(td[data-cell^="p-002:"]) .cs-open`);
await sleep(400);
const rec = await evaluate(`JSON.stringify({ open: !!document.querySelector('.cs-record'), findings: document.querySelectorAll('.cs-findings li').length, raw: document.querySelectorAll('.cs-raw tr').length, timeline: document.querySelectorAll('.cs-msg').length })`);
const r = JSON.parse(rec);
check('the record opens with research and every column', r.open && r.findings > 0 && r.raw > 40, rec);
check('with a record open, the chat is about that person', /About/.test(await evaluate(`(document.querySelector('.cs-chat-scope') || {}).textContent || ''`)));
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

// type filter
await evaluate(`(() => { const s = document.querySelector('select.cs-type'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'investor'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(200);
const inv = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.cs-grid tbody tr')].map((tr) => tr.querySelector('td.k-types').textContent))`));
check('the type filter narrows the sheet to that type', inv.length > 0 && inv.length < 35 && inv.every((t) => t.includes('Investor')), `${inv.length} rows`);
await shot('4-type-filter');
const setType = (v) => evaluate(`(() => { const s = document.querySelector('select.cs-type'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '${v}'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await setType('any');
await sleep(200);

// archive: right-click a row, Archive; it leaves the sheet and Today, the type filter's Archived lists it, Unarchive brings it back
const arcId = await evaluate(`document.querySelectorAll('.cs-grid tbody tr')[2].querySelector('td[data-cell]').dataset.cell.split(':')[0]`);
const arcName = (await person(arcId)).name;
const rows0 = await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`);
const rightClick = (id) => evaluate(`(() => { const td = document.querySelector('td[data-cell="${id}:types"]') || document.querySelector('td[data-cell^="${id}:"]'); td.scrollIntoView({ block: 'nearest' }); const r = td.getBoundingClientRect(); td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10, button: 2 })); })()`);
await rightClick(arcId);
await sleep(200);
const ctxItems = await evaluate(`[...document.querySelectorAll('.cs-ctx button')].map((b) => b.textContent).join('|')`);
check('right-click opens the row menu: take, open, archive', /Take|Let go/.test(ctxItems) && /Open the record/.test(ctxItems) && /Archive/.test(ctxItems), ctxItems);
await shot('4b-row-menu');
await evaluate(`[...document.querySelectorAll('.cs-ctx button')].find((b) => b.textContent === 'Archive').click()`);
await sleep(400);
const arcRow = await person(arcId);
check('Archive stamps the row and takes it off the sheet', !!arcRow.archived_at && (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`)) === rows0 - 1
  && !(await evaluate(`!!document.querySelector('td[data-cell^="${arcId}:"]')`)), `${rows0} rows before`);
check('and out of Today', !(await evaluate(`[...document.querySelectorAll('.cs-ov-row b')].some((b) => b.textContent === ${JSON.stringify(arcName)})`)));
const arcOpt = await evaluate(`[...document.querySelectorAll('select.cs-type option')].find((o) => o.value === 'archived').textContent`);
check('the type filter counts the archive', arcOpt === 'Archived (2)', arcOpt);
await setType('archived');
await sleep(250);
const arcRows = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.cs-grid tbody tr')].map((tr) => tr.querySelector('td[data-cell]').dataset.cell.split(':')[0]))`));
check('Archived in the type filter lists the archived rows only', arcRows.length === 2 && arcRows.includes(arcId), JSON.stringify(arcRows));
await shot('4c-archived');
await rightClick(arcId);
await sleep(200);
await evaluate(`[...document.querySelectorAll('.cs-ctx button')].find((b) => b.textContent === 'Unarchive').click()`);
await sleep(400);
check('Unarchive puts it back', !(await person(arcId)).archived_at && (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`)) === 1);
await setType('any');
await sleep(200);

// another account sees its own layout: reload as the other member
await send('Page.navigate', { url: BASE + '?me=u-rasmus' });
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`) > 0) break; await sleep(250); }
await sleep(600);
const theirHeads = await heads();
check("another account's sheet keeps its own order and columns", theirHeads === 'name,notes,types', theirHeads);
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`) > 0) break; await sleep(250); }
await sleep(600);
check('and mine is still mine after a reload', (await heads()).startsWith('name,in_charge_user_id,next_action_due,types'), await heads());

// dark
await send('Page.navigate', { url: BASE + '?dark' });
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('.cs-grid tbody tr').length`) > 0) break; await sleep(250); }
await sleep(400);
await shot('5-dark');

check('no page errors', logs.length === 0, logs.join(' | '));
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(results.every((x) => x.ok) ? 'ALL PASS' : 'SOME FAILED', OUT);
process.exit(results.every((x) => x.ok) ? 0 : 1);
