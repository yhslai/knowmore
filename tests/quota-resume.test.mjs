import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import ts from 'typescript';

// Compile just the feature, outside the auto-discovered extensions directory.
// No Pi startup, auth loading, network, or provider requests.
const build = mkdtempSync(join(tmpdir(), 'knowmore-quota-test-'));
const source = fileURLToPath(new URL('../extensions/knowmore/', import.meta.url));
writeFileSync(join(build, 'package.json'), '{"type":"module"}');
for (const name of ['quota-wait', 'quota-awake', 'quota-resume']) {
  const result = ts.transpileModule(readFileSync(join(source, `${name}.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  writeFileSync(join(build, `${name}.js`), result.outputText);
}
copyFileSync(join(source, 'quota-keep-awake.ps1'), join(build, 'quota-keep-awake.ps1'));
after(() => rmSync(build, { recursive: true, force: true }));
const { quotaReset, QuotaWait, BUFFER_MS, FALLBACK_MS } = await import(pathToFileURL(join(build, 'quota-wait.js')));
const { registerQuotaResume } = await import(pathToFileURL(join(build, 'quota-resume.js')));
const { acquireQuotaAwake } = await import(pathToFileURL(join(build, 'quota-awake.js')));
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(options = {}) {
  let clock = Date.now();
  const handlers = new Map(), commands = new Map(), timers = new Set();
  const notices = [], sends = [], leases = [];
  let terminal;
  const context = {
    hasUI: true, model: { provider: 'openai-codex', id: 'fake' },
    sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' },
    isIdle: () => true, hasPendingMessages: () => false,
    ui: {
      setStatus() {}, notify: (...args) => notices.push(args),
      onTerminalInput(fn) { terminal = fn; return () => { terminal = undefined; }; },
    },
  };
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(...args) { assert.ok(leases.every(l => l.released)); sends.push(args); },
  };
  const wait = registerQuotaResume(pi, {
    now: () => clock,
    every(fn) { timers.add(fn); return () => timers.delete(fn); },
    acquire() {
      const lost = deferred();
      const lease = {
        ready: options.ready ?? Promise.resolve(), lost: lost.promise, released: false,
        async release() { if (options.release) await options.release; lease.released = true; },
        lose: lost.resolve,
      };
      leases.push(lease); return lease;
    },
  });
  async function emit(name, data = {}) { let result; for (const h of handlers.get(name) ?? []) result = await h(data, context); return result; }
  const error = (message = 'You have hit your ChatGPT usage limit. Try again in ~300 min.', stopReason = 'error') => ({
    role: 'assistant', provider: 'openai-codex', stopReason, errorMessage: message,
  });
  return { wait, context, emit, sends, notices, leases, timers, error,
    async limit(message) { await emit('agent_end', { messages: [error(message)] }); await emit('agent_settled', { aborted: false }); },
    async tick(time = clock) { clock = time; for (const fn of [...timers]) fn(); await flush(); },
    key(data) { return terminal?.(data); },
    command(args) { return commands.get('km-quota-wait').handler(args, context); },
  };
}

test('quota parsing: rounded estimate, epoch, units, fallback; excludes unrelated errors', () => {
  const now = 1_800_000_000_000;
  assert.equal(quotaReset('You have hit your ChatGPT usage limit. Try again in ~300 min.', now), now + 18_000_000 + BUFFER_MS);
  assert.equal(quotaReset('{"code":"usage_limit_reached","resets_at":1800000300}', now), now + 300_000 + BUFFER_MS);
  assert.equal(quotaReset('usage_limit_reached resets_at: 1800000300000', now), now + 300_000 + BUFFER_MS);
  assert.equal(quotaReset('Codex usage limit. Try again in 2 hours', now), now + 7_200_000 + BUFFER_MS);
  assert.equal(quotaReset('ChatGPT usage limit. Try again in 0 seconds', now), now + BUFFER_MS);
  assert.equal(quotaReset('usage_limit_reached', now), now + FALLBACK_MS + BUFFER_MS);
  for (const message of ['429 rate_limit_exceeded', 'insufficient_quota', '401 unauthorized', 'billing limit', 'network error']) assert.equal(quotaReset(message, now), undefined);
});

test('only starts after settlement; releases BEFORE exactly one continuation; no blocker during job or after success', async () => {
  const f = fixture();
  await f.emit('agent_end', { messages: [f.error()] });
  assert.equal(f.leases.length, 0);
  await f.emit('agent_settled', { aborted: false });
  assert.equal(f.leases.length, 1);
  await f.tick(f.wait.deadline - 1); assert.equal(f.sends.length, 0);
  await f.tick(f.wait.deadline); assert.equal(f.sends.length, 1);
  assert.equal(f.wait.deadline, undefined); assert.equal(f.timers.size, 0);
  assert.ok(f.leases[0].released);
  await f.tick(Date.now() + FALLBACK_MS * 2); assert.equal(f.sends.length, 1);
  await f.emit('agent_end', { messages: [{ role: 'assistant', provider: 'openai-codex', stopReason: 'stop' }] });
  await f.emit('agent_settled', { aborted: false }); assert.equal(f.leases.length, 1);
});

for (const event of ['input', 'before_agent_start', 'model_select', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact', 'session_shutdown']) {
  test(`${event} cancels timer and releases sleep blocker`, async () => {
    const f = fixture(); await f.limit(); const deadline = f.wait.deadline;
    await f.emit(event); assert.ok(f.leases[0].released); assert.equal(f.wait.deadline, undefined);
    assert.equal(f.timers.size, 0); await f.tick(deadline); assert.equal(f.sends.length, 0);
  });
}

test('Escape, cancel command, off/on, and aborted settlement', async () => {
  const f = fixture(); await f.limit(); assert.deepEqual(f.key('\x1b'), { consume: true }); await flush();
  assert.ok(f.leases[0].released); assert.equal(f.wait.deadline, undefined);
  await f.limit(); await f.command('cancel'); assert.ok(f.leases[1].released);
  await f.command('off'); await f.limit(); assert.equal(f.leases.length, 2);
  await f.command('on'); await f.limit(); assert.equal(f.leases.length, 3);
  await f.emit('agent_settled', { aborted: true }); assert.ok(f.leases[2].released);
  await f.emit('agent_end', { messages: [f.error()] }); await f.emit('agent_settled', { aborted: true });
  assert.equal(f.leases.length, 3);
});

test('stale context, busy agent, queued messages, and model change never resume', async () => {
  for (const mutate of [
    f => { f.context.isIdle = () => false; },
    f => { f.context.hasPendingMessages = () => true; },
    f => { f.context.sessionManager.getLeafId = () => 'different'; },
    f => { f.context.sessionManager.getSessionId = () => 'different'; },
    f => { f.context.model.id = 'different'; },
  ]) {
    const f = fixture(); await f.limit(); const deadline = f.wait.deadline; mutate(f); await f.tick(deadline);
    assert.ok(f.leases[0].released); assert.equal(f.sends.length, 0);
  }
});

test('native retries, non-quota errors, successful responses, and print mode do not start a wait', async () => {
  const f = fixture();
  await f.emit('agent_end', { messages: [f.error()] });
  await f.emit('agent_start');
  await f.emit('agent_end', { messages: [f.error('network error')] });
  await f.emit('agent_settled', { aborted: false }); assert.equal(f.leases.length, 0);
  f.context.hasUI = false; await f.limit(); assert.equal(f.leases.length, 0);
});

test('structured reset takes priority and is scoped to the request', async () => {
  const f = fixture(); const reset = Math.floor(Date.now() / 1000) + 100;
  await f.emit('provider_stream_event', { provider: 'openai-codex', data: { error: { code: 'usage_limit_reached', resets_at: reset } } });
  await f.limit('Provider rejected this request'); assert.equal(f.wait.deadline, reset * 1000 + BUFFER_MS);
  await f.command('cancel');
  await f.emit('agent_start'); await f.limit(); assert.ok(f.wait.deadline > reset * 1000 + BUFFER_MS);
  await f.command('cancel');
});

test('cancellation during helper startup or release cannot race into resume', async () => {
  const ready = deferred(), f = fixture({ ready: ready.promise });
  const starting = f.limit(); await flush(); await f.command('cancel'); ready.resolve(); await starting;
  assert.ok(f.leases[0].released); assert.equal(f.wait.deadline, undefined);
  const release = deferred(), g = fixture({ release: release.promise });
  await g.limit(); await g.tick(g.wait.deadline); // completion is awaiting release
  const cancel = g.command('cancel'); release.resolve(); await cancel; await flush();
  assert.equal(g.sends.length, 0); assert.ok(g.leases[0].released);
});

test('helper startup failure and unexpected exit cancel safely', async () => {
  const ready = deferred(), f = fixture({ ready: ready.promise });
  const starting = f.limit(); await flush(); ready.reject(new Error('fake failure')); await starting;
  assert.ok(f.leases[0].released); assert.equal(f.wait.deadline, undefined);
  const g = fixture(); await g.limit(); g.leases[0].lose(); await flush();
  assert.ok(g.leases[0].released); assert.equal(g.wait.deadline, undefined); assert.equal(g.sends.length, 0);
});

test('wait replacement is single-owner; cache warming suppressed only while waiting', async () => {
  const f = fixture();
  assert.equal(await f.emit('cache_warming_decision'), undefined);
  await f.limit(); await f.limit();
  assert.ok(f.leases[0].released); assert.equal(f.timers.size, 1);
  assert.deepEqual(await f.emit('cache_warming_decision'), { action: 'stop' });
  await f.command('cancel'); assert.ok(f.leases[1].released);
  assert.equal(await f.emit('cache_warming_decision'), undefined);
});

test('acquisition and resume exceptions do not leak the lease', async () => {
  let released = false;
  const base = { now: () => 100, every: () => () => {}, status() {}, notify() {} };
  const broken = new QuotaWait({ ...base, acquire() { throw new Error('fake'); } });
  await broken.start(100, () => true, () => assert.fail()); assert.equal(broken.deadline, undefined);
  const wait = new QuotaWait({ ...base, acquire: () => ({ ready: Promise.resolve(), async release() { released = true; } }) });
  await wait.start(100, () => true, () => { throw new Error('fake send failure'); });
  assert.ok(released); assert.equal(wait.deadline, undefined);
});

test('real Windows helper acquires and releases idempotently (offline)', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const lease = acquireQuotaAwake(Date.now() + 120_000);
  try { await lease.ready; } finally { await lease.release(); await lease.release(); }
});

test('real helper exits when its parent is forcibly terminated', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const script = `
    import { spawn } from 'node:child_process';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(join(build, 'quota-keep-awake.ps1'))}, '-DeadlineMilliseconds', String(Date.now() + 120000)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) process.stdout.write(String(child.pid) + '\\n'); });
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let helperPid;
  const timeout = setTimeout(() => parent.kill(), 10_000);
  try {
    const [data] = await once(parent.stdout, 'data');
    helperPid = Number(String(data).trim()); assert.ok(helperPid > 0);
    const closed = once(parent, 'close'); parent.kill(); await closed;
    let alive = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(helperPid, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(alive, false, 'sleep-blocker helper outlived its crashed parent');
  } finally {
    clearTimeout(timeout); parent.kill();
    if (helperPid) { try { process.kill(helperPid); } catch {} }
  }
});

