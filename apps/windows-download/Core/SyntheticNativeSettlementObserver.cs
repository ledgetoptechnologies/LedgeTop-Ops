#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace LedgeTop.WindowsDownload;

// Synthetic-only observation: a void FailAsync result is not proof that the
// native failure settlement succeeded. Never called by a packaged provider.
internal readonly record struct SyntheticFailureSettlement(long RequestKey, string FileName, int CompletionStatus, int? NativeResult);
internal sealed class SyntheticSettlementLog {
    private readonly ConcurrentQueue<SyntheticFailureSettlement> values = new();
    private int attempted;
    internal void Add(SyntheticFailureSettlement value) { if (Interlocked.Increment(ref attempted) <= 64) values.Enqueue(value); }
    internal int Attempted => Volatile.Read(ref attempted);
    internal SyntheticFailureSettlement[] Snapshot() => values.ToArray();
}
internal sealed class SyntheticNativeSettlementObserver(
    ICloudFilesTransferNative inner, long requestKey, string fileName, SyntheticSettlementLog output) : ICloudFilesTransferNative {
    public int Execute(nint operationInfo, nint parameters) {
        var completionStatus = Marshal.ReadInt32(parameters, 12);
        try {
            var result = inner.Execute(operationInfo, parameters);
            if (completionStatus != 0) output.Add(new(requestKey, fileName, completionStatus, result));
            return result;
        } catch {
            if (completionStatus != 0) output.Add(new(requestKey, fileName, completionStatus, null));
            throw;
        }
    }
    public int ReportProgress(long connectionKey, long transferKey, long total, long completed) =>
        inner.ReportProgress(connectionKey, transferKey, total, completed);
}
#endif
