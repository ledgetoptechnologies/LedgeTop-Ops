using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace LedgeTop.WindowsDownload;

[StructLayout(LayoutKind.Sequential)]
internal struct CloudConnectionKey { internal long Internal; }
[StructLayout(LayoutKind.Sequential)]
internal struct CloudOperationInfo {
    internal uint StructSize;
    internal int Type;
    internal CloudConnectionKey ConnectionKey;
    internal long TransferKey;
    internal nint CorrelationVector, SyncStatus;
    internal long RequestKey;
}
[StructLayout(LayoutKind.Sequential)]
internal struct CloudTransferData {
    internal uint Flags;
    internal int CompletionStatus;
    internal nint Buffer;
    internal long Offset, Length;
}
// Allocate the complete union, but ParamSize describes only the TRANSFER_DATA member.
[StructLayout(LayoutKind.Explicit, Size = 48)]
internal struct CloudOperationParameters {
    [FieldOffset(0)] internal uint ParamSize;
    [FieldOffset(8)] internal CloudTransferData TransferData;
}
internal interface ICloudFilesTransferNative {
    int Execute(nint operationInfo, nint parameters);
    int ReportProgress(long connectionKey, long transferKey, long total, long completed);
}

/// <summary>Trusted future callback composition only. No registration, path-based handles or raw writable sink.</summary>
internal static class CloudFilesNativeTransfer {
    internal const int Unavailable = unchecked((int)0xC000CF12), Cancelled = unchecked((int)0xC000CF1B);
    internal static Task HydrateForCallbackAsync(PlaceholderHydrationCoordinator coordinator, PlaceholderIdentity identity,
        CloudFilesOperationContext context, CancellationToken token) =>
        HydrateForCallbackAsync(coordinator, identity, context, token, new WindowsNative(), TimeSpan.FromSeconds(20));

    internal static async Task HydrateForCallbackAsync(PlaceholderHydrationCoordinator coordinator, PlaceholderIdentity identity,
        CloudFilesOperationContext context, CancellationToken token, ICloudFilesTransferNative native, TimeSpan heartbeatInterval) {
        AssertAbi();
        // Empty FETCH_DATA requests are deliberately unsupported: no invented zero-byte native completion.
        if (context.FileSize != identity.Length || context.RequiredOffset < 0 || context.RequiredLength <= 0
            || context.RequiredOffset > context.FileSize || context.RequiredLength > context.FileSize - context.RequiredOffset
            || context.RequiredOffset % 4096 != 0
            || (context.RequiredLength % 4096 != 0 && context.RequiredLength != context.FileSize - context.RequiredOffset)
            || heartbeatInterval <= TimeSpan.Zero || heartbeatInterval >= TimeSpan.FromSeconds(60))
            throw new TransferException("Native hydration context is unsupported.");
        using var sink = new Sink(context, native, token, heartbeatInterval);
        try {
            sink.StartProgress();
            await coordinator.HydrateAsync(identity, context.RequiredOffset, context.RequiredLength, sink, sink.Token);
        } catch (Exception) {
            await sink.FailAsync(token.IsCancellationRequested ? "cancelled" : "unavailable");
            if (sink.Committed) return;
            if (token.IsCancellationRequested) throw new OperationCanceledException(token);
            throw new TransferException("Native hydration unavailable.");
        } finally { await sink.StopProgressAsync(); }
    }

    internal static void AssertAbi() {
        if (IntPtr.Size != 8 || Marshal.SizeOf<CloudConnectionKey>() != 8 || Marshal.SizeOf<CloudOperationInfo>() != 48
            || Marshal.OffsetOf<CloudOperationInfo>(nameof(CloudOperationInfo.ConnectionKey)).ToInt32() != 8
            || Marshal.OffsetOf<CloudOperationInfo>(nameof(CloudOperationInfo.TransferKey)).ToInt32() != 16
            || Marshal.OffsetOf<CloudOperationInfo>(nameof(CloudOperationInfo.CorrelationVector)).ToInt32() != 24
            || Marshal.OffsetOf<CloudOperationInfo>(nameof(CloudOperationInfo.SyncStatus)).ToInt32() != 32
            || Marshal.OffsetOf<CloudOperationInfo>(nameof(CloudOperationInfo.RequestKey)).ToInt32() != 40
            || Marshal.SizeOf<CloudTransferData>() != 32 || Marshal.SizeOf<CloudOperationParameters>() != 48
            || Marshal.OffsetOf<CloudOperationParameters>(nameof(CloudOperationParameters.TransferData)).ToInt32() != 8
            || Marshal.OffsetOf<CloudTransferData>(nameof(CloudTransferData.Buffer)).ToInt32() != 8
            || Marshal.OffsetOf<CloudTransferData>(nameof(CloudTransferData.Offset)).ToInt32() != 16
            || Marshal.OffsetOf<CloudTransferData>(nameof(CloudTransferData.Length)).ToInt32() != 24)
            throw new TransferException("Cloud Files transfer ABI is unsupported.");
    }

