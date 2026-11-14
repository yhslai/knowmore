import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const build = mkdtempSync(join(tmpdir(), 'knowmore-quota-command-'));
const source = fileURLToPath(new URL('../extensions/knowmore/', import.meta.url));
writeFileSync(join(build, 'package.json'), '{"type":"module"}');
for (const name of ['quota-status', 'quota-command']) {
  writeFileSync(join(build, `${name}.js`), ts.transpileModule(readFileSync(join(source, `${name}.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
}
after(() => rmSync(build, { recursive: true, force: true }));
const { registerQuotaCommand } = await import(pathToFileURL(join(build, 'quota-command.js')));
const { codexHeaderQuotas, codexStreamQuota, codexUsageQuotas, formatCodexQuotas, formatOpenRouterQuota } = await import(pathToFileURL(join(build, 'quota-status.js')));
const now = 1_800_000_000_000;
const headers = {
  'X-Codex-Primary-Used-Percent': '25.5', 'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': '1800001000', 'x-codex-secondary-used-percent': '80',
  'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': '1800100000',
};
const keyData = { data: { limit: 20, limit_remaining: 12, limit_reset: 'monthly', usage: 100,
  usage_daily: 1, usage_weekly: 4, usage_monthly: 8, is_free_tier: false,
  label: 'DO_NOT_DISPLAY_LABEL', key: 'DO_NOT_DISPLAY_KEY',
} };
const codexData = { account_id: 'DO_NOT_DISPLAY_ACCOUNT', user_id: 'DO_NOT_DISPLAY_USER', plan_type: 'plus',
  rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 35, limit_window_seconds: 18000, reset_at: 1800001000 },
    secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: 1800100000 },
  },
  additional_rate_limits: [{ metered_feature: 'codex_premium', rate_limit: {
    primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 50 }, allowed: false, limit_reached: true,
  } }],
};
const flush = () => new Promise(setImmediate);
function fixture(provider = 'openai-codex', options = {}) {
  const events = new Map(), commands = new Map(), entries = [], notices = [], requests = [], statuses = [];
  let authCalls = 0;
  const ctx = {
    model: { provider, id: 'model-a', baseUrl: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://chatgpt.com/backend-api/codex' },
    sessionManager: { getSessionId: () => 'session-a' },
    modelRegistry: { async getApiKeyAndHeaders(model) { authCalls++; assert.equal(model, ctx.model); return { ok: true, apiKey: 'fake-active-key', headers: {} }; } },
    ui: { notify(...args) { notices.push(args); }, setStatus(...args) { statuses.push(args); } },
  };
  const pi = {
    on(event, callback) { const list = events.get(event) ?? []; list.push(callback); events.set(event, list); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage() { assert.fail('Quota reports must not enter model context or trigger turns'); },
  };
  registerQuotaCommand(pi, { now: () => now, timeoutMs: options.timeoutMs ?? 100,
    fetcher: async (...args) => { requests.push(args); return options.fetcher ? options.fetcher(...args) : new Response(JSON.stringify(keyData)); },
  });
  return { ctx, entries, notices, requests, statuses,
    get authCalls() { return authCalls; },
    async emit(name, value = {}) { for (const callback of events.get(name) ?? []) await callback(value, ctx); },
    run(args = '') { return commands.get('km-quota').handler(args, ctx); },
    report() { return entries.at(-1)?.data.text ?? ''; },
  };
}

test('Codex header parsing: 5-hour and weekly remaining, reset, age, no auth data retained', () => {
  const data = codexHeaderQuotas({ ...headers, Authorization: 'DO_NOT_RETAIN', 'set-cookie': 'DO_NOT_RETAIN' }, now);
  assert.equal(data[0].primary.used, 25.5);
  assert.equal(data[0].secondary.minutes, 10080);
  const report = formatCodexQuotas(data, now + 60_000);
  assert.match(report, /5-hour: 74.5% remaining/); assert.match(report, /weekly: 20% remaining/);
  assert.match(report, /60s ago/); assert.match(report, /cached/);
  assert.ok(!JSON.stringify(data).includes('DO_NOT_RETAIN'));
});

test('Codex zero/over-limit/malformed values, alternate buckets, and passed resets', () => {
  const data = codexHeaderQuotas({
    'x-codex-primary-used-percent': '0', 'x-codex-primary-reset-at': '1700000000',
    'x-premium-primary-used-percent': '120', 'x-bad-primary-used-percent': 'NaN',
    'x-empty-primary-used-percent': '', 'x-negative-primary-used-percent': '-1',
  }, now);
  assert.equal(data.length, 2);
  const report = formatCodexQuotas(data, now);
  assert.match(report, /100% remaining/); assert.match(report, /0% remaining/);
  assert.match(report, /reset passed; current quota unknown/);
  assert.match(formatCodexQuotas([], now), /unknown/);
});

test('Codex WebSocket/SSE codex.rate_limits payloads are allowlisted', () => {
  const data = codexStreamQuota({ type: 'codex.rate_limits', metered_limit_name: 'codex_premium',
    rate_limits: { primary: { used_percent: 70, window_minutes: 300, reset_at: 1800000010 } }, token: 'DO_NOT_RETAIN' }, now);
  assert.equal(data.id, 'codex-premium'); assert.equal(data.primary.used, 70);
  assert.ok(!JSON.stringify(data).includes('DO_NOT_RETAIN'));
  assert.equal(codexStreamQuota({ type: 'response.completed', rate_limits: {} }, now), undefined);
  assert.equal(codexStreamQuota({ type: 'codex.rate_limits', rate_limits: { primary: { used_percent: '10' } } }, now), undefined);
});

test('explicit Codex cached mode never resolves auth or performs a probe, and caches per model', async () => {
  const f = fixture(); await f.run('cached'); assert.match(f.report(), /unknown/);
  await f.emit('before_provider_request'); await f.emit('after_provider_response', { headers }); await f.run('cached');
  assert.match(f.report(), /74.5% remaining/);
  f.ctx.model.id = 'model-b'; await f.emit('model_select'); await f.run('cached'); assert.match(f.report(), /unknown/);
  await f.emit('provider_stream_event', { provider: 'openai-codex', model: 'model-b', data: {
    type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 90 } },
  } });
  await f.run('cached'); assert.match(f.report(), /10% remaining/);
  assert.equal(f.authCalls, 0); assert.equal(f.requests.length, 0);
  await f.emit('session_shutdown'); await f.run('cached'); assert.match(f.report(), /unknown/);
});

test('headers observed after a model switch still belong to the request model', async () => {
  const f = fixture(); await f.emit('before_provider_request');
  f.ctx.model = { ...f.ctx.model, id: 'model-b' }; await f.emit('model_select');
  await f.emit('after_provider_response', { headers }); await f.run('cached'); assert.match(f.report(), /unknown/);
  f.ctx.model.id = 'model-a'; await f.run('cached'); assert.match(f.report(), /74.5% remaining/);
});

test('cold-cache Codex command uses read-only usage endpoint, not model responses, and populates cache', async () => {
  const f = fixture('openai-codex', { fetcher: async () => new Response(JSON.stringify(codexData)) });
  await f.run(); assert.equal(f.authCalls, 1); assert.equal(f.requests.length, 1);
  const [url, init] = f.requests[0];
  assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage'); assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.Authorization, 'Bearer fake-active-key');
  assert.match(f.report(), /checked/); assert.doesNotMatch(f.report(), /not a live check/);
  assert.match(f.report(), /5-hour: 65% remaining/); assert.match(f.report(), /weekly: 20% remaining/);
  assert.match(f.report(), /Included usage currently blocked/);
  assert.doesNotMatch(JSON.stringify([f.entries, f.notices]), /fake-active-key|DO_NOT_DISPLAY/);
  await f.run('cached'); assert.equal(f.requests.length, 1); assert.match(f.report(), /cached observations/);
});

test('Codex usage parser converts window seconds, supports relative resets, and rejects absent/malformed windows', () => {
  const values = codexUsageQuotas(codexData, now);
  assert.equal(values[0].primary.minutes, 300); assert.equal(values[0].secondary.minutes, 10080);
  assert.equal(values[1].id, 'codex-premium'); assert.equal(values[1].primary.reset, now + 50_000);
  assert.doesNotMatch(JSON.stringify(values), /DO_NOT_DISPLAY/);
  for (const data of [null, {}, { rate_limit: null }, { rate_limit: { primary_window: { used_percent: '0' } } }]) assert.throws(() => codexUsageQuotas(data, now));
});

test('Codex forwards only resolved auth/account headers; credentials remain opaque', async () => {
  const f = fixture('openai-codex', { fetcher: async () => new Response(JSON.stringify(codexData)) });
  f.ctx.modelRegistry = { async getApiKeyAndHeaders() {
    return { ok: true, apiKey: 'unused-fake-key', headers: { authorization: 'Bearer opaque-fake-token',
      'chatgpt-account-id': 'fake-account', Cookie: 'DO_NOT_FORWARD', 'x-session-id': 'DO_NOT_FORWARD' } };
  } };
  await f.run();
  assert.deepEqual(f.requests[0][1].headers, { Authorization: 'Bearer opaque-fake-token', 'ChatGPT-Account-Id': 'fake-account', Accept: 'application/json' });
  assert.doesNotMatch(JSON.stringify([f.entries, f.notices]), /opaque-fake-token|fake-account|DO_NOT_FORWARD/);
  const legacy = fixture('openai-codex', { fetcher: async () => new Response(JSON.stringify(codexData)) });
  legacy.ctx.modelRegistry = { async getApiKey() { return 'opaque-legacy-token'; } };
  await legacy.run(); assert.match(legacy.report(), /65% remaining/);
});

test('Codex live failure is explicit, with labeled cache fallback only when present', async () => {
  const f = fixture('openai-codex', { fetcher: async () => new Response('DO_NOT_DISPLAY', { status: 403 }) });
  await f.run(); assert.equal(f.entries.length, 0); assert.match(JSON.stringify(f.notices), /HTTP 403/);
  await f.emit('before_provider_request'); await f.emit('after_provider_response', { headers });
  await f.run(); assert.match(f.report(), /Live lookup failed/); assert.match(f.report(), /cached observations/);
  assert.doesNotMatch(JSON.stringify([f.entries, f.notices]), /DO_NOT_DISPLAY/);
  const unauthorized = fixture('openai-codex', { fetcher: async () => new Response('', { status: 401 }) });
  await unauthorized.run(); assert.match(JSON.stringify(unauthorized.notices), /login openai-codex/);
});

test('Codex custom model and resolved auth gateways never receive or leak credentials', async () => {
  const f = fixture('openai-codex'); f.ctx.model.baseUrl = 'https://proxy.example/backend-api';
  await f.run(); assert.equal(f.authCalls, 0); assert.equal(f.requests.length, 0);
  const g = fixture('openai-codex');
  g.ctx.modelRegistry = { async getApiKeyAndHeaders() { return { ok: true, apiKey: 'fake', baseUrl: 'https://proxy.example/backend-api' }; } };
  await g.run(); assert.equal(g.requests.length, 0);
});

test('OpenRouter cached option is rejected instead of falling back to another provider cache', async () => {
  const f = fixture('openrouter'); await f.run('cached'); assert.equal(f.requests.length, 0);
  assert.match(JSON.stringify(f.notices), /only available for Codex/);
});

test('OpenRouter selects active model auth and GET /key only; no secrets in output/context', async () => {
  const f = fixture('openrouter'); await f.run();
  assert.equal(f.authCalls, 1); assert.equal(f.requests.length, 1);
  const [url, init] = f.requests[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/key'); assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, 'Bearer fake-active-key'); assert.equal(init.redirect, 'error');
  assert.match(f.report(), /\$12.0000 \(60%\)/); assert.match(f.report(), /Lifetime spend: \$100.0000/);
  assert.match(f.report(), /not prepaid account balance/);
  const output = JSON.stringify([f.entries, f.notices]);
  for (const secret of ['fake-active-key', 'DO_NOT_DISPLAY_LABEL', 'DO_NOT_DISPLAY_KEY']) assert.ok(!output.includes(secret));
  assert.deepEqual(f.statuses.at(-1), ['knowmore.quota-check', undefined]);
});

test('uncapped and zero-limit keys do not imply unlimited credit; unavailable remaining is unknown', () => {
  assert.match(formatOpenRouterQuota({ data: { limit: null, limit_remaining: null } }, now), /none configured \(not unlimited account credit\)/);
  assert.match(formatOpenRouterQuota({ data: { limit: 0, limit_remaining: 0 } }, now), /remaining: \$0.0000/);
  assert.match(formatOpenRouterQuota({ data: { limit: 20, usage: 500 } }, now), /remaining: unknown/);
  assert.throws(() => formatOpenRouterQuota({ nonsense: true }, now));
  assert.throws(() => formatOpenRouterQuota({ data: {} }, now));
});

test('OpenRouter enforced budget and free-model daily quota are reported separately', () => {
  const report = formatOpenRouterQuota({ data: { limit: null,
    effective_budget: { remaining_usd: 3, resets_at: '2027-03-01T00:00:00Z' },
    free_model_daily_requests: { remaining: 12, limit: 50 },
  } }, now);
  assert.match(report, /Effective enforced budget remaining: \$3.0000/);
  assert.match(report, /Free-model requests today: 12 \/ 50 remaining/);
});

test('resolved Authorization override and legacy per-model auth are supported', async () => {
  const f = fixture('openrouter');
  f.ctx.modelRegistry = { async getApiKeyAndHeaders() { return { ok: true, apiKey: 'wrong-fake-key', headers: { authorization: 'Bearer fake-header-key' } }; } };
  await f.run(); assert.equal(f.requests[0][1].headers.Authorization, 'Bearer fake-header-key');
  const g = fixture('openrouter');
  g.ctx.modelRegistry = { async getApiKey(model) { assert.equal(model.id, 'model-a'); return 'fake-legacy-key'; } };
  await g.run(); assert.equal(g.requests[0][1].headers.Authorization, 'Bearer fake-legacy-key');
});

test('unsupported provider, arguments, no model, and missing credentials never fetch', async () => {
  for (const mode of ['provider', 'args', 'model', 'missing', 'disabled-auth']) {
    const f = fixture(mode === 'provider' ? 'anthropic' : 'openrouter');
    if (mode === 'model') f.ctx.model = undefined;
    if (mode === 'missing') f.ctx.modelRegistry = { async getApiKeyAndHeaders() { return { ok: true }; } };
    if (mode === 'disabled-auth') f.ctx.modelRegistry = { async getApiKeyAndHeaders() { return { ok: true, apiKey: 'unused', headers: { Authorization: null } }; } };
    await f.run(mode === 'args' ? 'refresh' : ''); assert.equal(f.requests.length, 0); assert.equal(f.entries.length, 0);
  }
});

test('custom gateway model or resolved auth base URLs are rejected without sending credentials', async () => {
  for (const baseUrl of ['https://proxy.example/api/v1', 'http://openrouter.ai/api/v1', 'https://openrouter.ai.evil.test/api/v1', 'https://openrouter.ai/api/v1?key=fake']) {
    const f = fixture('openrouter'); f.ctx.model.baseUrl = baseUrl; await f.run();
    assert.equal(f.authCalls, 0); assert.equal(f.requests.length, 0);
  }
  const f = fixture('openrouter'); f.ctx.modelRegistry = { async getApiKeyAndHeaders() { return { ok: true, apiKey: 'fake', baseUrl: 'https://proxy.example/api/v1' }; } };
  await f.run(); assert.equal(f.requests.length, 0);
});

test('HTTP, malformed response, network, and auth failures never expose raw messages/body', async () => {
  for (const provider of ['openai-codex', 'openrouter']) for (const mode of ['http', 'json', 'network', 'auth']) {
    const f = fixture(provider, { fetcher: async () => {
      if (mode === 'http') return new Response('SENSITIVE_BODY', { status: 401 });
      if (mode === 'json') return new Response('SENSITIVE_BODY');
      if (mode === 'network') throw new Error('SENSITIVE_NETWORK');
      return new Response('{}');
    } });
    if (mode === 'auth') f.ctx.modelRegistry = { async getApiKeyAndHeaders() { throw new Error('SENSITIVE_AUTH'); } };
    await f.run(); assert.equal(f.entries.length, 0);
    assert.ok(!JSON.stringify(f.notices).includes('SENSITIVE'));
    if (mode === 'http') assert.match(JSON.stringify(f.notices), /HTTP 401/);
    assert.deepEqual(f.statuses.at(-1), ['knowmore.quota-check', undefined]);
  }
});

test('timeouts bound both stuck credentials and stuck metadata fetches', async () => {
  for (const provider of ['openai-codex', 'openrouter']) for (const mode of ['auth', 'fetch']) {
    const f = fixture(provider, { timeoutMs: 10, fetcher: () => new Promise(() => {}) });
    if (mode === 'auth') f.ctx.modelRegistry = { getApiKeyAndHeaders: () => new Promise(() => {}) };
    await f.run(); assert.match(JSON.stringify(f.notices), /timed out/); assert.equal(f.entries.length, 0);
    assert.deepEqual(f.statuses.at(-1), ['knowmore.quota-check', undefined]);
  }
});

test('model switch and shutdown abort pending checks and suppress stale reports', async () => {
  for (const provider of ['openai-codex', 'openrouter']) for (const event of ['model_select', 'session_shutdown']) {
    const f = fixture(provider, { fetcher: () => new Promise(() => {}) });
    const running = f.run(); await flush(); await f.emit(event); await running;
    assert.ok(f.requests[0][1].signal.aborted); assert.equal(f.entries.length, 0);
    assert.deepEqual(f.statuses.at(-1), ['knowmore.quota-check', undefined]);
  }
});
