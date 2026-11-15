import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  abortable, codexHeaderQuotas, codexStreamQuota, formatCodexQuotas,
  formatOpenRouterQuota, officialOpenRouterBase, queryOpenRouterQuota,
  codexUsageQuotas, officialCodexBase, queryCodexQuota,
  QuotaCheckError, type CodexQuota,
} from "./quota-status.js";

type Model = NonNullable<ExtensionContext["model"]>;
interface RequestAuth { ok: boolean; apiKey?: string; headers?: Record<string, string | null | undefined>; baseUrl?: string }
interface RegistryAuth {
  getApiKeyAndHeaders?(model: Model): Promise<RequestAuth>;
  getApiKey?(model: Model): Promise<string | undefined>;
}
// Compatibility with Knowmore's legacy peer typings; these are current Pi hooks.
interface QuotaEvents {
  after_provider_response: { headers: Record<string, string> };
  provider_stream_event: { provider: string; model: string; data: unknown };
}
type Observe = <K extends keyof QuotaEvents>(event: K,
  handler: (event: QuotaEvents[K], ctx: ExtensionContext) => void) => unknown;

async function authHeadersForModel(ctx: ExtensionContext, model: Model, signal: AbortSignal): Promise<Record<string, string>> {
  const codex = model.provider === "openai-codex";
  const label = codex ? "Codex" : "OpenRouter";
  const officialBase = codex ? officialCodexBase : officialOpenRouterBase;
  const checkBase = (url: string | undefined) => {
    if (!officialBase(url)) throw new QuotaCheckError(`Quota check supports the official ${label} endpoint only, not a custom gateway.`);
  };
  checkBase(model.baseUrl);
  const registry = ctx.modelRegistry as unknown as RegistryAuth;
  let auth: RequestAuth | undefined;
  if (registry.getApiKeyAndHeaders) {
    auth = await abortable(registry.getApiKeyAndHeaders(model), signal);
    if (!auth.ok) throw new QuotaCheckError(`Could not resolve the active model's ${label} credential. Check Pi's provider configuration.`);
    checkBase(auth.baseUrl);
  } else if (registry.getApiKey) {
    auth = { ok: true, apiKey: await abortable(registry.getApiKey(model), signal) };
  }
  const fields = Object.entries(auth?.headers ?? {});
  const override = fields.find(([name]) => name.toLowerCase() === "authorization");
  const authorization = override ? override[1] : auth?.apiKey ? `Bearer ${auth.apiKey}` : undefined;
  if (typeof authorization !== "string" || !authorization.trim()) {
    throw new QuotaCheckError(`No ${label} credential is configured for the active model. Configure it in Pi, not Knowmore's distiller settings.`);
  }
  const headers: Record<string, string> = { Authorization: authorization };
  if (codex) {
    // Forward an account selection only if Pi resolved one. Never decode the token,
    // read auth files, or collect browser cookies to obtain additional identity data.
    const account = fields.find(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];
    if (typeof account === "string" && account.trim()) headers["ChatGPT-Account-Id"] = account;
  }
  return headers;
}

