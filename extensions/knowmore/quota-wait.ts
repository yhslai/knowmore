export const BUFFER_MS = 60_000;
export const FALLBACK_MS = 5 * 60 * 60_000;

/** Only quota errors, not general 429s, billing failures, or authentication errors. */
export function quotaReset(error: string, now: number): number | undefined {
  if (!/usage_limit_reached|(?:ChatGPT|Codex).*usage limit|usage limit.*(?:ChatGPT|Codex)/i.test(error)) return;
  const epoch = error.match(/["']?resets_at["']?\s*[:=]\s*(\d{10,13})/i);
  if (epoch) {
    const value = Number(epoch[1]);
    return Math.max(now, value < 1e12 ? value * 1000 : value) + BUFFER_MS;
  }
  const relative = error.match(/(?:try again|resets?) in\s*~?\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|hours?|hrs?|seconds?|secs?)/i);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const ms = Number(relative[1]) * (unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000);
    if (Number.isFinite(ms)) return now + ms + BUFFER_MS;
  }
  return now + FALLBACK_MS + BUFFER_MS;
}

export interface Lease { ready: Promise<void>; lost?: Promise<void>; release(): Promise<void> }
export interface WaitDependencies {
  now(): number;
  every(callback: () => void): () => void;
  acquire(deadline: number): Lease;
  status(deadline?: number): void;
  notify(message: string, error?: boolean): void;
}

/** Owns every wait resource. Generation checks prevent resume after asynchronous cancellation. */
export class QuotaWait {
  private generation = 0;
  private active?: { deadline: number; lease: Lease; stop: () => void; ready: boolean; valid: () => boolean; resume: () => void };
  constructor(private deps: WaitDependencies) {}
  get deadline() { return this.active?.deadline; }

  async cancel(): Promise<void> {
    ++this.generation;
    const old = this.active;
    this.active = undefined;
    if (!old) return;
    old.stop();
    try { this.deps.status(); } finally { await old.lease.release(); }
  }

  async start(deadline: number, valid: () => boolean, resume: () => void): Promise<void> {
    const cleanup = this.cancel();
    const generation = this.generation;
    await cleanup;
    if (this.generation !== generation) return;
    let lease: Lease;
    try { lease = this.deps.acquire(deadline); }
    catch { this.deps.notify('Quota wait not started: Windows sleep blocker failed.', true); return; }
    const state = { deadline, lease, stop: () => {}, ready: false, valid, resume };
    this.active = state;
    void lease.lost?.then(async () => {
      if (this.active !== state) return;
      await this.cancel();
      this.deps.notify('Quota wait cancelled: Windows sleep blocker exited.', true);
    });
    try {
      state.stop = this.deps.every(() => { void this.tick().catch(() => { void this.cancel(); }); });
      this.deps.status(deadline);
      await lease.ready;
      if (this.active !== state || generation !== this.generation) return;
      state.ready = true;
      this.deps.notify(`Quota wait until ${new Date(deadline).toLocaleString()}. Windows kept awake only while waiting. Escape or /quota-wait cancel to cancel.`);
      await this.tick();
    } catch {
      if (this.active === state) {
        await this.cancel();
        this.deps.notify('Quota wait cancelled: Windows sleep blocker failed.', true);
      }
    }
  }

  private async tick(): Promise<void> {
    const state = this.active;
    if (!state) return;
    if (!state.valid()) { await this.cancel(); return; }
    this.deps.status(state.deadline);
    if (!state.ready || this.deps.now() < state.deadline) return;
    const generation = this.generation;
    this.active = undefined;
    state.stop();
    try {
      this.deps.status();
      // Release before starting any model work, not merely after the job finishes.
      await state.lease.release();
      if (this.generation === generation && state.valid()) state.resume();
    } catch {
      this.deps.notify('Automatic resume failed; continue manually. Sleep blocker released.', true);
    }
  }
}
