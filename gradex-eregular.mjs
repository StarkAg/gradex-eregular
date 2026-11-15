#!/usr/bin/env node
// GradeX E-Regular — laptop submitter for SRM E-Curricula ("e-regular").
//
// WHY THIS EXISTS
// SRM's e-Curricula portal (dld.srmist.edu.in) blocks GradeX's servers by IP, so
// the website/app can only submit from a phone on the student's own network. This
// is the same thing for a laptop: your computer makes the SRM calls, GradeX's
// server does all the solving and bookkeeping. Nothing about SRM is stored here;
// your password and the 6-digit authenticator codes go straight to SRM for one
// call each and are never written to disk.
//
// WHAT IT DOES, end to end:
//   sign in to e-Curricula  ->  list your enrolled subjects  ->  for the unit you
//   pick: generate the solved worksheets on GradeX, submit their answer links,
//   then auto-complete the in-portal MCQ / skill questions.
//
// It is a "device-net relay": GradeX answers each step with { deviceNeed: [...] }
// (the SRM requests it needs made), this script makes them from your machine and
// posts the results back, until GradeX returns the real answer. Mirrors the phone
// app's src/lib/deviceNet.js.
//
// REQUIREMENTS: Node 18+ (uses built-in fetch). No npm install needed.
// RUN:  npx gradex-eregular        (or: node gradex-eregular.mjs)
//
// Everything can also be passed as a flag or environment variable, so it runs
// unattended / scripted:
//   npx gradex-eregular --ra RA23... --name "Full Name" --course 21ABC --units 1-2 --portal
//   GRADEX_TOKEN=ey... npx gradex-eregular --ra RA23... --name "..." --units all
// Flags: --token --base --ra --name --course --units --portal/--no-portal -y/--yes
//        -h/--help  -v/--version. Env: GRADEX_TOKEN, GRADEX_BASE.
// The SRM password and the 6-digit codes are always asked interactively and are
// never read from a flag, a file or the environment.

import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

// ---- config ----------------------------------------------------------------
const VERSION = '1.0.0';
const DEFAULT_BASE = 'https://gradex.bond';
const ALLOWED_HOSTS = new Set(['sp.srmist.edu.in', 'dld.srmist.edu.in']);
const SKIPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
const CONCURRENCY = 4;
const REQ_TIMEOUT_MS = 25000;
// Writes reach the relay one per round; a whole unit is many SRM calls.
const ACTION_ROUNDS = { 'srm-login': 8, 'srm-login-code': 8, 'my-courses': 8, 'submit-links': 60, 'portal-complete': 700 };
const RA_RE = /^[A-Za-z]{2}\d{13,15}$/; // RA2311... style

let BASE = DEFAULT_BASE;
let TOKEN = '';

// ---- CLI args ---------------------------------------------------------------
const ARGS = (() => {
  const a = { _: [] };
  const argv = process.argv.slice(2);
  const alias = { h: 'help', v: 'version', y: 'yes' };
  for (let i = 0; i < argv.length; i += 1) {
    let t = argv[i];
    if (t === '--') { a._.push(...argv.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      let key = t.slice(2); let val;
      const eq = key.indexOf('=');
      if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      if (key.startsWith('no-')) { a[key.slice(3)] = false; continue; }
      if (val === undefined) {
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) val = argv[++i];
        else val = true;
      }
      a[key] = val;
    } else if (t.startsWith('-') && t.length > 1) {
      for (const ch of t.slice(1)) a[alias[ch] || ch] = true;
    } else a._.push(t);
  }
  return a;
})();

