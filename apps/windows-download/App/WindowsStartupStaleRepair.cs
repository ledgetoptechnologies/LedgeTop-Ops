using System.Runtime.Versioning;
using System.Diagnostics;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

// A stale startup command is only a candidate until both installed payloads
// have been verified and held open. Existing gates exclude installers and
// updaters in this session; legacy writers in other sessions and unrelated
// registry writers do not honor these gates, and Registry has no external CAS.
internal static class WindowsStartupStaleRepair
{
    internal const string Argument = "--repair-stale-startup-v1";
    internal static (string Version, string Source)? Parse(IReadOnlyList<string> args)
    {
        if (args.Count != 3 || args[0] != Argument || args[2] is not ("employee" or "portal")) return null;
        var parts = args[1].Split('.');
        if (parts.Length != 4 || parts.Any(part => !ushort.TryParse(part, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var value) || value.ToString(System.Globalization.CultureInfo.InvariantCulture) != part)) return null;
        return (args[1], args[2]);
    }

    internal static (string Version, string Source)? Candidate(WindowsStartupRunValue? value, string versionsDirectory)
    {
        if (!WindowsStartupPolicy.RecognizedCommandShape(value) || value?.Text is not { } text) return null;
        var quote = text.IndexOf('"', 1);
        var executable = text[1..quote];
        var source = text.EndsWith(" employee", StringComparison.Ordinal) ? "employee" : "portal";
        var versionDirectory = Path.GetDirectoryName(executable);
        var version = Path.GetFileName(versionDirectory);
        if (versionDirectory is null || version is null || Path.GetDirectoryName(versionDirectory) != versionsDirectory ||
            Path.GetFileName(executable) != "LedgeTop.Files.exe") return null;
        return Parse([Argument, version, source]);
    }