test('real helper releases on stdin EOF, deadline expiry, and missing heartbeats', { skip: process.platform !== 'win32', timeout: 35_000 }, async () => {
  async function run(mode) {
    const started = Date.now();
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(build, 'quota-keep-awake.ps1'), '-DeadlineMilliseconds', String(Date.now() + (mode === 'deadline' ? 2500 : 120_000))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(helper, 'close');
    const kill = setTimeout(() => helper.kill(), 28_000);
    let output = '', errors = '';
    helper.stderr.on('data', chunk => { errors += chunk; });
    try {
      for await (const chunk of helper.stdout) {
        output += chunk;
        if (output.includes('READY') && mode === 'eof') helper.stdin.end();
      }
      const [code] = await closed;
      assert.equal(code, 0, `${mode}: ${errors}`); assert.match(output, /READY/);
      const elapsed = Date.now() - started;
      if (mode === 'heartbeat') assert.ok(elapsed >= 19_000, 'helper did not hold until heartbeat timeout');
      if (mode === 'deadline') assert.ok(elapsed >= 2300 && elapsed < 8000, `deadline release took ${elapsed} ms`);
    } finally { clearTimeout(kill); helper.kill(); }
  }
  await Promise.all(['eof', 'deadline', 'heartbeat'].map(run));
});