// A GradeX token can arrive wrapped in quotes or with a leading "Bearer " — the
// two shapes people most often paste by accident. Strip them.
function cleanToken(s) {
  let t = String(s == null ? '' : s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  t = t.replace(/^Bearer\s+/i, '').trim();
  return t;
}

// ---- tiny prompt helpers ----------------------------------------------------
const rl = readline.createInterface({ input, output });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
async function askHidden(q) {
  // Hide typed characters (password). Falls back to visible if not a TTY.
  if (!output.isTTY) return ask(q);
  return new Promise((res) => {
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') return;
      output.clearLine(0); readline.cursorTo(output, 0);
      output.write(q + '*'.repeat(rl.line.length));
    };
    output.write(q);
    input.on('data', onData);
    rl.question('', (a) => { input.removeListener('data', onData); output.write('\n'); res(a.trim()); });
  });
}
const log = (...a) => console.log(...a);
const err = (...a) => console.error(...a);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- GradeX API -------------------------------------------------------------
function apiUrl(action, extra = {}) {
  const u = new URL(`${BASE}/api/e-curricula`);
  u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
async function apiPost(action, body, { relay = false, extraQuery = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  if (relay) headers['X-GradeX-Device-Net'] = '1';
  const res = await fetch(apiUrl(action, extraQuery), { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text, res };
}
async function apiGet(action, extraQuery = {}) {
  const res = await fetch(apiUrl(action, extraQuery), { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
}

// ---- SRM request runner (the "device") -------------------------------------
async function runSrmRequest(req) {
  try {
    let host = '';
    try { const u = new URL(req.url); host = u.protocol === 'https:' ? u.hostname.toLowerCase() : ''; } catch { host = ''; }
    if (!ALLOWED_HOSTS.has(host)) return { id: req.id, error: 'Only https requests to SRM are allowed.' };
    const method = String(req.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!SKIPPED_HEADERS.has(k.toLowerCase()) && v != null) headers[k] = String(v);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let out;
    try {
      out = await fetch(req.url, {
        method, headers,
        body: method !== 'GET' && req.body ? req.body : undefined,
        redirect: 'manual', // GradeX follows redirects itself, step by step
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
    const outHeaders = {};
    for (const [k, v] of out.headers) { if (k.toLowerCase() !== 'set-cookie') outHeaders[k.toLowerCase()] = String(v); }
    const setCookies = typeof out.headers.getSetCookie === 'function' ? out.headers.getSetCookie() : [];
    const body = await out.text();
    return { id: req.id, status: out.status || 0, headers: outHeaders, setCookies, body };
  } catch (e) {
    return { id: req.id, error: String(e?.message || e || 'request failed') };
  }
}
async function runAll(requests) {
  const results = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) { const i = next; next += 1; results[i] = await runSrmRequest(requests[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, worker));
  return results;
}

function newRunId() {
  try { if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, ''); } catch { /* noop */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// The relay loop — identical shape to the phone app's deviceNet.relay().
// Returns { status, json, text } of the real answer, or null if it couldn't finish.
async function relay(action, original, { extraQuery = {} } = {}) {
  const maxRounds = ACTION_ROUNDS[action] || 8;
  const answers = new Map();
  const run = newRunId();
  let unsent = [];
  let resendAll = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const body = { ...original, deviceRun: run, deviceResponses: resendAll ? [...answers.values()] : unsent };
    const { status, json, text, res } = await apiPost(action, body, { relay: true, extraQuery });
    const need = Array.isArray(json?.deviceNeed) ? json.deviceNeed : null;
    if (!need) return { status, json, text, res };
    const valid = need.filter((r) => r && typeof r.id === 'string');
    const fresh = valid.filter((r) => !answers.has(r.id));
    const forgotten = valid.length > fresh.length;
    if (fresh.length === 0) { if (resendAll) break; resendAll = true; unsent = []; continue; }
    resendAll = forgotten;
    unsent = await runAll(fresh);
    unsent.forEach((a) => answers.set(a.id, a));
  }
  return null;
}

// ---- OTP (authenticator code) helper ---------------------------------------
// SRM wants a fresh 6-digit code per write, reusable only within its ~30s window.
// We cache the last typed code and reuse it while it is young; on a rejection we
// ask for a new one.
let lastCode = '';
let lastCodeAt = 0;
async function getCode({ forceNew = false } = {}) {
  const ageMs = Date.now() - lastCodeAt;
  if (!forceNew && lastCode && ageMs < 20000) return lastCode;
  if (forceNew && lastCode && ageMs < 30000) {
    log(dim('   (wait for your authenticator to roll to the NEXT code before typing it)'));
  }
  let code = '';
  while (!/^\d{6}$/.test(code)) {
    code = (await ask(bold('   SRM 6-digit authenticator code: '))).replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) log(red('   Need exactly 6 digits.'));
  }
  lastCode = code; lastCodeAt = Date.now();
  return code;
}

// ---- flow -------------------------------------------------------------------
async function signIn() {
  log(bold('\n== Sign in to e-Curricula =='));
  const password = await askHidden('   SRM password: ');
  log(dim('   signing in via your network…'));
  let r = await relay('srm-login', { password });
  if (!r) throw new Error('Could not reach SRM to sign in (relay did not finish). Check your internet and try again.');
  let j = r.json || {};
  if (j.ok) { log(green('   signed in.')); return; }
  if (j.needCode) {
    // SRM asked for the authenticator code.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = await getCode({ forceNew: attempt > 0 });
      log(dim('   verifying code…'));
      r = await relay('srm-login-code', { code });
      j = (r && r.json) || {};
      if (j.ok) { log(green('   signed in.')); return; }
      log(red(`   code rejected${j.reason ? ` (${j.reason})` : ''}.`));
    }
    throw new Error('Authenticator code kept being rejected. Start over.');
  }
  throw new Error(`Sign-in failed: ${j.reason || r.text || 'unknown error'}`);
}

async function listCourses() {
  log(dim('\n   loading your enrolled subjects…'));
  const r = await relay('my-courses', {});
  const j = (r && r.json) || {};
  if (!j.ok || !Array.isArray(j.courses) || j.courses.length === 0) {
    throw new Error(`Could not list subjects: ${j.reason || 'portal unavailable'}.`);
  }
  if (j.srmEmailRequired) {
    log(red('\n   ⚠ SRM is holding your account at its "verify your email" gate.'));
    log(red('     Submitting will be refused until you verify an email in e-Curricula → My Profile.'));
  }
  return j.courses; // [{code,name,semester,batchId,faculty}]
}

async function generateUnit(course, unit, student) {
  log(dim(`\n   generating solved worksheets for ${course} unit ${unit} on GradeX…`));
  const { status, json } = await apiPost('generate-unit-docs',
    { unit, name: student.name, ra: student.ra, date: student.date },
    { extraQuery: { course } });
  if (status === 402) throw new Error(`Unit ${unit} needs payment (reason: ${json?.reason}). Units 1–2 are free; founder's-gift makes every unit free.`);
  if (status === 401) throw new Error('GradeX token rejected (sign-in-required). Paste a fresh token.');
  if (!json?.ok || !json.jobId) throw new Error(`Generate failed: ${json?.reason || json?.error || status}`);
  // Poll the job.
  const jobId = json.jobId;
  let lastDone = -1;
  for (;;) {
    await sleep(1500);
    const { json: s } = await apiGet('unit-job-status', { jobId });
    if (!s?.ok) throw new Error(`Worksheet job failed: ${s?.error || 'job lost'}`);
    if (typeof s.done === 'number' && s.done !== lastDone) {
      lastDone = s.done;
      output.write(`\r   solving… ${s.done}/${s.total || '?'}   `);
    }
    if (s.status === 'done') {
      output.write('\n');
      const worksheets = (s.result && Array.isArray(s.result.worksheets)) ? s.result.worksheets : [];
      return worksheets;
    }
    if (s.status === 'error') { output.write('\n'); throw new Error(`Worksheet job error: ${s.reason || 'unknown'}`); }
  }
}

// Submit one unit's worksheet answer links, one per call (so an OTP re-prompt
// only affects the remaining links), matching the app's OneTapSubmit.
async function submitLinks(course, worksheets) {
  const links = worksheets
    .map((w) => ({ key: String(w.key || '').trim(), link: String(w.driveUrl || w.url || '').trim() }))
    .filter((l) => l.key && l.link);
  if (links.length === 0) { log(dim('   no worksheet links to submit for this unit.')); return { submitted: 0, total: 0 }; }
  const expectedKeys = links.map((l) => l.key);
  log(bold(`\n== Submitting ${links.length} worksheet answer link(s) ==`));
  log(dim('   SRM asks for a fresh authenticator code for these writes.'));

  let submitted = 0;
  for (let i = 0; i < links.length; i += 1) {
    const item = links[i];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const otp = await getCode({ forceNew: attempt > 0 });
      output.write(`   [${i + 1}/${links.length}] worksheet ${item.key}… `);
      const r = await relay('submit-links', { course, links: [item], expectedKeys, otp });
      const j = (r && r.json) || {};
      const st = r ? r.status : 0;
      if (st === 402 && j.reason === 'mark-required') {
        output.write(red('BLOCKED\n'));
        throw new Error('mark-required: this GradeX account is not a Mark member. Grant founder\'s-gift first (see README), then re-run.');
      }
      if (st === 401) { output.write(red('AUTH\n')); throw new Error('GradeX token rejected. Paste a fresh token.'); }
      if (j.reason === 'unit-already-complete') { output.write(green('already complete — unit done\n')); return { submitted, total: links.length, unitComplete: true }; }
      if (j.reason === 'srm-login-required') { output.write(red('session lost\n')); throw new Error('e-Curricula session expired. Re-run and sign in again.'); }
      if (j.reason === 'srm-email-required') { output.write(red('email gate\n')); throw new Error('SRM wants you to verify an email in e-Curricula → My Profile first.'); }
      if (st === 409 && j.reason === 'srm-otp-required') { output.write(dim('needs a new code\n')); continue; } // re-prompt, retry same item
      if (j.ok && j.submitted >= 1) { output.write(green('ok\n')); submitted += 1; break; }
      // Some other refusal (SRM message in results) — show and move on.
      const msg = (j.results && j.results[0] && j.results[0].msg) || j.reason || r?.text || 'refused';
      output.write(red(`refused (${msg})\n`));
      break;
    }
  }
  log(submitted === links.length ? green(`   all ${submitted} submitted.`) : red(`   ${submitted}/${links.length} submitted.`));
  return { submitted, total: links.length };
}

// Auto-complete the in-portal MCQ / skill questions for the course.
async function portalComplete(course, worksheets) {
  const links = worksheets
    .map((w) => ({ key: String(w.key || '').trim(), link: String(w.driveUrl || w.url || '').trim() }))
    .filter((l) => l.key && l.link);
  log(bold('\n== Auto-completing in-portal MCQ / skill questions =='));
  log(dim('   this scans the course\'s sessions and answers MCQ / match / fill-ups; it can take a while.'));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const otp = await getCode({ forceNew: attempt > 0 });
    log(dim('   working…'));
    const r = await relay('portal-complete', { course, links, otp });
    const j = (r && r.json) || {};
    const st = r ? r.status : 0;
    if (st === 402 && j.reason === 'mark-required') throw new Error('mark-required: grant founder\'s-gift first (see README).');
    if (st === 401) throw new Error('GradeX token rejected. Paste a fresh token.');
    if (j.reason === 'srm-login-required') throw new Error('e-Curricula session expired. Re-run.');
    if (j.reason === 'srm-email-required') throw new Error('SRM email-verify gate is blocking writes.');
    if (st === 409 && j.reason === 'srm-otp-required') { log(dim('   SRM wants a fresh code…')); continue; }
    if (j.ok) {
      const done = j.completed ?? j.done ?? '?';
      const total = j.total ?? '?';
      log(green(`   portal questions done: ${done}/${total}.`));
      if (j.needsMark) log(red('   (some units were locked behind Mark.)'));
      return;
    }
    log(red(`   portal-complete returned: ${j.reason || r?.text || st}`));
    return;
  }
  throw new Error('portal-complete kept asking for a new code. Try again.');
}

function parseUnits(spec, max = 5) {
  // "1", "1,3", "1-3", "all"
  const s = String(spec || '').trim().toLowerCase();
  if (s === 'all') return [1, 2, 3, 4, 5].slice(0, max);
  const out = new Set();
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b; n += 1) if (n >= 1 && n <= max) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

const HELP = `
GradeX E-Regular — submit SRM e-Curricula ("e-regular") from your own network.

Usage:
  npx gradex-eregular                 interactive (asks for everything)
  npx gradex-eregular --ra RA23... --name "Full Name" --units 1-2 --portal

Options:
  --token <t>     GradeX account token (or env GRADEX_TOKEN). Asked if omitted.
  --base <url>    GradeX base URL (or env GRADEX_BASE). Default ${DEFAULT_BASE}
  --ra <RA...>    Your SRM registration number.
  --name <name>   Your full name (printed on the worksheets).
  --course <code> Subject code to run (skips the subject picker).
  --units <spec>  Units: e.g. 1, 1-3, 1,3, or all.
  --portal        Also auto-complete the in-portal MCQ / skill questions.
  --no-portal     Skip the in-portal questions (no prompt).
  -y, --yes       Don't pause for confirmations; use defaults.
  -h, --help      Show this help.
  -v, --version   Show the version.

Your SRM password and the 6-digit authenticator codes are always typed
interactively — never read from a flag, a file or the environment.
`;

async function main() {
  if (ARGS.help) { log(HELP); rl.close(); return; }
  if (ARGS.version) { log(VERSION); rl.close(); return; }

  log(bold('\n GradeX E-Regular — SRM e-Curricula submitter'));
  log(dim(' Runs the submission from YOUR network. Password/codes go to SRM only, never saved.\n'));

  // Base URL: flag / env / default.
  const baseArg = (typeof ARGS.base === 'string' && ARGS.base) || process.env.GRADEX_BASE || '';
  if (baseArg) {
    BASE = /^https?:\/\//i.test(baseArg) ? baseArg.replace(/\/+$/, '') : `https://${baseArg.replace(/\/+$/, '')}`;
    try { new URL(BASE); } catch { log(red(`   "${BASE}" isn't a valid URL — using ${DEFAULT_BASE}`)); BASE = DEFAULT_BASE; }
  }

  // Token: flag / env / prompt. A GradeX token is a JWT-ish string: starts with
  // "ey", has dots, no spaces, and is long. People often paste it at the first
  // prompt (the base URL) instead of the token prompt — detect that and take it
  // as the token, so one wrong paste doesn't break the whole run.
  const looksLikeToken = (s) => /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/.test(s) || (!/\s/.test(s) && s.length > 60 && (s.match(/\./g) || []).length >= 2 && !/^https?:\/\//i.test(s));
  TOKEN = cleanToken((typeof ARGS.token === 'string' && ARGS.token) || process.env.GRADEX_TOKEN || '');
  if (!TOKEN && !baseArg) {
    const baseIn = (await ask(`GradeX base URL [${DEFAULT_BASE}] — just press Enter: `)).trim();
    if (looksLikeToken(baseIn)) {
      log(dim('   (that looks like your token — using it, keeping the default URL)'));
      BASE = DEFAULT_BASE; TOKEN = cleanToken(baseIn);
    } else {
      if (!baseIn) BASE = DEFAULT_BASE;
      else if (/^https?:\/\//i.test(baseIn)) BASE = baseIn.replace(/\/+$/, '');
      else BASE = `https://${baseIn.replace(/\/+$/, '')}`; // bare host like "gradex.bond"
      try { new URL(BASE); } catch { log(red(`   "${BASE}" isn't a valid URL — using ${DEFAULT_BASE}`)); BASE = DEFAULT_BASE; }
    }
  }
  if (!TOKEN) TOKEN = cleanToken(await askHidden('GradeX account token (from the website — see README): '));
  if (!TOKEN) { err(red('No token given.')); rl.close(); return; }
  if (/^https?:\/\//i.test(TOKEN)) { err(red('That looks like a URL, not a token. Get your token from the website (see README) and paste that.')); rl.close(); return; }

  let ra = String(ARGS.ra || '').trim().toUpperCase();
  if (ra && !RA_RE.test(ra)) { log(red(`"${ra}" does not look like an RA number — ask again.`)); ra = ''; }
  while (!RA_RE.test(ra)) {
    ra = (await ask('Your SRM registration number (e.g. RA23...): ')).trim().toUpperCase();
    if (!RA_RE.test(ra)) log(red('That does not look like an RA number.'));
  }
  const name = (typeof ARGS.name === 'string' && ARGS.name.trim()) || await ask('Your full name (printed on the worksheets): ');
  const student = { ra, name, date: new Date().toISOString().slice(0, 10) };

  try {
    await signIn();
    const courses = await listCourses();
    log(bold('\n== Your subjects =='));
    courses.forEach((c, i) => log(`  ${String(i + 1).padStart(2)}. ${c.code}  ${dim(c.name || '')}${c.semester ? dim(`  (sem ${c.semester})`) : ''}`));

    // Course: --course <code> (matched case-insensitively), else pick.
    let course;
    const courseArg = String(ARGS.course || '').trim().toUpperCase();
    if (courseArg) {
      const hit = courses.find((c) => String(c.code || '').toUpperCase() === courseArg);
      if (!hit) { err(red(`--course ${courseArg} is not one of your enrolled subjects.`)); rl.close(); return; }
      course = hit.code; log(dim(`   using --course ${course}`));
    } else {
      let pick = NaN;
      while (!(pick >= 1 && pick <= courses.length)) pick = Number(await ask('\nPick a subject number: '));
      course = courses[pick - 1].code;
    }

    const unitSpec = (typeof ARGS.units === 'string' && ARGS.units) || await ask('Which unit(s)? (e.g. 1, or 1-3, or "all"): ');
    const units = parseUnits(unitSpec);
    if (units.length === 0) { err(red('No valid units.')); rl.close(); return; }

    const doPortal = typeof ARGS.portal === 'boolean' ? ARGS.portal
      : ARGS.yes ? false
      : /^y/i.test(await ask('Also auto-complete in-portal MCQ / skill questions after each unit? [y/N]: ') || 'n');

    for (const unit of units) {
      log(bold(`\n──────── ${course}  ·  Unit ${unit} ────────`));
      const worksheets = await generateUnit(course, unit, student);
      const res = await submitLinks(course, worksheets);
      if (doPortal && !res.unitComplete) await portalComplete(course, worksheets);
      else if (doPortal && res.unitComplete) log(dim('   unit already complete — skipping portal step.'));
    }
    log(green(bold('\n✓ Done.')));
  } catch (e) {
    err(red(`\n✗ ${e.message || e}`));
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
