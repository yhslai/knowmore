import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Lease } from "./quota-wait.js";

/** Process/thread-scoped sleep request: closed stdin, process exit, or lease expiry releases it. */
export function acquireQuotaAwake(deadline: number): Lease {
  if (process.platform !== "win32") throw new Error("Quota keep-awake currently requires Windows.");
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", fileURLToPath(new URL("./quota-keep-awake.ps1", import.meta.url)),
    // Watchdog grace lets the controller release normally at the reset boundary.
    "-DeadlineMilliseconds", String(deadline + 30_000),
  ], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let stopped = false;
  let acknowledged = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveLost!: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
  const exited = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  const failed = () => {
    if (!acknowledged) rejectReady(new Error("Sleep blocker unavailable."));
    if (!stopped) resolveLost();
  };
  child.on("error", failed);
  child.on("exit", failed);
  // EPIPE is normal if a helper exits while a heartbeat is being sent.
  child.stdin.on("error", () => {});
  let output = "";
  const startup = setTimeout(() => { failed(); child.kill(); }, 10_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output = (output + chunk).slice(-100);
    if (!acknowledged && /(?:^|\n)READY\r?\n/.test(output)) {
      acknowledged = true;
      clearTimeout(startup);
      resolveReady();
    }
  });
  const heartbeat = setInterval(() => {
    if (!stopped && child.stdin.writable) child.stdin.write("ping\n");
  }, 5000);
  let releasing: Promise<void> | undefined;
  return {
    ready, lost,
    release() {
      if (releasing) return releasing;
      stopped = true;
      clearTimeout(startup);
      clearInterval(heartbeat);
      child.stdin.end();
      // Windows terminates the helper if it cannot leave its input loop promptly.
      const force = setTimeout(() => child.kill(), 1000);
      releasing = exited.finally(() => { clearTimeout(force); });
      return releasing;
    },
  };
}
