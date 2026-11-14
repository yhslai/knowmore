// Quota-only data: never retain request headers, credentials, or raw provider payloads.
export interface QuotaWindow { used: number; minutes?: number; reset?: number }
export interface CodexQuota { id: string; primary?: QuotaWindow; secondary?: QuotaWindow; observed: number; allowed?: boolean; reached?: boolean }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const headerNumber = (value: string | undefined) => value?.trim() ? number(Number(value)) : undefined;
const epoch = (value: unknown) => {
  const seconds = number(value);
  return seconds !== undefined && seconds > 0 && seconds < 8.64e12 ? seconds * 1000 : undefined;
};
function window(used: unknown, minutes: unknown, reset: unknown): QuotaWindow | undefined {
  const percent = number(used);
  if (percent === undefined || percent < 0) return;
  const duration = number(minutes);
  return { used: percent, minutes: duration !== undefined && duration > 0 ? duration : undefined, reset: epoch(reset) };
}

export function codexHeaderQuotas(headers: Record<string, string>, now: number): CodexQuota[] {
  const h = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const ids = new Set<string>();
  for (const key of Object.keys(h)) {
    const match = key.match(/^x-([a-z0-9-]+)-(?:primary|secondary)-used-percent$/);
    if (match) ids.add(match[1]);
  }
  return [...ids].slice(0, 32).flatMap((id) => {
    const read = (kind: string) => window(headerNumber(h[`x-${id}-${kind}-used-percent`]),
      headerNumber(h[`x-${id}-${kind}-window-minutes`]), headerNumber(h[`x-${id}-${kind}-reset-at`]));
    const primary = read("primary"), secondary = read("secondary");
    return primary || secondary ? [{ id, primary, secondary, observed: now }] : [];
  });
}

export function codexStreamQuota(value: unknown, now: number): CodexQuota | undefined {
  const event = object(value);
  if (event?.type !== "codex.rate_limits") return;
  const rates = object(event.rate_limits);
  if (!rates) return;
  const read = (kind: string) => {
    const part = object(rates[kind]);
    return part ? window(part.used_percent, part.window_minutes, part.reset_at) : undefined;
  };
  const primary = read("primary"), secondary = read("secondary");
  if (!primary && !secondary) return;
  const rawId = event.metered_limit_name ?? event.limit_name;
  const id = typeof rawId === "string" && /^[a-z0-9_-]{1,80}$/i.test(rawId) ? rawId.toLowerCase().replaceAll("_", "-") : "codex";
  return { id, primary, secondary, observed: now };
}

/** Read-only WHAM usage response used by Codex CLI. Allowlist only quota fields. */
export function codexUsageQuotas(payload: unknown, now: number): CodexQuota[] {
  const data = object(payload);
  if (!data) throw new QuotaCheckError("Codex returned an invalid usage response.");
  const read = (value: unknown, id: string): CodexQuota | undefined => {
    const rates = object(value);
    if (!rates) return;
    const readWindow = (kind: string) => {
      const part = object(rates[`${kind}_window`]);
      if (!part) return;
      const seconds = number(part.limit_window_seconds);
      const result = window(part.used_percent, seconds === undefined ? undefined : seconds / 60, part.reset_at);
      const after = number(part.reset_after_seconds);
      if (result && result.reset === undefined && after !== undefined && after >= 0 && after < 8.64e12) {
        result.reset = now + after * 1000;
      }
      return result;
    };
    const primary = readWindow("primary"), secondary = readWindow("secondary");
    if (!primary && !secondary) return;
    return { id, primary, secondary, observed: now,
      allowed: typeof rates.allowed === "boolean" ? rates.allowed : undefined,
      reached: typeof rates.limit_reached === "boolean" ? rates.limit_reached : undefined };
  };
  const result: CodexQuota[] = [];
  const main = read(data.rate_limit, "codex");
  if (main) result.push(main);
  if (Array.isArray(data.additional_rate_limits)) {
    for (const raw of data.additional_rate_limits.slice(0, 32)) {
      const item = object(raw);
      if (!item) continue;
      const rawId = item.metered_feature ?? item.limit_name;
      const id = typeof rawId === "string" && /^[a-z0-9_-]{1,80}$/i.test(rawId)
        ? rawId.toLowerCase().replaceAll("_", "-") : `additional-${result.length + 1}`;
      const extra = read(item.rate_limit, id);
      if (extra) result.push(extra);
    }
  }
  if (!result.length) throw new QuotaCheckError("Codex did not report usage windows for this account.");
  return result;
}

