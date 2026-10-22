using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

/// <summary>
/// Synthetic data for trying the app and for tests: made-up deliveries and server folders, a sign-in that
/// needs no browser, and a download source that writes generated files slowly so progress is visible.
/// It still runs through the real <see cref="TransferQueue"/>. Nothing here contacts a network.
/// </summary>
public sealed class DemoBackend : IFilesBackend
{
    internal sealed record DemoFile(string Key, string Name, int Length, bool Verifiable);
    private sealed record DemoFolder(string Key, string Name, string Alias, DemoFolder[] Folders, DemoFile[] Files);

    private readonly DemoState state;
    private readonly DemoFolder[] sections;

    /// <param name="pageSize">How many places or files one listing returns before "Show more".</param>
    public DemoBackend(string stateDirectory, bool signedIn = false, TimeSpan? sessionLength = null, double bytesPerSecond = 6_000_000, int pageSize = 200)
    {
        StateDirectory = stateDirectory;
        state = new DemoState { SignedIn = signedIn, SessionLength = sessionLength ?? TimeSpan.FromMinutes(60), BytesPerSecond = bytesPerSecond };
        if (signedIn) state.ExpiresAt = DateTimeOffset.UtcNow + state.SessionLength;
        static DemoFile F(string key, string name, int length, bool verifiable = true) => new(key, name, length, verifiable);
        sections = [
            new("deliveries", "Client deliveries", "portal", [
                new("land-script", "Land Script — October flight", "portal", [
                    new("land-script-raw", "Raw photos", "portal", [], [F("ls-img1", "DJI_0001.JPG", 6_200_000), F("ls-img2", "DJI_0002.JPG", 6_100_000)]),
                ], [F("ls-ortho", "ortho-full.tif", 48_000_000), F("ls-kml", "PIN-20261020113.kml", 15_360), F("ls-zip", "site-photos.zip", 9_000_000, false),
                    F("ls-pdf", "report.pdf", 3_200_000)]),
                new("greenleaf", "Greenleaf Farms — Field survey", "portal", [], [F("gl-dsm", "survey-dsm.tif", 24_000_000), F("gl-csv", "volumes.csv", 42_000)]),
                new("harbor", "Harbor Authority — Seawall inspection", "portal", [], [F("ha-mp4", "seawall-flight.mp4", 30_000_000), F("ha-pdf", "inspection.pdf", 1_800_000)]),
            ], []),
            new("server", "Company server", "employee", [
                new("projects", "Projects", "employee", [
                    new("projects-2026", "2026 jobs", "employee", [], [F("pj-dwg", "site-plan.dwg", 5_400_000), F("pj-xlsx", "schedule.xlsx", 88_000)]),
                ], [F("pj-readme", "README.txt", 2_048)]),
            ], []),
        ];
        Sources = [new DemoSource("portal", state, Find), new DemoSource("employee", state, Find)];
        Session = new DemoSession(state);
        Catalog = new DemoCatalog(sections, state, pageSize);
    }

    public ISessionGateway Session { get; }
    public IFileCatalog Catalog { get; }
    public IReadOnlyList<IQueuedDownloadSource> Sources { get; }
    public string StateDirectory { get; }

    /// <summary>Ends the demo session now, as if the sign-in expired.</summary>
    public void Expire() => state.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1);
    /// <summary>Lets the remaining bytes arrive quickly (tests).</summary>
    public void Faster() => state.BytesPerSecond = 200_000_000;
    /// <summary>Signs another person in, as if a different account were used. The second person sees only Greenleaf.</summary>
    public void SwitchPerson(int? to = null) => state.Person = to ?? state.Person + 1;
    /// <summary>Makes every sign-in check hang (offline or a stuck token cache) until <see cref="ReleaseSessions"/>.</summary>
    public void BlockSessions() { lock (state) state.Gate ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); }
    public void ReleaseSessions() { TaskCompletionSource? gate; lock (state) { gate = state.Gate; state.Gate = null; } gate?.TrySetResult(); }
    /// <summary>The most downloads that were ever writing at the same moment.</summary>
    public int MostAtOnce => state.MostAtOnce;
    /// <summary>The opaque person ID sources report right now.</summary>
    public string Principal => state.Principal;

    private DemoFile? Find(string key)
    {
        static DemoFile? Search(DemoFolder folder, string key) =>
            folder.Files.FirstOrDefault(file => file.Key == key) ?? folder.Folders.Select(child => Search(child, key)).FirstOrDefault(found => found is not null);
        return sections.Select(section => Search(section, key)).FirstOrDefault(found => found is not null);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    internal sealed class DemoState
    {
        public bool SignedIn;
        public int Person;
        public TimeSpan SessionLength;
        public DateTimeOffset ExpiresAt;
        public double BytesPerSecond;
        public TaskCompletionSource? Gate;
        public int Writing, MostAtOnce;
        public bool Valid => SignedIn && ExpiresAt > DateTimeOffset.UtcNow.AddSeconds(5);
        public string Principal => "odqp1_" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("demo-person-" + Person)));
        public bool Sees(string key) => Person == 0 || key is "deliveries" or "greenleaf";

        public async Task CheckAsync(CancellationToken cancellationToken)
        {
            Task? gate; lock (this) gate = Gate?.Task;
            if (gate is not null) await gate.WaitAsync(cancellationToken);
            if (!Valid) throw new LoginRequiredException();
        }
    }

    private sealed class DemoSession(DemoState state) : ISessionGateway
    {
        public Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(state.Valid ? new SessionInfo(state.Principal, state.ExpiresAt) : null);

        public async Task SignInAsync(CancellationToken cancellationToken = default)
        {
            await Task.Delay(1200, cancellationToken);
            state.SignedIn = true; state.ExpiresAt = DateTimeOffset.UtcNow + state.SessionLength;
        }
    }

    private sealed class DemoCatalog(DemoFolder[] sections, DemoState state, int pageSize) : IFileCatalog
    {
        private static CatalogNode Node(DemoFolder folder, NodeKind kind) => new(folder.Key, folder.Name, kind, folder.Alias, folder);

        public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<CatalogNode>>(sections.Where(section => state.Sees(section.Key)).Select(section => Node(section, NodeKind.Section)).ToList());

        public async Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default)
        {
            await Task.Delay(60, cancellationToken);
            var all = ((DemoFolder)node.Payload!).Folders.Where(folder => node.Kind != NodeKind.Section || state.Sees(folder.Key)).ToList();
            var from = more as int? ?? 0;
            return new NodePage(all.Skip(from).Take(pageSize).Select(folder => Node(folder, node.Kind == NodeKind.Section ? NodeKind.Root : NodeKind.Folder)).ToList(),
                from + pageSize < all.Count ? from + pageSize : null);
        }

        public async Task<CatalogListing> ListAsync(CatalogNode folder, object? more = null, CancellationToken cancellationToken = default)
        {
            await Task.Delay(150, cancellationToken);
            var value = (DemoFolder)folder.Payload!;
            var from = more as int? ?? 0;
            return new CatalogListing(value.Folders.Select(child => Node(child, NodeKind.Folder)).ToList(),
                value.Files.Skip(from).Take(pageSize).Select(file => new CatalogFile(file.Key, file.Name, file.Length, file.Verifiable, value.Alias)).ToList(),
                from + pageSize < value.Files.Length ? from + pageSize : null);
        }

        public Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) =>
            Task.FromResult("odqr1_" + Convert.ToBase64String(Encoding.UTF8.GetBytes(file.Key)).TrimEnd('=').Replace('+', '-').Replace('/', '_'));
    }

    /// <summary>A stand-in for the employee or portal source: same contract, generated bytes, no network.</summary>
    private sealed class DemoSource(string alias, DemoState state, Func<string, DemoFile?> find) : IQueuedDownloadSource
    {
        private static readonly Dictionary<string, byte[]> Content = [];
        public string Alias { get; } = alias;
        public Uri Origin { get; } = new("https://demo.ledgetop.invalid/");

        public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        {
            await state.CheckAsync(cancellationToken);
            return new QueuedDownloadSession(state.Principal, state.ExpiresAt);
        }

        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
        {
            if (!state.Valid) throw new LoginRequiredException();
            var encoded = resourceReference["odqr1_".Length..].Replace('-', '+').Replace('_', '/');
            var key = Encoding.UTF8.GetString(Convert.FromBase64String(encoded.PadRight(encoded.Length + (4 - encoded.Length % 4) % 4, '=')));
            var file = find(key) ?? throw new ResourceUnavailableException();
            var bytes = Bytes(file);
            var logical = (Alias == "employee" ? "oef1_" : "ondf1_") + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
            return Task.FromResult(new ResolvedQueuedDownload(state.Principal, logical, "v1",
                new DownloadSpec(logical + ":v1", new Uri(Origin, "files/" + Uri.EscapeDataString(key)), file.Name, bytes.Length, "\"v1\"",
                    Convert.ToHexStringLower(SHA256.HashData(bytes)))));
        }

        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
            CancellationToken cancellationToken = default)
        {
            var key = Uri.UnescapeDataString(spec.ContentUri.AbsolutePath["/files/".Length..]);
            var bytes = Bytes(find(key) ?? throw new ResourceUnavailableException());
            var final = Path.Combine(destination, spec.FileName);
            var partial = Path.Combine(destination, "." + spec.FileName + ".ltds-demo-partial");
            var offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
            if (offset > bytes.Length) { File.Delete(partial); offset = 0; }
            lock (state) state.MostAtOnce = Math.Max(state.MostAtOnce, ++state.Writing);
            try {
                await using (var output = new FileStream(partial, FileMode.Append, FileAccess.Write, FileShare.None)) {
                    const int chunk = 256 * 1024;
                    var delay = TimeSpan.FromSeconds(chunk / Math.Max(1, state.BytesPerSecond));
                    while (offset < bytes.Length) {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (!state.Valid) throw new LoginRequiredException();
                        var count = (int)Math.Min(chunk, bytes.Length - offset);
                        await output.WriteAsync(bytes.AsMemory((int)offset, count), cancellationToken);
                        offset += count;
                        progress?.Report(new DownloadProgress(offset, bytes.Length, DownloadPhase.Receiving));
                        await Task.Delay(delay, cancellationToken);
                    }
                }
                progress?.Report(new DownloadProgress(bytes.Length, bytes.Length, DownloadPhase.Verifying));
                await Task.Delay(300, cancellationToken);
                File.Move(partial, final, overwrite: false);
            } finally { lock (state) state.Writing--; }
            progress?.Report(new DownloadProgress(bytes.Length, bytes.Length, DownloadPhase.Completed));
            return final;
        }

        private static byte[] Bytes(DemoFile file)
        {
            lock (Content) {
                if (Content.TryGetValue(file.Key, out var existing)) return existing;
                var bytes = new byte[file.Length]; var seed = file.Key.Aggregate(17, (hash, c) => hash * 31 + c);
                for (var i = 0; i < bytes.Length; i++) bytes[i] = (byte)(seed + i * 7);
                return Content[file.Key] = bytes;
            }
        }
    }
}