    // Explorer owns and joins this operation through its existing startup-setting
    // lifecycle. Run payload verification off the dispatcher; Quit cancels the
    // token and waits for completion, including any already-committed write.
    internal static async Task<WindowsStartupState> BeforeStartupReadAsync(Func<CancellationToken, Task> repair,
        Func<Task<WindowsStartupState>> read, CancellationToken token)
    {
        await Task.Run(() => repair(token), token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        return await read().ConfigureAwait(false);
    }

    [SupportedOSPlatform("windows")]
    internal static async Task TryAutomaticAsync(CancellationToken token)
    {
        try {
            using var gate = AcquireExclusion();
            if (gate is null) return;
            var store = new WindowsStartupRegistryStore();
            var versionsDirectory = Path.GetDirectoryName(ExeUpdateWindowsTrust.Target("0.0.0.0")) ?? throw new IOException();
            var candidate = Candidate(store.Read(), versionsDirectory);
            if (candidate is null) return;
            var old = Path.Combine(ExeUpdateWindowsTrust.Target(candidate.Value.Version), "LedgeTop.Files.exe");
            _ = await TryRepairAsync(new WindowsStartupOwnershipReader(), new OlderPayloadReader(), store, old, candidate.Value.Source, token).ConfigureAwait(false);
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { /* Startup repair is optional; unverified or changed values are retained. */ }
    }

    internal static Task<int> RunGuardedAsync(IReadOnlyList<string> args, Func<IDisposable?> enter,
        Func<string, string, Task<int>> action)
    {
        var parsed = Parse(args);
        return parsed is null ? Task.FromResult(20) : UnderExclusionAsync(enter, () => action(parsed.Value.Version, parsed.Value.Source));
    }
    internal static async Task<int> UnderExclusionAsync(Func<IDisposable?> enter, Func<Task<int>> action)
    {
        using var gate = enter();
        if (gate is null) return 20;
        return await action().ConfigureAwait(false);
    }
    [SupportedOSPlatform("windows")]
    private static IDisposable? AcquireExclusion()
    {
        using var process = Process.GetCurrentProcess();
        var sid = ExeUpdateWindowsNative.CurrentSid();
        return AcquireNamedExclusion(InstallerActivity.ObjectName,
            ExeUpdateWindowsNative.GateName(sid, process.SessionId, "pilot"), sid);
    }
    [SupportedOSPlatform("windows")]
    internal static IDisposable? AcquireNamedExclusion(string installerName, string updateName, string sid)
    {
        // Setup refuses if this object exists. We hold a handle, not a thread-owned
        // mutex acquisition, so it remains valid across asynchronous continuations.
        var installer = new Mutex(false, installerName, out var created);
        if (!created) { installer.Dispose(); return null; }
        try {
            var update = ExeUpdateWindowsNative.CreateGate(updateName, sid);
            if (update is null) { installer.Dispose(); return null; }
            return new Exclusion(installer, update);
        } catch { installer.Dispose(); throw; }
    }
    private sealed class Exclusion(IDisposable installer, IDisposable update) : IDisposable
    {
        public void Dispose() { update.Dispose(); installer.Dispose(); }
    }
    internal interface IOlderPayloadReader
    {
        Task<IOlderPayload> HoldAsync(string executable, CancellationToken token);
    }
    internal interface IOlderPayload : IAsyncDisposable { Task VerifyStillCurrentAsync(CancellationToken token); }

    internal static async Task<WindowsStartupState> TryRepairAsync(
        IWindowsStartupOwnershipReader currentReader, IOlderPayloadReader olderReader,
        IWindowsStartupRunStore store, string expectedOldExecutable, string source, CancellationToken token)
    {
        try {
            await using var current = await currentReader.ReadAsync(token).ConfigureAwait(false);
            var oldCommand = WindowsStartupPolicy.Command(expectedOldExecutable, source);
            var newCommand = WindowsStartupPolicy.Command(current.ExecutablePath, source);
            var oldVersion = Version.Parse(Path.GetFileName(Path.GetDirectoryName(expectedOldExecutable)) ?? throw new IOException());
            var currentVersion = Version.Parse(Path.GetFileName(Path.GetDirectoryName(current.ExecutablePath)) ?? throw new IOException());
            if (oldVersion >= currentVersion || oldCommand == newCommand || Path.GetDirectoryName(Path.GetDirectoryName(expectedOldExecutable)) !=
                Path.GetDirectoryName(Path.GetDirectoryName(current.ExecutablePath))) return new(WindowsStartupAvailability.Conflict);
            var expected = new WindowsStartupRunValue(WindowsStartupValueKind.String, oldCommand);
            var desired = new WindowsStartupRunValue(WindowsStartupValueKind.String, newCommand);
            var preference = store.ReadPreference();
            if (preference is WindowsStartupPreference.Disabled or WindowsStartupPreference.Invalid || store.Read() != expected)
                return new(WindowsStartupAvailability.Conflict);
            await using var older = await olderReader.HoldAsync(expectedOldExecutable, token).ConfigureAwait(false);
            await older.VerifyStillCurrentAsync(token).ConfigureAwait(false);
            await current.VerifyStillCurrentAsync(token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!store.TryRepair(expected, desired, preference))
                return new(WindowsStartupAvailability.Conflict);
            // The write has committed: observe without cancellation, do not roll back a
            // potentially changed value if ownership or readback is now uncertain.
            await current.VerifyStillCurrentAsync(CancellationToken.None).ConfigureAwait(false);
            await older.VerifyStillCurrentAsync(CancellationToken.None).ConfigureAwait(false);
            if (store.ReadPreference() != preference || store.Read() != desired) return new(WindowsStartupAvailability.Conflict);
            return WindowsStartupPolicy.State(current.ExecutablePath, desired);
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { return new(WindowsStartupAvailability.Error); }
    }

    [SupportedOSPlatform("windows")]
    internal sealed class OlderPayloadReader : IOlderPayloadReader
    {
        public async Task<IOlderPayload> HoldAsync(string executable, CancellationToken token)
            => await HoldVerifiedAsync(executable, ExeUpdateWindowsTrust.Profile().CloudflaredSha256!, token).ConfigureAwait(false);
        internal async Task<IOlderPayload> HoldVerifiedAsync(string executable, string expectedHelperHash, CancellationToken token)
        {
            var root = Path.GetDirectoryName(executable) ?? throw new IOException();
            var version = Path.GetFileName(root);
            if (root != ExeUpdateWindowsTrust.Target(version) || executable != Path.Combine(root, "LedgeTop.Files.exe")) throw new IOException();
            var markerPath = Path.Combine(root, InstalledPayloadVerifier.MarkerName);
            ExeUpdateWindowsNative.NoAliases(markerPath);
            byte[] bytes;
            using (var marker = new FileStream(markerPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                if (marker.Length is <= 0 or > 16384) throw new IOException();
                bytes = new byte[(int)marker.Length]; await marker.ReadExactlyAsync(bytes, token).ConfigureAwait(false);
            }
            var observed = InstalledPayloadVerifier.ParseMarker(bytes);
            return new OldProof(await InstalledPayloadVerifier.VerifyAsync(root, version, observed.SourceCommit,
                observed.PayloadManifestSha256, expectedHelperHash, token).ConfigureAwait(false));
        }
        private sealed class OldProof(VerifiedInstalledPayload payload) : IOlderPayload
        {
            public Task VerifyStillCurrentAsync(CancellationToken token) => payload.RevalidateAsync(token);
            public ValueTask DisposeAsync() => payload.DisposeAsync();
        }
    }
}