function date(value: number | undefined) { return value === undefined ? "unknown" : new Date(value).toLocaleString(); }
function percent(value: number) { return `${Math.min(100, Math.max(0, value)).toFixed(1).replace(/\.0$/, "")}%`; }
export function formatCodexQuotas(snapshots: CodexQuota[], now: number, live = false): string {
  if (!snapshots.length) return "OpenAI Codex quota: unknown. No quota data observed for this model yet. Normal responses may supply it; no probe/model call was made.";
  const lines = [live ? `OpenAI Codex quota — checked ${date(now)} (read-only usage endpoint).`
    : "OpenAI Codex quota — cached observations, not a live check."];
  for (const snapshot of snapshots) {
    lines.push(`[${snapshot.id}] observed ${date(snapshot.observed)} (${Math.max(0, Math.floor((now - snapshot.observed) / 1000))}s ago)`);
    if (snapshot.allowed === false || snapshot.reached === true) lines.push("  Included usage currently blocked / limit reached.");
    for (const kind of ["primary", "secondary"] as const) {
      const part = snapshot[kind];
      if (!part) { lines.push(`  ${kind}: unknown`); continue; }
      const label = part.minutes === 300 ? "5-hour" : part.minutes === 10080 ? "weekly" : part.minutes ? `${part.minutes}-minute` : kind;
      const passed = part.reset !== undefined && part.reset <= now;
      lines.push(`  ${label}: ${percent(100 - part.used)} remaining; resets ${date(part.reset)}${passed ? " (reset passed; current quota unknown)" : ""}`);
    }
  }
  lines.push("Percentages are last observed, not remaining tokens or a guarantee of availability.");
  return lines.join("\n");
}

export class QuotaCheckError extends Error {}
const usd = (value: number) => `$${value.toFixed(4)}`;
export function formatOpenRouterQuota(payload: unknown, checked: number): string {
  const data = object(object(payload)?.data);
  if (!data) throw new QuotaCheckError("OpenRouter returned an invalid key-info response.");
  // Do not derive a resetting key's remaining budget from lifetime usage.
  const limit = number(data.limit), remaining = number(data.limit_remaining);
  if (!(data.limit === null || (limit !== undefined && limit >= 0) ||
    ["usage", "usage_daily", "usage_weekly", "usage_monthly"].some(key => number(data[key]) !== undefined) ||
    number(object(data.effective_budget)?.remaining_usd) !== undefined)) {
    throw new QuotaCheckError("OpenRouter returned an invalid key-info response.");
  }
  const lines = [`OpenRouter key quota — checked ${date(checked)}`];
  if (data.limit === null) lines.push("Key spending cap: none configured (not unlimited account credit).");
  else if (limit !== undefined && limit >= 0) {
    lines.push(`Key spending cap: ${usd(limit)}`);
    lines.push(`Key budget remaining: ${remaining === undefined ? "unknown" : `${usd(remaining)}${limit > 0 ? ` (${percent(remaining / limit * 100)})` : ""}`}`);
  } else lines.push("Key spending cap / remaining: unknown.");
  const reset = data.limit_reset;
  lines.push(`Key cap reset: ${reset === null ? "never" : ["daily", "weekly", "monthly"].includes(String(reset)) ? `${reset} (UTC)` : "unknown"}`);
  for (const [field, label] of [["usage", "Lifetime spend"], ["usage_daily", "Today (UTC)"], ["usage_weekly", "This week (UTC)"], ["usage_monthly", "This month (UTC)"]] as const) {
    const value = number(data[field]);
    if (value !== undefined && value >= 0) lines.push(`${label}: ${usd(value)}`);
  }
  const budget = object(data.effective_budget);
  const budgetRemaining = number(budget?.remaining_usd);
  if (budgetRemaining !== undefined) {
    const resetAt = typeof budget?.resets_at === "string" ? Date.parse(budget.resets_at) : NaN;
    lines.push(`Effective enforced budget remaining: ${usd(budgetRemaining)}; resets ${Number.isFinite(resetAt) ? date(resetAt) : budget?.resets_at === null ? "never" : "unknown"}`);
  }
  const free = object(data.free_model_daily_requests);
  const freeRemaining = number(free?.remaining), freeLimit = number(free?.limit);
  if (freeRemaining !== undefined && freeLimit !== undefined) lines.push(`Free-model requests today: ${freeRemaining} / ${freeLimit} remaining`);
  lines.push("Key cap is not prepaid account balance. Other account/budget/rate limits may also apply.");
  return lines.join("\n");
}

export function officialCodexBase(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && /^\/backend-api(?:\/codex)?\/?$/.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function queryCodexQuota(headers: Record<string, string>, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET", headers: { ...headers, Accept: "application/json" },
    signal, redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    const hint = response.status === 401 ? " Sign in again with /login openai-codex."
      : response.status === 403 ? " Access was denied by the account or usage service; cached data may still be available." : "";
    throw new QuotaCheckError(`Codex usage check failed (HTTP ${response.status}).${hint}`);
  }
  return response.json();
}

export function officialOpenRouterBase(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return url.origin === "https://openrouter.ai" && /^\/api\/v1\/?$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Reject on cancellation even if a legacy credential resolver ignores the signal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new QuotaCheckError("Quota check cancelled or timed out."));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

export async function queryOpenRouterQuota(authorization: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher("https://openrouter.ai/api/v1/key", {
    method: "GET", headers: { Authorization: authorization, Accept: "application/json" },
    signal, redirect: "error", cache: "no-store",
  });
  if (!response.ok) throw new QuotaCheckError(`OpenRouter key-info check failed (HTTP ${response.status}).`);
  return response.json();
}
