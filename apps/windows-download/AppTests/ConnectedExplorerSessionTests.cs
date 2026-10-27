using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

internal static class ConnectedExplorerSessionTests
{
    internal static async Task Run()
    {
        var count = 0;
        await SelectionAndFrozenReopen(); count++;
        await ForeignPersonAndOfflineRemoval(); count++;
        await OwnershipRefusals(); count++;
        await FailedStartRetainsCleanup(); count++;
        await CancelLogin(); count++;
        await CancelCapture(); count++;
        await LateLoginNeverActivates(); count++;
        await RuntimeRevalidation(); count++;
        await CancelEngineDefaultTokenRead(); count++;
        await DurableRemovalBeforeProfileCreation(); count++;
        await CachedReconnect(); count++;
        await UpdateIdentityBinding(); count++;
        Console.WriteLine($"Connected Explorer coordinator: {count}/12 isolated cases passed; fake sources/engines only, no browser, HTTP or native registration.");
    }

    private static async Task UpdateIdentityBinding()
    {
        await using var fixture = new Fixture();
        var session = fixture.Create();
        await Refuses(async () => { _ = await session.GetUpdateBindingAsync(); });
        Check(fixture.Backends == 0 && fixture.SignIns == 0 && fixture.Captures == 0, "update identity cannot construct or sign into a disconnected source");
        await session.StartAsync();
        var before = File.ReadAllBytes(fixture.IndexPath);
        var signs = fixture.SignIns; var captures = fixture.Captures;
        var binding = await session.GetUpdateBindingAsync();
        Check(binding == new ConnectedExplorerUpdateBinding("pilot", "portal", Fixture.PersonA) &&
            fixture.SignIns == signs && fixture.Captures == captures && before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
            "update identity checks the selected account without login, recapture or index mutation");
        await session.PauseAsync();
        Check(await session.GetUpdateBindingAsync() == binding, "a paused connected source retains the same verified update identity");
        fixture.Person = Fixture.PersonB;
        await Refuses(async () => { _ = await session.GetUpdateBindingAsync(); });
        Check(session.State == ExplorerPreviewState.Failed && fixture.SignIns == signs && fixture.Captures == captures &&
            before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)), "a changed account cannot export the old identity or rewrite its saved ownership");
    }

    private static async Task SelectionAndFrozenReopen()
    {
        await using var fixture = new Fixture();
        var first = fixture.Create();
        Check(fixture.Backends == 0 && fixture.SignIns == 0 && fixture.Captures == 0 && fixture.EngineStarts == 0, "construction performs no backend/auth/capture/start");
        await first.StartAsync();
        Check(first.State == ExplorerPreviewState.Running && fixture.Backends == 1 && fixture.SignIns == 1 && fixture.Captures == 1, "one explicit source signs in and captures");
        var text = File.ReadAllText(fixture.IndexPath);
        Check(!text.Contains("https://", StringComparison.Ordinal) && !text.Contains("odqr1_", StringComparison.Ordinal) && !text.Contains("token", StringComparison.OrdinalIgnoreCase), "index contains no URLs/resource references/tokens");
        await first.PauseAsync(); await first.ResumeAsync();
        Check(fixture.SignIns == 1 && fixture.EnginePauses == 1 && fixture.EngineResumes == 1, "resume uses cached session only");
        await first.DisposeAsync();
        Check(fixture.Log.IndexOf("engine-dispose") < fixture.Log.IndexOf("backend-dispose"), "native owner drains before backend");
        var before = fixture.Captures; var authBefore = fixture.SignIns; var backendBefore = fixture.Backends;
        var reopened = fixture.Create();
        Check(fixture.Backends == backendBefore && fixture.SignIns == authBefore, "frozen constructor is offline");
        await reopened.StartAsync();
        Check(fixture.Captures == before && fixture.SignIns == authBefore + 1, "frozen ready generation reconnects without recapture");
        await reopened.RemoveAsync();
        fixture.Version = "new-version";
        await reopened.StartAsync();
        Check(fixture.Captures == before + 1, "only explicit removal permits fresh capture/version generation");
        await using (var empty = new Fixture { EmptyInventory = true }) {
            var connectedEmpty = empty.Create(); await connectedEmpty.StartAsync();
            Check(connectedEmpty.State == ExplorerPreviewState.Running && connectedEmpty.InventoryEmpty &&
                connectedEmpty.Activity.Any(line => line.Contains("no folders or files", StringComparison.Ordinal)),
                "authorized empty source connects with an explicit empty-sharing explanation instead of a failure");
        }
        foreach (var wrong in new[] { "alias", "origin", "multiple" }) {
            await using var refused = new Fixture { WrongConfiguration = wrong };
            var session = refused.Create();
            await Refuses(session.StartAsync);
            Check(refused.SignIns == 0 && refused.Captures == 0 && refused.EngineStarts == 0, "invalid selected source refuses before browser/capture");
            await session.RemoveAsync();
            Check(refused.BackendDisposals == 1, "failed pre-index connection still disposes backend on Remove");
        }
    }

    private static async Task ForeignPersonAndOfflineRemoval()
    {
        await using var fixture = new Fixture();
        var first = fixture.Create(); await first.StartAsync(); await first.DisposeAsync();
        var original = File.ReadAllBytes(fixture.IndexPath);
        fixture.Person = Fixture.PersonB;
        var second = fixture.Create();
        await Refuses(second.StartAsync);
        Check(original.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)), "foreign principal cannot overwrite cleanup index");
        Check(fixture.Captures == 1 && fixture.EngineStarts == 1, "foreign account never captures or starts another root");
        await second.DisposeAsync();
        var backendBefore = fixture.Backends; var authBefore = fixture.SignIns; var requestsBefore = fixture.Requests;
        fixture.ThrowIfBackendCreated = true;
        var cleanup = fixture.Create(); await cleanup.RemoveAsync();
        Check(cleanup.State == ExplorerPreviewState.Removed && fixture.Backends == backendBefore && fixture.SignIns == authBefore && fixture.Requests == requestsBefore,
            "startup Remove needs no backend/helper/session/metadata/byte calls");
    }

    private static async Task OwnershipRefusals()
    {
        await using (var fixture = new Fixture()) {
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.IndexPath)!);
            var marker = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, "foreign.txt"); await File.WriteAllTextAsync(marker, "retain");
            var refused = fixture.Create(); await Refuses(refused.StartAsync); await Refuses(refused.RemoveAsync);
            Check(fixture.Backends == 0 && File.ReadAllText(marker) == "retain" && !File.Exists(fixture.IndexPath), "unowned index directory is not adopted");
        }
        await using (var fixture = new Fixture()) {
            var session = fixture.Create(); await session.StartAsync(); await session.DisposeAsync();
            var bytes = File.ReadAllBytes(fixture.IndexPath);
            var otherOrigin = fixture.Create(new Uri("https://other.invalid"));
            await Refuses(otherOrigin.StartAsync); await Refuses(otherOrigin.RemoveAsync);
            Check(bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)) && fixture.SignIns == 1, "origin drift cannot adopt or rewrite saved connection");
        }
    }

    private static async Task FailedStartRetainsCleanup()
    {
        await using var fixture = new Fixture { FailEngineStart = true };
        var session = fixture.Create(); await Refuses(session.StartAsync);
        Check(File.Exists(fixture.IndexPath) && session.State == ExplorerPreviewState.Failed, "cleanup index is durable before native Start attempt");
        Check(session.Activity.Any(line => line.Contains("ownership review", StringComparison.OrdinalIgnoreCase)) &&
            !session.Activity.Any(line => line.Contains("private-fixture-detail", StringComparison.Ordinal)),
            "local setup failure supplies safe next action without arbitrary exception text");
        var requests = fixture.Requests; var signs = fixture.SignIns;
        await session.RemoveAsync();
        Check(session.State == ExplorerPreviewState.Removed && fixture.Requests == requests && fixture.SignIns == signs, "failed setup is removable without authentication");
    }

    private static async Task CancelLogin()
    {
        await using var fixture = new Fixture { HoldLogin = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.LoginEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var closing = session.DisposeAsync().AsTask();
        await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
        Check(fixture.Captures == 0 && fixture.EngineStarts == 0 && fixture.BackendDisposals == 1 && !File.Exists(fixture.IndexPath),
            "quit cancels browser helper before capture/start and drains backend");
    }
    private static async Task CancelCapture()
    {
        await using var fixture = new Fixture { HoldCapture = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.CaptureEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var closing = session.DisposeAsync().AsTask();
        await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
        Check(fixture.EngineStarts == 0 && fixture.BackendDisposals == 1 && !File.Exists(fixture.IndexPath), "quit cancels capture before index/native publication");
    }
    private static async Task LateLoginNeverActivates()
    {
        await using var fixture = new Fixture { HoldLogin = true, IgnoreLoginCancellation = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.LoginEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var closing = session.DisposeAsync().AsTask();
        Check(!closing.IsCompleted, "ownership waits for late helper completion");
        fixture.LoginRelease.TrySetResult();
        await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
        Check(fixture.Captures == 0 && fixture.EngineStarts == 0 && fixture.BackendDisposals == 1, "late cancelled sign-in cannot activate Explorer");
    }

    private static async Task RuntimeRevalidation()
    {
        foreach (var failure in new[] { "expiry", "person", "role" }) {
            await using var fixture = new Fixture();
            var session = fixture.Create(); await session.StartAsync(); var signs = fixture.SignIns;
            if (failure == "expiry") fixture.Expired = true;
            if (failure == "person") fixture.Person = Fixture.PersonB;
            if (failure == "role") fixture.AccessDenied = true;
            await Refuses(session.RecheckSessionAsync);
            Check(session.State == ExplorerPreviewState.Failed && fixture.EnginePauses == 1 && fixture.SignIns == signs, "runtime loss pauses provider without browser sign-in");
        }
        await using var held = new Fixture();
        var current = held.Create(); await current.StartAsync(); held.HoldCurrent = true;
        var recheck = current.RecheckSessionAsync(); await held.CurrentEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var stop = current.DisposeAsync().AsTask();
        await Cancelled(recheck); await stop.WaitAsync(TimeSpan.FromSeconds(3));
        Check(held.BackendDisposals == 1, "quit cancels a cached metadata recheck too");
    }

    private static async Task CancelEngineDefaultTokenRead()
    {
        await using var fixture = new Fixture { HoldEngineSession = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.EngineSessionEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        try {
            var closing = session.DisposeAsync().AsTask();
            await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
            Check(fixture.EngineStarts == 1 && fixture.NativeActivations == 0 && fixture.BackendDisposals == 1,
                "quit cancels engine default-token cached read before native activation/backend disposal");
            Check(fixture.Log.IndexOf("engine-dispose") < fixture.Log.IndexOf("backend-dispose"), "engine drain still precedes backend release after cancellation");
        } finally { fixture.EngineSessionRelease.TrySetResult(); }

        await using var retryFixture = new Fixture { FailFirstRunningDispose = true, VerifyEngineSession = true };
        var retry = retryFixture.Create(); await retry.StartAsync();
        var oldSource = retryFixture.StartedSources.Single();
        await Refuses(() => retry.DisposeAsync().AsTask());
        Check(retryFixture.BackendDisposals == 0, "uncertain engine drain retains its backend");
        await retry.StartAsync();
        Check(retry.State == ExplorerPreviewState.Running && retryFixture.SignIns == 2 && retryFixture.Captures == 1,
            "explicit retry creates a fresh cancellation generation and reopens the frozen inventory");
        await Cancelled(oldSource.GetSessionAsync());
    }

    private static async Task DurableRemovalBeforeProfileCreation()
    {
        await using (var fixture = new Fixture { FailEngineBeforeProfile = true }) {
            var first = fixture.Create(); await Refuses(first.StartAsync); await first.DisposeAsync();
            var bytes = File.ReadAllBytes(fixture.IndexPath); var backends = fixture.Backends;
            var ambiguous = fixture.Create();
            Check(ambiguous.State == ExplorerPreviewState.Failed, "missing receipt plus existing index requires ownership review");
            await Refuses(ambiguous.StartAsync); await Refuses(ambiguous.RemoveAsync);
            Check(fixture.Backends == backends && bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                "ambiguous missing profile never authenticates, recaptures, removes or publishes cleanup confirmation");
        }
        await using (var fixture = new Fixture { FailEnginePreparedAuth = true }) {
            var first = fixture.Create(); await Refuses(first.StartAsync);
            Check(File.Exists(fixture.IndexPath) && fixture.NativeActivations == 0, "prepared preflight failure retains positive cleanup receipt without activation");
            await first.RemoveAsync(); await first.DisposeAsync();
            Check(JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!["Removed"]!.GetValue<bool>(), "confirmed prepared-profile removal publishes durable confirmation");
            fixture.ForgetRemovedProfiles();
            fixture.FailEnginePreparedAuth = false; fixture.Person = Fixture.PersonB;
            var reopened = fixture.Create();
            Check(reopened.State == ExplorerPreviewState.Removed, "restarted missing profile restores confirmed removal");
            await reopened.StartAsync(); await reopened.DisposeAsync();
            var current = JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!;
            Check(reopened.State == ExplorerPreviewState.NotStarted && current["PrincipalId"]!.GetValue<string>() == Fixture.PersonB &&
                !current["Removed"]!.GetValue<bool>() && fixture.NativeActivations == 1,
                "new account can connect after durable missing-profile removal and resets confirmation");

            current["Removed"] = true; File.WriteAllText(fixture.IndexPath, current.ToJsonString());
            var contradictory = File.ReadAllBytes(fixture.IndexPath); var backends = fixture.Backends;
            fixture.ThrowIfBackendCreated = true;
            var refused = fixture.Create();
            Check(refused.State == ExplorerPreviewState.Failed, "removed index plus frozen active profile fails ownership validation");
            await Refuses(refused.StartAsync); await Refuses(refused.RemoveAsync);
            Check(fixture.Backends == backends && contradictory.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                "contradictory removal never authenticates or rewrites retained ownership");
        }
        await using (var fixture = new Fixture()) {
            var first = fixture.Create(); await first.StartAsync(); await first.RemoveAsync(); await first.DisposeAsync();
            var current = JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!;
            // Simulate a crash after the engine's durable Removed phase, before the coordinator index publication.
            current.AsObject().Remove("Removed"); File.WriteAllText(fixture.IndexPath, current.ToJsonString());
            fixture.Person = Fixture.PersonB;
            var reopened = fixture.Create();
            Check(reopened.State == ExplorerPreviewState.Removed, "engine durable removal remains positive evidence with legacy absent index flag");
            await reopened.StartAsync();
            Check(reopened.State == ExplorerPreviewState.Running && fixture.Captures == 2, "engine-confirmed removal permits another account and fresh inventory");
        }
    }

    private static async Task CachedReconnect()
    {
        await using (var fixture = new Fixture()) {
            var first = fixture.Create(); await first.StartAsync(); await first.PauseAsync(); await first.DisposeAsync();
            var bytes = File.ReadAllBytes(fixture.IndexPath); var signs = fixture.SignIns; var captures = fixture.Captures;
            var restored = fixture.Create();
            Check(restored.CanReconnectCached, "validated disconnected frozen connection exposes cached reconnect capability");
            await restored.ReconnectCachedAsync();
            Check(restored.State == ExplorerPreviewState.Paused && fixture.SignIns == signs && fixture.Captures == captures &&
                bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                "fresh coordinator cached reconnect preserves frozen inventory/paused state with no login, capture or index publication");
            await restored.DisposeAsync();
            foreach (var failure in new[] { "expired", "person", "role" }) {
                fixture.Expired = failure == "expired"; fixture.Person = failure == "person" ? Fixture.PersonB : Fixture.PersonA;
                fixture.AccessDenied = failure == "role";
                var starts = fixture.EngineStarts; var denied = fixture.Create(); await Refuses(denied.ReconnectCachedAsync);
                Check(fixture.SignIns == signs && fixture.Captures == captures && fixture.EngineStarts == starts &&
                    bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                    "cached authorization loss cannot sign in, activate, capture or replace the saved principal");
                await denied.DisposeAsync();
            }
            fixture.ThrowIfBackendCreated = true;
            var offline = fixture.Create(); await offline.RemoveAsync();
            Check(offline.State == ExplorerPreviewState.Removed, "failed cached checks retain exact offline cleanup");
            var backends = fixture.Backends; var removed = fixture.Create(); await Refuses(removed.ReconnectCachedAsync);
            Check(fixture.Backends == backends, "removed generation refuses cached reconnect before backend creation");
        }
        foreach (var kind in new[] { "absent", "prepared", "missing", "corrupt" }) {
            await using var fixture = new Fixture { FailEnginePreparedAuth = kind == "prepared", FailEngineBeforeProfile = kind == "missing" };
            if (kind != "absent") {
                var seed = fixture.Create();
                if (kind == "corrupt") { await seed.StartAsync(); await seed.DisposeAsync(); File.WriteAllText(fixture.IndexPath, "{}"); }
                else { await Refuses(seed.StartAsync); await seed.DisposeAsync(); }
            }
            var before = File.Exists(fixture.IndexPath) ? File.ReadAllBytes(fixture.IndexPath) : null;
            var backends = fixture.Backends; fixture.ThrowIfBackendCreated = true;
            var refused = fixture.Create();
            Check(!refused.CanReconnectCached, "absent/incomplete/ambiguous/corrupt ownership never exposes the settings reconnect capability");
            await Refuses(refused.ReconnectCachedAsync);
            Check(fixture.Backends == backends && (before is null ? !File.Exists(fixture.IndexPath) : before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath))),
                "absent/incomplete/ambiguous/corrupt cache refuses before backend and leaves ownership unchanged");
        }
        await using (var fixture = new Fixture()) {
            var seed = fixture.Create(); await seed.StartAsync(); await seed.DisposeAsync();
            var signs = fixture.SignIns; fixture.HoldCurrent = true;
            var restored = fixture.Create(); var reconnect = restored.ReconnectCachedAsync();
            await fixture.CurrentEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var closing = restored.DisposeAsync().AsTask(); await Cancelled(reconnect); await closing.WaitAsync(TimeSpan.FromSeconds(3));
            Check(fixture.SignIns == signs && fixture.EngineStarts == 1 && fixture.Captures == 1 && fixture.BackendDisposals == 2,
                "quit cancels cached reconnect metadata without browser, capture or activation and drains backend");
        }
    }

    private static async Task Refuses(Func<Task> action)
    {
        try { await action().WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (Exception error) when (error is AccessDeniedException or IOException or LoginRequiredException) { return; }
        throw new InvalidOperationException("Expected a fail-closed connection refusal.");
    }
    private static async Task Cancelled(Task action)
    {
        try { await action.WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (OperationCanceledException) { return; }
        throw new InvalidOperationException("Expected a cancelled pending connection action.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    private sealed class Fixture : IAsyncDisposable
    {
        internal static readonly string PersonA = "odqp1_" + new string('a', 64), PersonB = "odqp1_" + new string('b', 64);
        private readonly string root = Path.Combine(Path.GetTempPath(), "ltfiles-connected-coordinator-" + Guid.NewGuid().ToString("N"));
        private readonly Dictionary<string, Saved> profiles = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<ConnectedExplorerSession> sessions = [];
        internal readonly List<string> Log = [];
        internal readonly List<IQueuedDownloadSource> StartedSources = [];
        internal string Person = PersonA, Version = "version-one", WrongConfiguration = "";
        internal bool HoldLogin, HoldCapture, HoldCurrent, HoldEngineSession, HoldSourceSession, IgnoreLoginCancellation, Expired, AccessDenied, FailEngineStart, ThrowIfBackendCreated, EmptyInventory,
            FailFirstRunningDispose, RunningDisposeRefused, VerifyEngineSession, FailEngineBeforeProfile, FailEnginePreparedAuth;
        internal int Backends, SignIns, Captures, EngineStarts, EnginePauses, EngineResumes, BackendDisposals, Requests, NativeActivations;
        internal readonly TaskCompletionSource LoginEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), LoginRelease = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CaptureEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), CaptureRelease = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CurrentEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), CurrentRelease = new(TaskCreationOptions.RunContinuationsAsynchronously),
            EngineSessionEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), EngineSessionRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string IndexPath => Path.Combine(root, "State", "connected-explorer-pilot-portal", "current.json");
        private static readonly Uri Origin = new("https://coordinator.invalid");
        internal Fixture() => Directory.CreateDirectory(root);
        internal void ForgetRemovedProfiles()
        {
            if (profiles.Values.Any(profile => !profile.Removed)) throw new InvalidOperationException("Only confirmed removed test profiles may be forgotten.");
            profiles.Clear();
        }
        internal ConnectedExplorerSession Create(Uri? origin = null)
        {
            var session = new ConnectedExplorerSession(() => {
                if (ThrowIfBackendCreated) throw new InvalidOperationException("No backend may be created for offline cleanup.");
                Backends++; return new Backend(this);
            }, "pilot", "portal", origin ?? Origin, Path.Combine(root, "State"), Path.Combine(root, "Files"), CreateEngine, Capture);
            sessions.Add(session); return session;
        }
        private ConnectedExplorerEngine CreateEngine(ConnectedExplorerEngineRequest request)
        {
            profiles.TryGetValue(request.ProfileDirectory, out var saved);
            var fake = new FakeEngine(this, request, saved);
            return new(fake, () => request.InitialManifest ?? (saved?.Removed == false ? saved.Manifest : null),
                () => profiles.ContainsKey(request.ProfileDirectory));
        }
        private async Task<ExplorerCatalogSnapshot> Capture(IFilesBackend backend, string channel, string expected, CancellationToken token)
        {
            Captures++; CaptureEntered.TrySetResult();
            if (HoldCapture) await CaptureRelease.Task.WaitAsync(token);
            var source = backend.Sources.Single();
            if (EmptyInventory) return new(expected, channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority),
                new Dictionary<string, PlaceholderIdentity>(), []);
            var id = new PlaceholderIdentity(channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), expected,
                "odqr1_reference", "ondf1_" + new string('c', 64), Version, "sample.txt", 0, "\"etag\"", new string('d', 64));
            return new(expected, channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority),
                new Dictionary<string, PlaceholderIdentity> { ["sample.txt"] = id }, []);
        }
        private DateTimeOffset Expiry => DateTimeOffset.UtcNow.AddHours(Expired ? -1 : 1);
        private sealed class Backend : IFilesBackend
        {
            private readonly Fixture fixture;
            private bool disposed;
            internal Backend(Fixture fixture)
            {
                this.fixture = fixture; Session = new Gateway(fixture); Catalog = new Catalog();
                var source = new Source(fixture);
                Sources = fixture.WrongConfiguration == "multiple" ? [source, source] : [source];
            }
            public ISessionGateway Session { get; }
            public IFileCatalog Catalog { get; }
            public IReadOnlyList<IQueuedDownloadSource> Sources { get; }
            public string StateDirectory => Path.Combine(fixture.root, "unused-queue");
            public ValueTask DisposeAsync() { if (!disposed) { disposed = true; fixture.BackendDisposals++; fixture.Log.Add("backend-dispose"); } return ValueTask.CompletedTask; }
        }
        private sealed class Gateway(Fixture fixture) : ISessionGateway
        {
            public async Task SignInAsync(CancellationToken cancellationToken = default)
            {
                fixture.SignIns++; fixture.LoginEntered.TrySetResult();
                if (fixture.HoldLogin) {
                    if (fixture.IgnoreLoginCancellation) await fixture.LoginRelease.Task;
                    else await fixture.LoginRelease.Task.WaitAsync(cancellationToken);
                }
            }
            public async Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default)
            {
                fixture.Requests++;
                if (fixture.HoldCurrent) { fixture.CurrentEntered.TrySetResult(); await fixture.CurrentRelease.Task.WaitAsync(cancellationToken); }
                if (fixture.AccessDenied) throw new AccessDeniedException();
                return new(fixture.Person, fixture.Expiry);
            }
        }
        private sealed class Source(Fixture fixture) : IQueuedDownloadSource
        {
            public string Alias => fixture.WrongConfiguration == "alias" ? "employee" : "portal";
            public Uri Origin => fixture.WrongConfiguration == "origin" ? new("https://wrong.invalid") : Fixture.Origin;
            public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
            {
                fixture.Requests++; cancellationToken.ThrowIfCancellationRequested();
                if (fixture.HoldSourceSession) { fixture.EngineSessionEntered.TrySetResult(); await fixture.EngineSessionRelease.Task.WaitAsync(cancellationToken); }
                if (fixture.AccessDenied) throw new AccessDeniedException();
                return new QueuedDownloadSession(fixture.Person, fixture.Expiry);
            }
            public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new InvalidOperationException("No source resolution in coordinator fake tests.");
            public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("No byte transfers in coordinator fake tests.");
        }
        private sealed class Catalog : IFileCatalog
        {
            public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default) => throw new InvalidOperationException();
            public Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
            public Task<CatalogListing> ListAsync(CatalogNode folder, object? more = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
            public Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
        }
        private sealed class Saved(ExplorerRootManifest manifest) { internal ExplorerRootManifest Manifest = manifest; internal bool Removed, Failed, Paused; }
        private sealed class FakeEngine : IExplorerPreviewSession
        {
            private readonly Fixture fixture; private readonly ConnectedExplorerEngineRequest request; private Saved? saved; private bool disposed;
            internal FakeEngine(Fixture fixture, ConnectedExplorerEngineRequest request, Saved? saved)
            { this.fixture = fixture; this.request = request; this.saved = saved; State = saved?.Removed == true ? ExplorerPreviewState.Removed : saved?.Failed == true ? ExplorerPreviewState.Failed : ExplorerPreviewState.NotStarted; }
            public string RootPath => request.PreferredRoot;
            public ExplorerPreviewState State { get; private set; }
            public IReadOnlyList<string> Activity => [];
            public event EventHandler? Changed;
            public async Task StartAsync()
            {
                fixture.EngineStarts++;
                fixture.StartedSources.Add(request.Source);
                if (fixture.FailEngineBeforeProfile) throw new LoginRequiredException();
                var frozen = request.InitialManifest ?? saved?.Manifest ?? throw new IOException("No frozen inventory.");
                var paused = saved is { Removed: false, Paused: true };
                saved = new(frozen) { Paused = paused }; fixture.profiles[request.ProfileDirectory] = saved;
                if (fixture.FailEnginePreparedAuth) { saved.Failed = true; State = ExplorerPreviewState.Failed; throw new LoginRequiredException(); }
                if (fixture.HoldEngineSession) {
                    fixture.HoldSourceSession = true;
                }
                if (fixture.HoldEngineSession || fixture.VerifyEngineSession)
                    await request.Source.GetSessionAsync(); // Deliberately no caller token, matching the root engine's cached preflight.
                if (fixture.FailEngineStart) { saved.Failed = true; State = ExplorerPreviewState.Failed; throw new IOException("private-fixture-detail: synthetic partial setup."); }
                fixture.NativeActivations++;
                State = saved.Paused ? ExplorerPreviewState.Paused : ExplorerPreviewState.Running; Changed?.Invoke(this, EventArgs.Empty);
            }
            public Task PauseAsync() { fixture.EnginePauses++; if (saved is not null) saved.Paused = true; State = ExplorerPreviewState.Paused; Changed?.Invoke(this, EventArgs.Empty); return Task.CompletedTask; }
            public Task ResumeAsync() { fixture.EngineResumes++; if (saved is not null) saved.Paused = false; State = ExplorerPreviewState.Running; Changed?.Invoke(this, EventArgs.Empty); return Task.CompletedTask; }
            public Task RemoveAsync() { if (saved is not null) saved.Removed = true; State = ExplorerPreviewState.Removed; fixture.Log.Add("engine-remove"); Changed?.Invoke(this, EventArgs.Empty); return Task.CompletedTask; }
            public ValueTask DisposeAsync()
            {
                if (!disposed) {
                    if (fixture.FailFirstRunningDispose && !fixture.RunningDisposeRefused && State == ExplorerPreviewState.Running) {
                        fixture.RunningDisposeRefused = true; throw new IOException("Synthetic uncertain running-engine disposal.");
                    }
                    disposed = true; fixture.Log.Add("engine-dispose");
                }
                return ValueTask.CompletedTask;
            }
        }
        public async ValueTask DisposeAsync()
        {
            LoginRelease.TrySetResult(); CaptureRelease.TrySetResult(); CurrentRelease.TrySetResult(); EngineSessionRelease.TrySetResult();
            foreach (var session in sessions) await session.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()) + "ltfiles-connected-coordinator-", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Refusing unexpected coordinator test cleanup path.");
            Directory.Delete(full, true);
        }
    }
}
