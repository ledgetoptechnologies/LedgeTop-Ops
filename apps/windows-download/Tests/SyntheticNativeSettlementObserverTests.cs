#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using LedgeTop.WindowsDownload;

internal static class SyntheticNativeSettlementObserverTests {
    private sealed class Native : ICloudFilesTransferNative {
        internal int Result, ProgressResult; internal bool Throw;
        public int Execute(nint info, nint parameters) => Throw ? throw new IOException("synthetic") : Result;
        public int ReportProgress(long connectionKey, long transferKey, long total, long completed) => ProgressResult;
    }
    internal static async Task RunAsync() {
        var native = new Native { ProgressResult = 17 }; var log = new SyntheticSettlementLog();
        var observed = new SyntheticNativeSettlementObserver(native, 123, "sample-1.bin", log);
        var memory = Marshal.AllocHGlobal(48);
        try {
            for (var i = 0; i < 48; i++) Marshal.WriteByte(memory, i, 0);
            if (observed.Execute(0, memory) != 0 || log.Attempted != 0 || observed.ReportProgress(1, 2, 3, 4) != 17)
                throw new IOException("Synthetic data/progress observation changed.");
            Marshal.WriteInt32(memory, 12, CloudFilesNativeTransfer.Unavailable);
            if (observed.Execute(0, memory) != 0) throw new IOException("Synthetic settlement result changed.");
            native.Result = 5; if (observed.Execute(0, memory) != 5) throw new IOException("Synthetic failure result changed.");
            native.Throw = true; try { observed.Execute(0, memory); throw new InvalidOperationException("Native exception suppressed."); } catch (IOException) { }
            var values = log.Snapshot();
            if (values.Length != 3 || values[0] != new SyntheticFailureSettlement(123, "sample-1.bin", CloudFilesNativeTransfer.Unavailable, 0) ||
                values[1].NativeResult != 5 || values[2].NativeResult is not null) throw new IOException("Settlement observations were inaccurate.");
            native.Throw = false; for (var i = 0; i < 70; i++) observed.Execute(0, memory);
            if (log.Attempted != 73 || log.Snapshot().Length != 64) throw new IOException("Settlement observation bound failed.");
        } finally { Marshal.FreeHGlobal(memory); }
        // An exclusive in-memory admission is held. A second synthetic fetch
        // times out, then its actual synthetic sink executes one failure call.
        // No directory or real Cloud Files provider is involved.
        foreach (var nativeResult in new[] { 0, 5 }) {
            var root = Path.Combine(Path.GetTempPath(), "synthetic-fail-fast-" + Guid.NewGuid().ToString("N"));
            var first = await HydrationCacheConcurrency.AcquireAsync(root, "first", default, exclusive: true);
            try {
                var bytes = Encoding.UTF8.GetBytes(new string('x', 100_000));
                var identity = new PlaceholderIdentity("pilot", "synthetic", "https://source.example.invalid", "odqp1_" + new string('f', 64),
                    "odqr1_1", "oef1_" + new string('b', 64), "v1", "sample-1.bin", bytes.Length, "\"v1\"", Convert.ToHexStringLower(SHA256.HashData(bytes)));
                var transfer = new CloudFilesOperationContext(1, 2, 3, bytes.Length, 0, bytes.Length);
                var settlementLog = new SyntheticSettlementLog(); var fake = new Native { Result = nativeResult };
                var observer = new SyntheticNativeSettlementObserver(fake, transfer.RequestKey, identity.FileName, settlementLog);
                var failed = false; var runEntered = false; var admissionTimedOut = false;
                try {
                    await CloudFilesNativeTransfer.HydrateSyntheticMemoryAsync(identity, transfer, bytes, default, observer,
                        async (_, token) => {
                            runEntered = true;
                            try { using var lease = await HydrationCacheConcurrency.AcquireAsync(root, "second", token, exclusive: true, testTimeout: TimeSpan.FromMilliseconds(150)); }
                            catch (TransferException error) when (error.Reason == TransferFailureReason.Timeout) { admissionTimedOut = true; throw; }
                        },
                        TimeSpan.FromMilliseconds(20));
                } catch (TransferException) { failed = true; }
                var values = settlementLog.Snapshot();
                if (!failed || !runEntered || !admissionTimedOut || values.Length != 1 || settlementLog.Attempted != 1 || values[0].CompletionStatus != CloudFilesNativeTransfer.Unavailable ||
                    values[0].NativeResult != nativeResult || values[0].RequestKey != 3 || values[0].FileName != "sample-1.bin")
                    throw new IOException("Fail-fast synthetic fetch did not preserve actual native settlement result.");
            } finally { first.Dispose(); }
            using var released = await HydrationCacheConcurrency.AcquireAsync(root, "second", default, exclusive: true, testTimeout: TimeSpan.FromSeconds(2));
        }
        Console.WriteLine("PASS synthetic native settlement records actual returns and thrown calls with a fixed bound.");
    }
}
#endif
