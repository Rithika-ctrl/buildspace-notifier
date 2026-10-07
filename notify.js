// BuildSpace notifier: runs every 5 min on GitHub Actions (free). Needs no Firebase paid plan.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore(), { FieldValue } = admin.firestore, msg = admin.messaging();

let where = 'start';
const mark = m => { where = m; console.log(new Date().toISOString().slice(11, 19), m); };
setTimeout(() => { console.error('TIMEOUT while:', where); process.exit(2); }, 90000);
const IST = 5.5 * 36e5, istStr = ms => new Date(ms + IST).toISOString().slice(0, 16);
const t12 = at => { const [h, m] = at.slice(11, 16).split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const list = (a, n = 3) => (a.length <= n ? a.join(', ') : a.slice(0, n).join(', ') + ` +${a.length - n} more`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isLow = m => m.delivered > 0 && (m.delivered - (m.used || 0)) / m.delivered <= 0.2;
const STAGES = [180, 60, 15, 10];       // minutes before; 10 = alarm
const SLOT_WINDOW = 90;                  // a 8/18/21 job still runs if GitHub starts late, up to 90 min
const SNAG_INSTANT = true, BUDGET_STEPS = [80, 100], OVERDUE_DAYS = 120;
const SLOTS = [['digest', 8 * 60], ['t18', 18 * 60], ['t21', 21 * 60]];

async function push(U, { title, body, tag, alarm, ttl }) {
  if (!U.devs.length) return;
  const res = await msg.sendEachForMulticast({
    tokens: U.devs.map(d => d.token),
    data: { title, body, tag: tag || 'buildspace', url: './', alarm: alarm ? '1' : '0' },
    webpush: { headers: { Urgency: 'high', TTL: String(ttl || 3600) } },
  });
  console.log(`push "${title}" -> ${res.successCount} ok, ${res.failureCount} failed`);
  res.responses.forEach(r => { if (!r.success) console.error('  send error:', r.error && r.error.code, '-', r.error && r.error.message); });
  await Promise.all(res.responses.map((r, i) => {
    const c = r.error && r.error.code;
    return !r.success && (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') ? U.devs[i].ref.delete() : null;
  }));
}
const pname = async (U, pid) => {
  if (!pid) return '';
  if (!U.pn.has(pid)) { const s = await db.doc(`users/${U.uid}/projects/${pid}`).get(); U.pn.set(pid, s.exists ? s.data().name || '' : ''); }
  return U.pn.get(pid);
};
const items = U => db.collection(`users/${U.uid}/items`);

// ----- 3h / 1h / 15m reminders + 10m alarm (events and tasks with a due time) -----
async function reminders(U, now) {
  const from = istStr(now), to = istStr(now + 181 * 6e4);
  const [ev, tk] = await Promise.all([
    items(U).where('at', '>=', from).where('at', '<=', to).get(),
    items(U).where('dueAt', '>=', from).where('dueAt', '<=', to).get(),
  ]);
  for (const [d, type, f] of [...ev.docs.map(d => [d, 'event', 'at']), ...tk.docs.map(d => [d, 'task', 'dueAt'])]) {
    const e = d.data(), at = e[f];
    if (e.type !== type || !at || e.done || e.status === 'Completed') continue;
    const left = (Date.parse(at + ':00+05:30') - now) / 6e4;
    if (left < 0) continue;
    const sent = e.rem && e.rem.at === at ? e.rem.s : [];
    const crossed = STAGES.filter(s => left <= s);
    if (!crossed.length) continue;
    const stage = Math.min(...crossed);
    if (sent.includes(stage)) continue;
    const pn = await pname(U, e.pid), what = e.title || (type === 'task' ? 'Task' : 'Upcoming event');
    const sub = `${type === 'task' ? 'Task due' : e.kind || 'Event'} at ${t12(at)}${pn ? ' · ' + pn : ''}`, tag = 'evt-' + d.id;
    const mins = Math.max(1, Math.round(left));
    if (stage === 10) await push(U, { title: `🚨 ALARM · ${what} in ${mins} min`, body: sub, tag: 'alm-' + d.id, alarm: true, ttl: 600 }); // own tag: never replaces the earlier reminder
    else await push(U, { title: `⏰ ${what} in ${left >= 150 ? '3 hours' : left >= 55 ? '1 hour' : mins + ' min'}`, body: sub, tag });
    await d.ref.update({ rem: { at, s: STAGES.filter(s => s >= stage) } });
  }
}

// ----- 8 AM digest -----
async function digest(U, now) {
  const today = istStr(now).slice(0, 10), since = istStr(now - OVERDUE_DAYS * 864e5).slice(0, 10);
  const [due, over, ev, mats] = await Promise.all([
    items(U).where('due', '==', today).get(),
    items(U).where('due', '>=', since).where('due', '<', today).get(),
    items(U).where('at', '>=', today + 'T00:00').where('at', '<=', today + 'T23:59').get(),
    items(U).where('type', '==', 'material').get(),
  ]);
  const open = d => d.data().type === 'task' && d.data().status !== 'Completed';
  const nEv = ev.docs.filter(d => d.data().type === 'event' && !d.data().done).length;
  const nDue = due.docs.filter(open).length, nOver = over.docs.filter(open).length;
  const deliv = [], low = [], w = [];
  for (const d of mats.docs) {
    const m = d.data(), lab = (m.name || 'Material') + (await pname(U, m.pid) ? ` (${await pname(U, m.pid)})` : '');
    if (m.date === today) deliv.push(lab);
    if (isLow(m) && !m.lowNotified) { low.push(lab); w.push(d.ref.update({ lowNotified: true })); }
    else if (!isLow(m) && m.lowNotified) w.push(d.ref.update({ lowNotified: FieldValue.delete() }));
  }
  const top = [nEv && `📍 ${plural(nEv, 'visit/meeting')}`, nDue && `✅ ${plural(nDue, 'task')} due`, nOver && `⚠️ ${nOver} overdue`].filter(Boolean);
  const lines = [top.join(' · '), deliv.length && `🚚 Delivery today: ${list(deliv)}`, low.length && `🧱 Low stock: ${list(low)}`].filter(Boolean);
  if (lines.length) await push(U, { title: '🏗️ Today on site', body: lines.join('\n'), tag: 'digest' });
  await Promise.all(w);
  const ps = await db.collection(`users/${U.uid}/projects`).get();   // full budget check once a day
  for (const p of ps.docs) await checkBudget(U, p.id);
}

// ----- tomorrow preview (6 PM and 9 PM) -----
async function tomorrow(U, now, title) {
  const tm = istStr(now + 864e5).slice(0, 10);
  const [ev, tk, mats] = await Promise.all([
    items(U).where('at', '>=', tm + 'T00:00').where('at', '<=', tm + 'T23:59').get(),
    items(U).where('due', '==', tm).get(),
    items(U).where('type', '==', 'material').get(),
  ]);
  const evs = ev.docs.map(d => d.data()).filter(e => e.type === 'event').sort((a, b) => (a.at < b.at ? -1 : 1)).map(e => `${t12(e.at)} ${e.title || e.kind || 'Event'}`);
  const nDue = tk.docs.filter(d => d.data().type === 'task' && d.data().status !== 'Completed').length, deliv = [];
  for (const d of mats.docs) if (d.data().date === tm) { const pn = await pname(U, d.data().pid); deliv.push((d.data().name || 'Material') + (pn ? ` (${pn})` : '')); }
  const lines = [evs.length && `📍 ${list(evs)}`, deliv.length && `🚚 Delivery: ${list(deliv)}`, nDue && `✅ ${plural(nDue, 'task')} due`].filter(Boolean);
  console.log(`${title}: ${evs.length} visit(s), ${deliv.length} delivery(ies), ${nDue} task(s) for ${tm}`);
  await push(U, { title, body: lines.length ? lines.join('\n') : 'Nothing planned for tomorrow yet.', tag: 'tomorrow' }); // always sent, so you know it ran
}

// ----- budget 80% / 100% (once per step; re-arms if spend drops) -----
async function checkBudget(U, pid) {
  const ref = db.doc(`users/${U.uid}/projects/${pid}`), p = await ref.get();
  if (!p.exists || !(p.data().budget > 0)) return;
  const pr = p.data(), es = await items(U).where('pid', '==', pid).where('type', '==', 'expense').get();
  const spent = es.docs.reduce((a, d) => a + (+d.data().amount || 0), 0), pc = spent / pr.budget * 100;
  const crossed = BUDGET_STEPS.filter(s => pc >= s), prev = pr.budgetNotified || [], fresh = crossed.filter(s => !prev.includes(s));
  if (fresh.length) {
    const over = Math.max(...fresh) >= 100;
    await push(U, { title: over ? `🚨 ${pr.name} is over budget` : `💰 ${pr.name} has used ${Math.max(...fresh)}% of budget`,
      body: over ? `${inr(spent)} spent · ${inr(spent - pr.budget)} over the ${inr(pr.budget)} budget` : `${inr(spent)} of ${inr(pr.budget)} spent`, tag: 'budget-' + pid });
  }
  if (crossed.join() !== prev.join()) await ref.update({ budgetNotified: crossed });
}

// ----- new High snags / new expenses since last run (30 min look-back; flags prevent repeats) -----
async function instant(U, st, now) {
  const since = Math.min(st.lastTs || now, now) - 30 * 6e4;
  const nw = await items(U).where('ts', '>', since).get();
  const pids = new Set();
  for (const d of nw.docs) {
    const x = d.data();
    if (SNAG_INSTANT && x.type === 'snag' && x.sev === 'High' && x.status === 'Open' && !x.snagNotified) {
      const pn = await pname(U, x.pid);
      await push(U, { title: '🛠️ High-severity snag', body: `${x.title || 'New snag'}${pn ? ' · ' + pn : ''}`, tag: 'snag-' + d.id });
      await d.ref.update({ snagNotified: true });
    }
    if (x.type === 'expense' && x.pid) pids.add(x.pid);
  }
  for (const pid of pids) await checkBudget(U, pid);
}

async function main() {
  const now = Date.now(), ist = istStr(now), today = ist.slice(0, 10), mod = +ist.slice(11, 13) * 60 + +ist.slice(14, 16);
  mark('reading devices');
  const snap = await db.collectionGroup('devices').get(), users = new Map();
  snap.docs.forEach(d => {
    const uid = d.ref.parent.parent.id, t = d.data().token;
    if (!t) return;
    if (!users.has(uid)) users.set(uid, { uid, devs: [], pn: new Map() });
    users.get(uid).devs.push({ token: t, ref: d.ref });
  });
  console.log('devices found:', snap.size, '| users:', users.size);
  if (process.env.TEST === 'true') {
    for (const U of users.values()) await push(U, { title: '✅ BuildSpace test', body: 'Background notifications are working.', tag: 'test' });
    console.log('test sent'); return;
  }
  if (process.env.PREVIEW === 'true') {
    for (const U of users.values()) await tomorrow(U, now, '🌇 Tomorrow’s schedule (test)');
    console.log('preview sent'); return;
  }
  for (const U of users.values()) {
    try {
      mark('user ' + U.uid + ': state');
      const sref = db.doc(`users/${U.uid}/meta/notify`), st = (await sref.get()).data() || {}, upd = { lastTs: now };
      mark('instant');
      if (st.lastTs) await instant(U, st, now);
      mark('reminders');
      await reminders(U, now);
      mark('slots');
      for (const [k, start] of SLOTS) {
        if (mod >= start && mod < start + SLOT_WINDOW && st[k] !== today) {
          upd[k] = today;
          mark('slot ' + k);
          if (k === 'digest') await digest(U, now);
          else await tomorrow(U, now, k === 't18' ? '🌇 Tomorrow’s schedule' : '🌙 Tomorrow — final check');
        }
      }
      mark('saving state');
      await sref.set(upd, { merge: true });
    } catch (e) { console.error('user', U.uid, e.message || e); }
  }
  console.log('done', users.size, 'user(s)', ist);
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });