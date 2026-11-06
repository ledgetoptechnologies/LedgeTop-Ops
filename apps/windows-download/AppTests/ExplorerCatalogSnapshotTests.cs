using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

internal static class ExplorerCatalogSnapshotTests
{
    private static readonly string Principal = "odqp1_" + new string('a', 64);
    private static readonly string OtherPrincipal = "odqp1_" + new string('b', 64);
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("Explorer catalog semantic comparison observes changes without treating selector rotation as content", SemanticComparison),
        ("Explorer catalog exhausts root and folder pages and retains empty directories without content URLs", Complete),
        ("Explorer catalog accepts unknown employee size only from fresh verified resolution and supports empty inventory", EmployeeAndEmpty),
        ("Explorer catalog fences changed and expired sessions around awaited metadata", Sessions),
        ("Explorer catalog refuses selected source changes and cancellation after delayed metadata", ConfigurationAndCancellation),
        ("Explorer catalog refuses unsafe names case collisions and folder cycles", NamesAndCycles),
        ("Explorer catalog refuses repeated cursors incomplete pages and excessive enumeration", PagingBounds),
        ("Explorer catalog compares fresh principal name size version origin and integrity pins", ManifestPins),
        ("Explorer catalog enforces entry depth path and native identity limits before integration", InventoryBounds),
        ("Explorer catalog production composition pins cached credentials across capture and disposes on every outcome", ProductionPin),
        ("Explorer catalog capture failures retain only bounded stage reason and HTTP status", FailureCoordinates)
    ];

    private static void Check(bool value) { if (!value) throw new Exception("Explorer catalog snapshot assertion failed."); }
    private static TaskCompletionSource Gate() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static async Task Refuse<T>(Func<Task> action) where T : Exception
    {
        try { await action(); } catch (T) { return; }
        throw new Exception("Expected Explorer catalog refusal: " + typeof(T).Name);
    }
    private static Task<ExplorerCatalogSnapshot> Capture(Backend backend, CancellationToken token = default) =>
        ExplorerCatalogSnapshotBuilder.CaptureAsync(backend, "pilot", Principal, token);

    private static Task SemanticComparison()
    {
        var scope = new ExplorerRootScope("pilot", "portal", "https://source.example.invalid", Principal);
        var id = new PlaceholderIdentity(scope.Channel, scope.Alias, scope.Origin, scope.PrincipalId,
            "odqr1_first", "oef1_" + new string('c', 64), "v1", "photo.jpg", 10, "\"etag\"", new string('d', 64));
        ExplorerRootManifest Manifest(string path, PlaceholderIdentity item, params string[] dirs) =>
            new(scope, new Dictionary<string, PlaceholderIdentity> { [path] = item }, dirs);
        var old = Manifest("Folder\\photo.jpg", id, "Empty");
        var rotated = Manifest("folder\\PHOTO.JPG", id with { ResourceReference = "odqr1_second", FileName = "PHOTO.JPG" }, "empty");
        Check(!CatalogSemanticComparison.Compare(old, rotated).HasDifferences);
        foreach (var next in new[] { id with { LogicalFileId = "oef1_" + new string('e', 64) }, id with { RemoteVersion = "v2" },
            id with { Length = 11 }, id with { ETag = "\"other\"" }, id with { Sha256 = new string('f', 64) } })
            Check(CatalogSemanticComparison.Compare(old, Manifest("Folder\\photo.jpg", next, "Empty")).ChangedFiles == 1);
        var empty = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        var diff = CatalogSemanticComparison.Compare(old, empty);
        Check(diff.MissingFiles == 1 && diff.MissingDirectories == 2 && diff.NewFiles == 0);
        diff = CatalogSemanticComparison.Compare(empty, old);
        Check(diff.NewFiles == 1 && diff.NewDirectories == 2 && diff.MissingFiles == 0);
        foreach (var otherScope in new[] { scope with { PrincipalId = OtherPrincipal }, scope with { Channel = "stable" },
            scope with { Alias = "employee" }, scope with { Origin = "https://other.example.invalid" } }) {
            try { CatalogSemanticComparison.Compare(old, new ExplorerRootManifest(otherScope, new Dictionary<string, PlaceholderIdentity>())); throw new Exception("Different scope accepted."); }
            catch (TransferException) { }
        }
        // Case-only changes to file names, parent directories and empty directory names are not changes.
        Check(!CatalogSemanticComparison.Compare(old, Manifest("FOLDER\\PHOTO.JPG", id with { FileName = "PHOTO.JPG" }, "EMPTY")).HasDifferences);
        try { Manifest("..\\photo.jpg", id); throw new Exception("Malformed path accepted."); }
        catch (TransferException) { }
        try {
            _ = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity> {
                ["Folder\\photo.jpg"] = id, ["folder\\photo.jpg"] = id });
            throw new Exception("Duplicate file path accepted.");
        } catch (TransferException) { }
        return Task.CompletedTask;
    }

    private static async Task FailureCoordinates()
    {
        const string privateDetail = "private-url-name-reference-token";
        TransferException Failure() => new(privateDetail, TransferFailureReason.UnexpectedHttpStatus, 503);
        foreach (var operation in new[] { CatalogCaptureOperation.InitialSession, CatalogCaptureOperation.Sections,
            CatalogCaptureOperation.Roots, CatalogCaptureOperation.FolderListing, CatalogCaptureOperation.FileReference,
            CatalogCaptureOperation.FileResolution, CatalogCaptureOperation.FinalSession }) {
            var b = new Backend(); var file = b.Add("file", "photo.jpg");
            b.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [file]));
            if (operation == CatalogCaptureOperation.InitialSession) b.Gateway.BeforeProbe = _ => throw Failure();
            if (operation == CatalogCaptureOperation.Sections) b.CatalogImpl.SectionFailure = Failure();
            if (operation == CatalogCaptureOperation.Roots) b.CatalogImpl.Roots = (_, _) => throw Failure();
            if (operation == CatalogCaptureOperation.FolderListing) b.CatalogImpl.List = (_, _) => throw Failure();
            if (operation == CatalogCaptureOperation.FileReference) b.CatalogImpl.ReferenceFailure = Failure();
            if (operation == CatalogCaptureOperation.FileResolution) b.Source.ResolveFailure = Failure();
            if (operation == CatalogCaptureOperation.FinalSession) b.Gateway.BeforeProbe = n => { if (n == 2) throw Failure(); };
            try { await Capture(b); throw new Exception("Missing failure coordinate."); }
            catch (CatalogCaptureException error) {
                Check(error.Operation == operation && error.Boundary == (operation is CatalogCaptureOperation.InitialSession or CatalogCaptureOperation.FinalSession
                    ? CatalogCaptureBoundary.BeforeSession : CatalogCaptureBoundary.MetadataRequest));
                Check(error.Reason == TransferFailureReason.UnexpectedHttpStatus && error.HttpStatus == 503 && error.InnerException is null);
                Check(!error.Message.Contains(privateDetail, StringComparison.Ordinal) && !error.SupportCode.Contains(privateDetail, StringComparison.Ordinal));
            }
            Check(b.Source.Downloads == 0 && b.Gateway.SignIns == 0);
        }
        foreach (var after in new[] { false, true }) {
            var b = new Backend(); b.Source.BeforeSession = n => { if (n == (after ? 4 : 3)) throw Failure(); };
            try { await Capture(b); throw new Exception("Missing session boundary."); }
            catch (CatalogCaptureException error) {
                Check(error.Operation == CatalogCaptureOperation.Roots && error.Boundary == (after ? CatalogCaptureBoundary.AfterSession : CatalogCaptureBoundary.BeforeSession));
            }
        }
        var invalid = new Backend(); invalid.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([invalid.Node("root", "CON", NodeKind.Root)]));
        try { await Capture(invalid); throw new Exception("Unsafe name admitted."); }
        catch (CatalogCaptureException error) { Check(error.Operation == CatalogCaptureOperation.Roots && error.Boundary == CatalogCaptureBoundary.ValidateInventory && error.Reason == TransferFailureReason.InvalidMetadata && error.HttpStatus is null); }
        foreach (var authority in new Exception[] { new AccessDeniedException(), new LoginRequiredException(), new ResourceUnavailableException(), new OperationCanceledException() }) {
            var b = new Backend(); b.CatalogImpl.Roots = (_, _) => throw authority;
            try { await Capture(b); throw new Exception("Authority/cancellation was swallowed."); }
            catch (Exception error) when (ReferenceEquals(error, authority)) { }
        }
        var pinBackend = new Backend();
        var settings = new LiveSettings(new Uri("https://source.example.invalid/deliveries"), null, Path.Combine(Path.GetTempPath(), "unused.exe"), new string('a', 64));
        await using var live = new LiveBackend(settings, "not-used-no-filesystem", AccessMode.Client,
            (_, _) => new(pinBackend.Gateway, pinBackend.CatalogImpl, pinBackend.Source, () => { }, _ => throw Failure()));
        try { await ExplorerCatalogSnapshotBuilder.CaptureAsync(live, "pilot", Principal); throw new Exception("Missing pin failure coordinate."); }
        catch (CatalogCaptureException error) { Check(error.Operation == CatalogCaptureOperation.SessionPin && error.Boundary == CatalogCaptureBoundary.MetadataRequest && error.HttpStatus == 503); }
        Check(pinBackend.Gateway.Probes == 0 && pinBackend.CatalogImpl.RootCalls == 0 && pinBackend.Source.Resolutions == 0);
    }

    private static async Task Complete()
    {
        var b = new Backend();
        var one = b.Add("one", "one.txt"); var two = b.Add("two", "two.txt"); var three = b.Add("three", "three.txt");
        var a = b.Node("root-a", "Alpha", NodeKind.Root); var z = b.Node("root-z", "Zulu", NodeKind.Root);
        var nested = b.Node("nested", "Nested", NodeKind.Folder); var empty = b.Node("empty", "Empty", NodeKind.Folder);
        b.CatalogImpl.Roots = (_, more) => Task.FromResult(more is null ? new NodePage([a], "root-next") : new NodePage([z]));
        b.CatalogImpl.List = (node, more) => Task.FromResult(node.Key switch {
            "root-a" when more is null => new CatalogListing([nested, empty], [one], "file-next"),
            "root-a" => new CatalogListing([], [two]),
            "nested" => new CatalogListing([], [three]),
            _ => new CatalogListing([], [])
        });
        var snapshot = await Capture(b);
        Check(snapshot.PrincipalId == Principal && snapshot.Channel == "pilot" && snapshot.Alias == "portal" && snapshot.Origin == "https://source.example.invalid");
        Check(snapshot.Files.Count == 3 && snapshot.Files.Keys.Order().SequenceEqual(new[] { "Alpha\\Nested\\three.txt", "Alpha\\one.txt", "Alpha\\two.txt" }.Order()));
        Check(snapshot.Directories.Order().SequenceEqual(new[] { "Alpha", "Alpha\\Empty", "Alpha\\Nested", "Zulu" }.Order()));
        foreach (var identity in snapshot.Files.Values) Check(PlaceholderIdentity.Decode(identity.Encode()) == identity);
        var serialized = JsonSerializer.Serialize(snapshot);
        Check(!serialized.Contains("/content/", StringComparison.Ordinal) && !serialized.Contains("root-next", StringComparison.Ordinal)
            && !serialized.Contains("file-next", StringComparison.Ordinal) && b.Source.Downloads == 0 && b.Gateway.SignIns == 0);
        Check(b.CatalogImpl.RootCalls == 2 && b.CatalogImpl.ListCalls == 5 && b.Source.Resolutions == 3);
        Check(b.Gateway.Probes == 2); // Do not duplicate the gateway's production source probe for every metadata request.
        await Refuse<NotSupportedException>(() => {
            ((IDictionary<string, PlaceholderIdentity>)snapshot.Files).Add("elsewhere", snapshot.Files.Values.First()); return Task.CompletedTask;
        });
    }

    private static async Task EmployeeAndEmpty()
    {
        var employee = new Backend("employee"); var file = employee.Add("employee-one", "company.txt", sizeUnknown: true);
        employee.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [file]));
        var snapshot = await Capture(employee);
        Check(snapshot.Files.Single().Value.Length > 0 && snapshot.Files.Single().Value.LogicalFileId.StartsWith("oef1_", StringComparison.Ordinal));
        var empty = new Backend(); empty.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([]));
        var none = await Capture(empty); Check(none.Files.Count == 0 && none.Directories.Count == 0 && empty.Source.Resolutions == 0);
        await Refuse<TransferException>(() => ExplorerCatalogSnapshotBuilder.CaptureAsync(empty, "developer", Principal));
        await Refuse<TransferException>(() => ExplorerCatalogSnapshotBuilder.CaptureAsync(empty, "pilot", "not-a-principal"));
        empty.Selected = []; await Refuse<TransferException>(() => Capture(empty));
        empty.Selected = [empty.Source, new Source("employee")]; await Refuse<TransferException>(() => Capture(empty));
    }

    private static async Task Sessions()
    {
        var changed = new Backend(); var entered = Gate(); var release = Gate();
        changed.CatalogImpl.Roots = async (_, _) => { entered.SetResult(); await release.Task; return new NodePage([changed.DefaultRoot]); };
        var capture = Capture(changed); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        changed.Gateway.PrincipalOverride = Principal; // The UI gateway still reports A; source authority changes independently.
        changed.Source.Person = OtherPrincipal; release.SetResult();
        await Refuse<AccessDeniedException>(() => capture);
        Check(changed.Source.Resolutions == 0 && changed.Source.Downloads == 0);

        var expired = new Backend();
        expired.CatalogImpl.List = (_, _) => {
            expired.Source.Expiry = DateTimeOffset.UtcNow;
            return Task.FromResult(new CatalogListing([], []));
        };
        await Refuse<LoginRequiredException>(() => Capture(expired));
        var missing = new Backend(); missing.Gateway.SignedIn = false;
        await Refuse<LoginRequiredException>(() => Capture(missing));
        Check(missing.Gateway.SignIns == 0 && missing.CatalogImpl.RootCalls == 0);

        var gatewayChanged = new Backend();
        gatewayChanged.CatalogImpl.List = (_, _) => {
            gatewayChanged.Gateway.PrincipalOverride = OtherPrincipal; // Source remains A; final gateway must refuse B.
            return Task.FromResult(new CatalogListing([], []));
        };
        await Refuse<AccessDeniedException>(() => Capture(gatewayChanged));
        Check(gatewayChanged.Source.Person == Principal && gatewayChanged.Gateway.Probes == 2);

        var finalAwait = new Backend(); finalAwait.Gateway.PrincipalOverride = Principal;
        finalAwait.Gateway.BeforeProbe = count => { if (count == 2) finalAwait.Source.Person = OtherPrincipal; };
        await Refuse<AccessDeniedException>(() => Capture(finalAwait)); // Post-gateway source fence observes the change.
    }

    private static async Task ConfigurationAndCancellation()
    {
        foreach (var change in new Action<Backend>[] {
            b => b.Source.Alias = "changed", b => b.Source.Origin = new Uri("https://different.example.invalid/"),
            b => b.Selected = [new Source("portal")], b => b.CurrentCatalog = new Catalog(b),
            b => b.CurrentGateway = new Gateway(b.Source)
        }) {
            var b = new Backend();
            b.CatalogImpl.Roots = (_, _) => { change(b); return Task.FromResult(new NodePage([b.DefaultRoot])); };
            await Refuse<CatalogCaptureException>(() => Capture(b)); Check(b.Source.Resolutions == 0);
        }
        var cancelled = new Backend(); using var cancellation = new CancellationTokenSource();
        cancelled.CatalogImpl.Roots = (_, _) => { cancellation.Cancel(); return Task.FromResult(new NodePage([cancelled.DefaultRoot])); };
        await Refuse<OperationCanceledException>(() => Capture(cancelled, cancellation.Token));
        Check(cancelled.Source.Resolutions == 0 && cancelled.Gateway.SignIns == 0);
    }

    private static async Task NamesAndCycles()
    {
        foreach (var name in new[] { "..", "CON.txt", "NUL", "folder ", "folder.", "bad:name", "a/b", "a\\b", "x\u202ey", "x\ud800", ".LTDS-Downloads-V1" }) {
            var b = new Backend(); b.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([b.Node("bad-root", name, NodeKind.Root)]));
            await Refuse<CatalogCaptureException>(() => Capture(b));
        }
        var roots = new Backend();
        roots.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([roots.Node("a", "Same", NodeKind.Root), roots.Node("b", "same", NodeKind.Root)]));
        await Refuse<CatalogCaptureException>(() => Capture(roots));
        var files = new Backend(); var upper = files.Add("a", "A.txt"); var lower = files.Add("b", "a.txt");
        files.CatalogImpl.List = (_, more) => Task.FromResult(more is null ? new CatalogListing([], [upper], "next") : new CatalogListing([], [lower]));
        await Refuse<CatalogCaptureException>(() => Capture(files));
        var mixed = new Backend(); var same = mixed.Add("file", "Folder");
        mixed.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([mixed.Node("folder", "folder", NodeKind.Folder)], [same]));
        await Refuse<CatalogCaptureException>(() => Capture(mixed));
        var cycle = new Backend();
        cycle.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([cycle.Node(cycle.DefaultRoot.Key, "Again", NodeKind.Folder)], []));
        await Refuse<CatalogCaptureException>(() => Capture(cycle));
        var wrongSource = new Backend();
        wrongSource.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([wrongSource.DefaultRoot with { SourceAlias = "employee" }]));
        await Refuse<CatalogCaptureException>(() => Capture(wrongSource));
    }

    private static async Task PagingBounds()
    {
        var repeatedRoot = new Backend(); repeatedRoot.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([], "repeat"));
        await Refuse<CatalogCaptureException>(() => Capture(repeatedRoot)); Check(repeatedRoot.CatalogImpl.RootCalls == 2);
        var repeatedFolder = new Backend(); repeatedFolder.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [], "repeat"));
        await Refuse<CatalogCaptureException>(() => Capture(repeatedFolder)); Check(repeatedFolder.CatalogImpl.ListCalls == 2);
        var endless = new Backend(); var page = 0;
        endless.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([], "page-" + ++page));
        await Refuse<CatalogCaptureException>(() => Capture(endless)); Check(endless.CatalogImpl.RootCalls == 2048);
        var malformed = new Backend(); malformed.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing(null!, []));
        await Refuse<CatalogCaptureException>(() => Capture(malformed));
    }

    private static async Task ManifestPins()
    {
        foreach (var mutate in new Func<ResolvedQueuedDownload, ResolvedQueuedDownload>[] {
            r => r with { PrincipalId = OtherPrincipal },
            r => r with { Spec = r.Spec with { FileName = "renamed.txt" } },
            r => r with { Spec = r.Spec with { Length = r.Spec.Length + 1 } },
            r => r with { Spec = r.Spec with { OpaqueIdentity = "different-version" } },
            r => r with { Spec = r.Spec with { ContentUri = new Uri("https://other.example.invalid/content") } },
            r => r with { Spec = r.Spec with { ContentUri = new Uri("https://source.example.invalid/content?token=not-persisted") } },
            r => r with { Spec = r.Spec with { ETag = "W/\"weak\"" } },
            r => r with { Spec = r.Spec with { Sha256 = "not-a-sha" } },
            r => r with { RemoteVersion = "" },
            r => r with { LogicalFileId = "oef1_" + new string('c', 64), Spec = r.Spec with { OpaqueIdentity = "oef1_" + new string('c', 64) + ":v1" } }
        }) {
            var b = new Backend(); var file = b.Add("one", "one.txt");
            b.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [file]));
            b.Source.Mutate = mutate; await Refuse<CatalogCaptureException>(() => Capture(b));
            Check(b.Source.Downloads == 0 && b.Gateway.SignIns == 0);
        }
        var unavailable = new Backend(); var missingHash = unavailable.Add("unavailable", "no-hash.txt") with { Verifiable = false };
        unavailable.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [missingHash]));
        await Refuse<CatalogCaptureException>(() => Capture(unavailable)); Check(unavailable.Source.Resolutions == 0);
    }

    private static async Task InventoryBounds()
    {
        var count = new Backend(); var large = Enumerable.Range(0, 1000).Select(i => count.Add("file" + i, "file" + i + ".txt")).ToArray();
        count.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], large));
        await Refuse<CatalogCaptureException>(() => Capture(count)); Check(count.Source.Resolutions == 999); // The root directory consumes one slot.
        var depth = new Backend(); var index = 0;
        depth.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([depth.Node("depth-" + ++index, "x", NodeKind.Folder)], []));
        await Refuse<CatalogCaptureException>(() => Capture(depth)); Check(index == 32);
        var path = new Backend(); path.CatalogImpl.Roots = (_, _) => Task.FromResult(new NodePage([path.Node("long-root", new string('r', 100), NodeKind.Root)]));
        path.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([path.Node("long-child", new string('c', 81), NodeKind.Folder)], []));
        await Refuse<CatalogCaptureException>(() => Capture(path));
        var identity = new Backend(); var file = identity.Add("long-reference", "file.txt");
        var reference = "odqr1_" + new string('x', 4000);
        identity.CatalogImpl.References[file.Key] = reference;
        identity.Source.Metadata[reference] = identity.Source.Metadata.Values.Single();
        identity.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [file]));
        await Refuse<CatalogCaptureException>(() => Capture(identity)); Check(identity.Source.Resolutions == 1 && identity.Source.Downloads == 0);

        var listedLarge = new Backend(); var listed = listedLarge.Add("listed-large", "large.txt") with { Size = (64L << 30) + 1 };
        listedLarge.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [listed]));
        await Refuse<CatalogCaptureException>(() => Capture(listedLarge)); Check(listedLarge.Source.Resolutions == 0);
        var resolvedLarge = new Backend(); var unknown = resolvedLarge.Add("resolved-large", "large.txt", sizeUnknown: true);
        resolvedLarge.CatalogImpl.List = (_, _) => Task.FromResult(new CatalogListing([], [unknown]));
        resolvedLarge.Source.Mutate = r => r with { Spec = r.Spec with { Length = (64L << 30) + 1 } };
        await Refuse<CatalogCaptureException>(() => Capture(resolvedLarge)); Check(resolvedLarge.Source.Resolutions == 1);
        resolvedLarge.Source.Mutate = r => r with { Spec = r.Spec with { Length = 64L << 30 } };
        Check((await Capture(resolvedLarge)).Files.Single().Value.Length == (64L << 30));
    }

    private static async Task ProductionPin()
    {
        var settings = new LiveSettings(new Uri("https://source.example.invalid/portal"), null,
            @"C:\not-executed\cloudflared.exe", new string('0', 64));
        foreach (var outcome in new[] { "success", "failure", "cancel" }) {
            var fixture = new Backend(); var file = fixture.Add("pinned", "pinned.txt");
            var entered = Gate(); var release = Gate();
            var acquired = 0; var disposed = 0; var backendDisposed = 0; var active = false;
            using var cancellation = new CancellationTokenSource();
            Task<IDisposable> Pin(CancellationToken token)
            {
                token.ThrowIfCancellationRequested(); Check(!active); acquired++; active = true;
                return Task.FromResult<IDisposable>(new Scope(() => { disposed++; Check(active && disposed == 1); active = false; }));
            }
            fixture.Gateway.BeforeProbe = _ => Check(active);
            fixture.Source.Mutate = resolved => { Check(active); return resolved; };
            fixture.CatalogImpl.Roots = async (_, _) => {
                Check(active); entered.SetResult(); await release.Task; Check(active);
                if (outcome == "failure") throw new ResourceUnavailableException();
                return new NodePage([fixture.DefaultRoot]);
            };
            fixture.CatalogImpl.List = (_, _) => { Check(active); return Task.FromResult(new CatalogListing([], [file])); };
            await using var live = new LiveBackend(settings, "not-used-no-filesystem", AccessMode.Client,
                (_, _) => new(fixture.Gateway, fixture.CatalogImpl, fixture.Source, () => backendDisposed++, Pin));
            var capture = ExplorerCatalogSnapshotBuilder.CaptureAsync(live, "pilot", Principal, cancellation.Token);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Check(acquired == 1 && disposed == 0 && active);
            if (outcome == "cancel") cancellation.Cancel();
            release.SetResult();
            if (outcome == "success") Check((await capture).Files.Count == 1);
            else if (outcome == "failure") await Refuse<ResourceUnavailableException>(() => capture);
            else await Refuse<OperationCanceledException>(() => capture);
            Check(acquired == 1 && disposed == 1 && !active && backendDisposed == 0
                && fixture.Gateway.SignIns == 0 && fixture.Source.Downloads == 0);
        }

        // Configuration must be rechecked after the asynchronous pin acquisition itself.
        var changed = new Backend(); var pinEntered = Gate(); var pinRelease = Gate(); var pinDisposed = 0;
        async Task<IDisposable> DelayedPin(CancellationToken token)
        {
            pinEntered.SetResult(); await pinRelease.Task.WaitAsync(token);
            return new Scope(() => pinDisposed++);
        }
        await using var changing = new LiveBackend(settings, "not-used-no-filesystem", AccessMode.Client,
            (_, _) => new(changed.Gateway, changed.CatalogImpl, changed.Source, () => { }, DelayedPin));
        var changedCapture = ExplorerCatalogSnapshotBuilder.CaptureAsync(changing, "pilot", Principal);
        await pinEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        changed.Source.Alias = "changed-during-pin"; pinRelease.SetResult();
        await Refuse<CatalogCaptureException>(() => changedCapture);
        Check(pinDisposed == 1 && changed.Gateway.Probes == 0 && changed.CatalogImpl.RootCalls == 0);
    }

    private sealed class Scope(Action dispose) : IDisposable { public void Dispose() => dispose(); }

    private sealed class Backend : IFilesBackend
    {
        public Source Source { get; }
        public Catalog CatalogImpl { get; }
        public Gateway Gateway { get; }
        public ISessionGateway CurrentGateway { get; set; }
        public IFileCatalog CurrentCatalog { get; set; }
        public IReadOnlyList<IQueuedDownloadSource> Selected { get; set; }
        public CatalogNode DefaultRoot { get; }
        public Backend(string alias = "portal")
        {
            Source = new(alias); Gateway = new(Source); CurrentGateway = Gateway; CatalogImpl = new(this); CurrentCatalog = CatalogImpl;
            Selected = [Source]; DefaultRoot = Node("root", "Root", NodeKind.Root);
        }
        public CatalogNode Node(string key, string name, NodeKind kind) => new(key, name, kind, Source.Alias);
        public CatalogFile Add(string key, string name, bool sizeUnknown = false)
        {
            var bytes = Encoding.UTF8.GetBytes("Generated catalog test content: " + key);
            var logical = (Source.Alias == "employee" ? "oef1_" : "ondf1_") + Hash(Encoding.UTF8.GetBytes(key));
            var reference = "odqr1_" + key;
            var spec = new DownloadSpec(logical + ":v1", new Uri(Source.Origin, "content/" + key), name, bytes.Length, "\"v1\"", Hash(bytes));
            Source.Metadata[reference] = new(Principal, logical, "v1", spec); CatalogImpl.References[key] = reference;
            return new(key, name, sizeUnknown ? -1 : bytes.Length, true, Source.Alias);
        }
        public ISessionGateway Session => CurrentGateway;
        public IFileCatalog Catalog => CurrentCatalog;
        public IReadOnlyList<IQueuedDownloadSource> Sources => Selected;
        public string StateDirectory => "not-used-no-filesystem";
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class Gateway(Source source) : ISessionGateway
    {
        public bool SignedIn = true;
        public int SignIns;
        public int Probes;
        public string? PrincipalOverride;
        public Action<int>? BeforeProbe;
        public Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default)
        {
            var count = ++Probes;
            BeforeProbe?.Invoke(count);
            return Task.FromResult(SignedIn ? new SessionInfo(PrincipalOverride ?? source.Person, source.Expiry) : null);
        }
        public Task SignInAsync(CancellationToken cancellationToken = default) { SignIns++; throw new Exception("Snapshot must never start browser sign-in."); }
    }

    private sealed class Source(string alias) : IQueuedDownloadSource
    {
        public string Alias { get; set; } = alias;
        public Uri Origin { get; set; } = new("https://source.example.invalid/");
        public string Person = Principal;
        public DateTimeOffset Expiry = DateTimeOffset.UtcNow.AddHours(1);
        public readonly Dictionary<string, ResolvedQueuedDownload> Metadata = new(StringComparer.Ordinal);
        public Func<ResolvedQueuedDownload, ResolvedQueuedDownload>? Mutate;
        public int Downloads, Resolutions, Sessions;
        public Action<int>? BeforeSession;
        public Exception? ResolveFailure;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) {
            BeforeSession?.Invoke(++Sessions); return Task.FromResult(new QueuedDownloadSession(Person, Expiry));
        }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default)
        {
            Resolutions++;
            if (ResolveFailure is { } failure) throw failure;
            if (!Metadata.TryGetValue(reference, out var resolved)) throw new ResourceUnavailableException();
            return Task.FromResult(Mutate?.Invoke(resolved) ?? resolved);
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        { Downloads++; throw new Exception("Snapshot must never download file bytes."); }
    }

    private sealed class Catalog : IFileCatalog
    {
        private readonly Backend backend;
        public Func<CatalogNode, object?, Task<NodePage>> Roots;
        public Func<CatalogNode, object?, Task<CatalogListing>> List;
        public readonly Dictionary<string, string> References = new(StringComparer.Ordinal);
        public int RootCalls, ListCalls;
        public Exception? SectionFailure, ReferenceFailure;
        public Catalog(Backend backend)
        {
            this.backend = backend;
            Roots = (_, _) => Task.FromResult(new NodePage([backend.DefaultRoot]));
            List = (_, _) => Task.FromResult(new CatalogListing([], []));
        }
        public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default) {
            if (SectionFailure is { } failure) throw failure;
            return Task.FromResult<IReadOnlyList<CatalogNode>>([backend.Node("section", "Selected source", NodeKind.Section)]);
        }
        public Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default)
        { RootCalls++; return Roots(node, more); }
        public Task<CatalogListing> ListAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default)
        { ListCalls++; return List(node, more); }
        public Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) {
            if (ReferenceFailure is { } failure) throw failure;
            return Task.FromResult(References[file.Key]);
        }
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}

