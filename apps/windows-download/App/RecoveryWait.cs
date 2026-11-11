namespace LedgeTop.Files;

// Keeps awaiting the exact operation after the notice threshold. The threshold is not a
// cancellation, retry, kill, or proof of completion. Caller retains all ownership handles.
internal static class RecoveryWait
{
    private static readonly object holdGate = new();
    private static readonly List<object[]> holds = [];
    // Strong process-lifetime root. Production intentionally never disposes this token after an
    // uncertain outcome; the removable token exists for deterministic isolated lifetime tests.
    internal static IDisposable Retain(params object[] owners)
    {
        lock (holdGate) holds.Add(owners);
        return new HoldToken(owners);
    }
    private sealed class HoldToken(object[] owners) : IDisposable
    {
        public void Dispose() { lock (holdGate) holds.Remove(owners); }
    }
    internal static async Task<T> WaitAsync<T>(Task<T> operation, Task noticeDelay, Func<IDisposable> showNotice)
    {
        IDisposable? notice = null;
        try {
            if (await Task.WhenAny(operation, noticeDelay) != operation && !operation.IsCompleted) {
                try { notice = showNotice(); } catch { /* Continue supervising even if UI cannot be shown. */ }
            }
            return await operation;
        } finally { try { notice?.Dispose(); } catch { } }
    }
}
