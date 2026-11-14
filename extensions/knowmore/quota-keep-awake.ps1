param([Parameter(Mandatory = $true)][double]$DeadlineMilliseconds)
$ErrorActionPreference = 'Stop'

# This method stays on ONE native thread. ES_CONTINUOUS is thread-scoped.
# Never change the power plan. The screen is deliberately allowed to sleep.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KnowmoreQuotaAwake {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);
    public static void Run(double deadline) {
        if (SetThreadExecutionState(0x80000001u) == 0)
            throw new InvalidOperationException("Could not request system awake state.");
        try {
            Console.WriteLine("READY");
            Console.Out.Flush();
            while (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < deadline) {
                // EOF releases immediately if Pi exits/crashes. A missing heartbeat
                // releases within 20 seconds even if Pi hangs or is suspended.
                // Windows PowerShell's synchronized Console.In may implement
                // ReadLineAsync synchronously. Explicitly move the read off-thread.
                var line = System.Threading.Tasks.Task.Run(() => Console.In.ReadLine());
                int remaining = (int)Math.Min(20000, Math.Max(1,
                    deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
                if (!line.Wait(remaining) || line.Result != "ping") break;
            }
        } finally {
            SetThreadExecutionState(0x80000000u);
        }
    }
}
'@
[KnowmoreQuotaAwake]::Run($DeadlineMilliseconds)
