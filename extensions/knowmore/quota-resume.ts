import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { acquireQuotaAwake } from "./quota-awake.js";
import { quotaReset, QuotaWait, type WaitDependencies } from "./quota-wait.js";

// Knowmore's legacy peer typings predate these events. Current Pi exposes them.
// Keep the compatibility shim here rather than changing the rest of Knowmore's imports.
interface QuotaEvents {
  agent_settled: { aborted: boolean };
  provider_stream_event: { provider: string; data: unknown };
  cache_warming_decision: { action: "warm" | "stop" };
}
type Observe = <K extends keyof QuotaEvents>(name: K,
  handler: (event: QuotaEvents[K], ctx: ExtensionContext) => unknown) => unknown;

export function registerQuotaResume(pi: ExtensionAPI, overrides: Partial<WaitDependencies> = {}) {
  let enabled = true;
  let ctx: ExtensionContext | undefined;
  let candidate: number | undefined;
  let streamReset: number | undefined;
  let streamQuota = false;
  let removeInput: (() => void) | undefined;
  const clearInput = () => { removeInput?.(); removeInput = undefined; };
  const wait = new QuotaWait({
    now: Date.now,
    every(callback) { const timer = setInterval(callback, 1000); return () => clearInterval(timer); },
    acquire: acquireQuotaAwake,
    status(deadline) {
      if (deadline === undefined) clearInput();
      ctx?.ui.setStatus("knowmore.quota-wait", deadline === undefined ? undefined :
        `Quota reset: ${Math.max(0, Math.ceil((deadline - Date.now()) / 60_000))} min | awake | Esc cancels`);
      if (deadline !== undefined && !removeInput && ctx?.hasUI) {
        removeInput = ctx.ui.onTerminalInput((data) => {
          if (data === "\x1b" || data === "\x1b[27u" || data === "\x03") {
            void cancel();
            ctx?.ui.notify("Quota wait cancelled; normal sleep policy restored.", "info");
            if (data !== "\x03") return { consume: true };
          }
        });
      }
    },
    notify(message, error) { ctx?.ui.notify(message, error ? "error" : "info"); },
    ...overrides,
  });
  async function cancel() {
    candidate = undefined;
    streamReset = undefined;
    streamQuota = false;
    clearInput();
    await wait.cancel();
  }
  const observe = pi.on.bind(pi) as unknown as Observe;

  // Never use request headers or auth stores. Only look at the provider's error fields.
  observe("provider_stream_event", (event) => {
    if (event.provider !== "openai-codex" || !event.data || typeof event.data !== "object") return;
    const data = event.data as { error?: unknown; response?: { error?: unknown } };
    const error = data.error ?? data.response?.error;
    if (!error || typeof error !== "object") return;
    const fields = error as { code?: unknown; type?: unknown; resets_at?: unknown };
    if (fields.code === "usage_limit_reached" || fields.type === "usage_limit_reached") {
      streamQuota = true;
      if (typeof fields.resets_at === "number" && Number.isFinite(fields.resets_at)) {
        streamReset = quotaReset(`usage_limit_reached resets_at: ${fields.resets_at}`, Date.now());
      }
    }
  });
  pi.on("agent_start", () => { candidate = undefined; streamReset = undefined; streamQuota = false; });
  pi.on("agent_end", (event) => {
    candidate = undefined;
    const last = event.messages.filter((message) => message.role === "assistant").pop();
    if (last?.role !== "assistant" || last.provider !== "openai-codex" || last.stopReason !== "error") return;
    const parsed = quotaReset(last.errorMessage ?? "", Date.now());
    candidate = streamReset ?? parsed ?? (streamQuota ? quotaReset("usage_limit_reached", Date.now()) : undefined);
  });
  observe("agent_settled", async (event, context) => {
    const deadline = candidate;
    candidate = undefined;
    if (event.aborted) { await cancel(); return; }
    if (!enabled || deadline === undefined || context.model?.provider !== "openai-codex") return;
    // Background timers cannot extend print/JSON invocations safely.
    if (!context.hasUI) return;
    ctx = context;
    const session = context.sessionManager.getSessionId();
    const leaf = context.sessionManager.getLeafId();
    const model = context.model.id;
    await wait.start(deadline, () => enabled && context.isIdle() && !context.hasPendingMessages() &&
      context.sessionManager.getSessionId() === session && context.sessionManager.getLeafId() === leaf &&
      context.model?.provider === "openai-codex" && context.model.id === model, () => {
        pi.sendMessage({
          customType: "knowmore-quota-resume",
          content: "The quota-reset wait has ended. Continue the interrupted task from the existing conversation. Check current file state before repeating side-effecting actions; do not redo completed work.",
          display: true,
        }, { triggerTurn: true });
      });
  });
  pi.on("input", async () => { await cancel(); return { action: "continue" }; });
  pi.on("before_agent_start", cancel);
  pi.on("model_select", cancel);
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_before_compact", cancel);
  pi.on("session_shutdown", cancel);
  observe("cache_warming_decision", () => wait.deadline === undefined ? undefined : { action: "stop" });
  pi.registerCommand("km-quota-wait", {
    description: "Quota auto-resume (Windows): status | cancel | off | on",
    handler: async (args, context) => {
      ctx = context;
      switch (args.trim() || "status") {
        case "cancel": await cancel(); break;
        case "off": enabled = false; await cancel(); break;
        case "on": enabled = true; break;
        case "status": break;
        default: context.ui.notify("Usage: /km-quota-wait [status|cancel|off|on]", "warning"); return;
      }
      context.ui.notify(`Quota auto-resume ${enabled ? "on" : "off"}; ${wait.deadline === undefined ? "not waiting (no sleep blocker)" : `waiting until ${new Date(wait.deadline).toLocaleString()}`}.`, "info");
    },
  });
  return wait;
}