export function registerQuotaCommand(pi: ExtensionAPI, dependencies: { now?: () => number; fetcher?: typeof fetch; timeoutMs?: number } = {}) {
  const now = dependencies.now ?? Date.now;
  const snapshots = new Map<string, Map<string, CodexQuota>>();
  let requestModel: string | undefined;
  let generation = 0;
  let inFlight: AbortController | undefined;
  let clearStatus: (() => void) | undefined;
  const observe = pi.on.bind(pi) as unknown as Observe;
  const store = (model: string, values: CodexQuota[]) => {
    if (!values.length) return;
    const entries = snapshots.get(model) ?? new Map<string, CodexQuota>();
    for (const value of values) entries.set(value.id, value);
    while (entries.size > 64) entries.delete(entries.keys().next().value!);
    snapshots.set(model, entries);
    // Session-only bounded memory, not account history or a credential cache.
    if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
  };
  const invalidate = () => {
    generation++;
    inFlight?.abort();
    inFlight = undefined;
    clearStatus?.();
    clearStatus = undefined;
  };
  pi.on("before_provider_request", (_event, ctx) => {
    requestModel = ctx.model?.provider === "openai-codex" ? ctx.model.id : undefined;
  });
  observe("after_provider_response", (event) => {
    if (requestModel) store(requestModel, codexHeaderQuotas(event.headers, now()));
  });
  observe("provider_stream_event", (event) => {
    if (event.provider !== "openai-codex") return;
    const value = codexStreamQuota(event.data, now());
    if (value) store(event.model, [value]);
  });
  pi.on("model_select", invalidate);
  pi.on("session_shutdown", () => { invalidate(); snapshots.clear(); requestModel = undefined; });

  pi.registerCommand("km-usage", {
    description: "Read current Codex/OpenRouter quota without a model call; /km-usage cached shows offline Codex observations",
    handler: async (args, ctx) => {
      const cachedOnly = args.trim() === "cached";
      if (args.trim() && !cachedOnly) { ctx.ui.notify("Usage: /km-usage [cached] (cached is Codex-only)", "warning"); return; }
      invalidate();
      const version = generation;
      const model = ctx.model;
      if (!model) { ctx.ui.notify("No model selected.", "warning"); return; }
      const session = ctx.sessionManager.getSessionId();
      const provider = model.provider, modelId = model.id;
      const codex = provider === "openai-codex";
      const current = () => version === generation && ctx.sessionManager.getSessionId() === session &&
        ctx.model?.provider === provider && ctx.model.id === modelId;
      const show = (text: string) => {
        if (!current()) return;
        // UI-only entry: do not put quota/account information into model context.
        pi.appendEntry("knowmore-quota", { provider: model.provider, model: model.id, text });
        ctx.ui.notify("Quota report shown.", "info");
      };
      const cached = () => [...(snapshots.get(modelId)?.values() ?? [])];
      if (codex && cachedOnly) {
        show(formatCodexQuotas(cached(), now()));
        return;
      }
      if (!codex && model.provider !== "openrouter") {
        ctx.ui.notify("/km-usage supports openai-codex and openrouter. The active provider is not supported.", "warning");
        return;
      }
      if (cachedOnly) { ctx.ui.notify("/km-usage cached is only available for Codex. Use /km-usage for OpenRouter.", "warning"); return; }
      const label = codex ? "Codex usage" : "OpenRouter key quota";
      const controller = new AbortController();
      inFlight = controller;
      const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 10_000);
      ctx.ui.setStatus("knowmore.quota-check", `Checking ${label}...`);
      clearStatus = () => ctx.ui.setStatus("knowmore.quota-check", undefined);
      try {
        const headers = await authHeadersForModel(ctx, model, controller.signal);
        if (!current() || controller.signal.aborted) return;
        const data = await abortable(codex
          ? queryCodexQuota(headers, controller.signal, dependencies.fetcher)
          : queryOpenRouterQuota(headers.Authorization, controller.signal, dependencies.fetcher), controller.signal);
        if (!current()) return;
        if (codex) {
          const values = codexUsageQuotas(data, now());
          snapshots.set(modelId, new Map(values.map(value => [value.id, value])));
          show(formatCodexQuotas(values, now(), true));
        } else show(formatOpenRouterQuota(data, now()));
      } catch (error) {
        if (current()) {
          // Never render raw auth errors, exception messages, URLs, or response bodies.
          const message = controller.signal.aborted ? "Quota check cancelled or timed out."
            : error instanceof QuotaCheckError ? error.message : `${codex ? "Codex" : "OpenRouter"} quota check failed (network or invalid response).`;
          ctx.ui.notify(message, "error");
          if (codex && cached().length) show(`Live lookup failed: ${message}\n\n${formatCodexQuotas(cached(), now())}`);
        }
      } finally {
        clearTimeout(timeout);
        if (inFlight === controller) {
          inFlight = undefined;
          clearStatus?.();
          clearStatus = undefined;
        }
      }
    },
  });
}