    private sealed class Sink : IPlaceholderTransferSink, IDisposable {
        private readonly CloudFilesOperationContext context;
        private readonly ICloudFilesTransferNative native;
        private readonly CancellationToken caller;
        private readonly CancellationTokenSource operation, progressStop = new();
        private readonly TimeSpan interval;
        private readonly object nativeGate = new();
        private Task progress = Task.CompletedTask;
        private long next;
        private bool terminal;
        private volatile bool progressFailed;
        internal bool Committed { get; private set; }
        internal CancellationToken Token => operation.Token;
        internal Sink(CloudFilesOperationContext context, ICloudFilesTransferNative native, CancellationToken token, TimeSpan interval) {
            this.context = context; this.native = native; caller = token; this.interval = interval;
            operation = CancellationTokenSource.CreateLinkedTokenSource(token); next = context.RequiredOffset;
        }
        internal void StartProgress() {
            Token.ThrowIfCancellationRequested();
            Report();
            progress = PumpAsync();
        }
        private void Report() {
            lock (nativeGate) {
                if (terminal) throw new TransferException("Native transfer is terminal.");
                // Truthful indeterminate progress: temporary download bytes are not yet verified hydration.
                if (native.ReportProgress(context.ConnectionKey, context.TransferKey, 1, 0) != 0)
                    throw new TransferException("Native progress unavailable.");
            }
        }
        private async Task PumpAsync() {
            try {
                while (true) { await Task.Delay(interval, progressStop.Token); progressStop.Token.ThrowIfCancellationRequested(); Report(); }
            } catch (OperationCanceledException) when (progressStop.IsCancellationRequested) { }
            catch { progressFailed = true; try { operation.Cancel(); } catch { /* Cancellation observers must not prevent native failure settlement. */ } }
        }
        internal async Task StopProgressAsync() { progressStop.Cancel(); await progress; }
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) {
            if (offset != next || bytes.Length <= 0 || bytes.Length > 65536 || bytes.Length > context.RequiredOffset + context.RequiredLength - next
                || offset % 4096 != 0 || (bytes.Length % 4096 != 0 && offset + bytes.Length != context.FileSize))
                throw new TransferException("Native transfer range is invalid.");
            var final = bytes.Length == context.RequiredOffset + context.RequiredLength - next;
            // Final TRANSFER_DATA can satisfy the pending IO. Join first, with no native lock held.
            if (final) await StopProgressAsync();
            token.ThrowIfCancellationRequested();
            lock (nativeGate) {
                if (terminal || progressFailed) throw new TransferException("Native transfer unavailable.");
                Execute(0, offset, bytes.Length, bytes);
                next += bytes.Length;
                if (final) { Committed = true; terminal = true; }
            }
        }
        public async Task CompleteAsync(CancellationToken token) {
            await StopProgressAsync();
            if (Committed) return;
            token.ThrowIfCancellationRequested();
            lock (nativeGate) {
                if (terminal || progressFailed || next != context.RequiredOffset + context.RequiredLength)
                    throw new TransferException("Native transfer is incomplete.");
                terminal = true; // No native 'complete' operation exists; successful data transfers satisfy this range.
            }
        }
        public async Task FailAsync(string code) {
            await StopProgressAsync();
            lock (nativeGate) {
                if (terminal) return;
                terminal = true;
                // One valid original requested range, including when some earlier chunks succeeded.
                try { Execute(code == "cancelled" && caller.IsCancellationRequested ? Cancelled : Unavailable,
                    context.RequiredOffset, context.RequiredLength, ReadOnlyMemory<byte>.Empty); } catch { }
            }
        }
        private void Execute(int status, long offset, long length, ReadOnlyMemory<byte> bytes) {
            byte[]? owned = status == 0 ? bytes.ToArray() : null;
            GCHandle pin = default; nint memory = 0;
            try {
                if (owned is not null) pin = GCHandle.Alloc(owned, GCHandleType.Pinned);
                var info = new CloudOperationInfo { StructSize = 48, Type = 0,
                    ConnectionKey = new() { Internal = context.ConnectionKey }, TransferKey = context.TransferKey, RequestKey = context.RequestKey };
                var parameters = new CloudOperationParameters { ParamSize = 40, TransferData = new() {
                    CompletionStatus = status, Buffer = owned is null ? 0 : pin.AddrOfPinnedObject(), Offset = offset, Length = length } };
                memory = Marshal.AllocHGlobal(96);
                Marshal.StructureToPtr(info, memory, false); Marshal.StructureToPtr(parameters, memory + 48, false);
                // The native contract is synchronous. Cancellation never releases this pin before Execute returns.
                if (native.Execute(memory, memory + 48) != 0) throw new TransferException("Native transfer failed.");
            } finally {
                if (memory != 0) Marshal.FreeHGlobal(memory);
                if (pin.IsAllocated) pin.Free();
                if (owned is not null) CryptographicOperations.ZeroMemory(owned);
            }
        }
        public void Dispose() { operation.Dispose(); progressStop.Dispose(); }
    }

    private sealed class WindowsNative : ICloudFilesTransferNative {
        public int Execute(nint operationInfo, nint parameters) { RequireWindows(); return CfExecute(operationInfo, parameters); }
        public int ReportProgress(long connectionKey, long transferKey, long total, long completed) {
            RequireWindows(); return CfReportProviderProgress(new() { Internal = connectionKey }, transferKey, total, completed);
        }
        private static void RequireWindows() { if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64) throw new TransferException("Cloud Files transfer platform is unsupported."); }
        [DllImport("CldApi.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int CfExecute(nint operationInfo, nint parameters);
        [DllImport("CldApi.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int CfReportProviderProgress(CloudConnectionKey connectionKey, long transferKey, long total, long completed);
    }
}
