using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

if (args.Length > 0 && args[0] == "--synthetic-access-child-v1") {
    Environment.ExitCode = await AccessSessionTests.RunChildAsync(args);
    return;
}

var passed = 0;
var tests = new (string Name, Func<Task> Run)[] {
    ("exact verified bytes promote once without overwrite", Full),
    ("interrupted response resumes at saved byte offset", Resume),
    ("resume rejects full 200, ETag changes and incorrect ranges", ResumeFailures),
    ("corrupt, truncated and oversized bodies never publish", InvalidBodies),
    ("unsafe basenames and unapproved origins fail before HTTP", UnsafeInputs),
    ("existing output and unowned state are never overwritten", ExistingFiles),
    ("cancellation preserves no final file", Cancellation),
    ("redirects are refused rather than followed", Redirect),
    ("reparse roots, state files and output paths are refused", ReparsePaths),
    ("empty content and maximum size constraints", EmptyAndBounds),
    ("malformed state and modified partial files fail closed", StateIntegrity),
    ("late destination creation cannot be overwritten", LateDestination),
    ("one owned download cannot run concurrently", ExclusiveTransfer),
    ("oversized valid prefix cannot publish on a later failed retry", OversizedRetry),
    ("metadata cleanup cannot undo a committed successful download", LockedMetadata),
}.Concat(AccessSessionTests.Groups).Concat(PortalClientTests.Groups).ToArray();
foreach (var test in tests) {
    try { await test.Run(); passed++; Console.WriteLine("PASS " + test.Name); }
    catch (Exception error) { Console.Error.WriteLine("FAIL " + test.Name + ": " + error.GetType().Name + " " + error.Message); Environment.ExitCode = 1; }
}
Console.WriteLine($"{passed}/{tests.Length} synthetic transfer groups passed. No production network access.");

static byte[] Bytes() => "synthetic-file-content"u8.ToArray();
static DownloadSpec Spec(byte[]? bytes = null) {
    bytes ??= Bytes();
    return new("opaque-synthetic-resource", new Uri("https://files.example.invalid/content?session=synthetic-do-not-persist"),
        "example.bin", bytes.Length, "\"immutable-version-1\"", Convert.ToHexStringLower(SHA256.HashData(bytes)));
}
static Downloader Engine(HttpMessageHandler handler, long maximum = 1L << 40) => new(handler, [new Uri("https://files.example.invalid")], maximum);
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
static async Task Reject(Func<Task> action) {
    try { await action(); } catch (TransferException) { return; } catch (IOException) { return; }
    throw new Exception("Expected fail-closed rejection.");
}
static HttpResponseMessage Response(byte[] bytes, long offset = 0, HttpStatusCode status = HttpStatusCode.OK,
    string etag = "\"immutable-version-1\"", long? declaredLength = null, Stream? stream = null, long? total = null) {
    var response = new HttpResponseMessage(status) { Content = new StreamContent(stream ?? new MemoryStream(bytes)) };
    response.Headers.ETag = EntityTagHeaderValue.Parse(etag);
    response.Content.Headers.ContentLength = declaredLength ?? bytes.LongLength;
    if (status == HttpStatusCode.PartialContent)
        response.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, offset + bytes.LongLength - 1, total ?? Bytes().LongLength);
    return response;
}
static void NoFinal(DirectoryFixture root) => Assert(!File.Exists(Path.Combine(root.Path, "example.bin")), "Unverified content was published.");

static async Task Full() {
    using var root = new DirectoryFixture(); var handler = new FakeHandler((request, _) => {
        Assert(request.Method == HttpMethod.Get && request.Headers.IfMatch.Single().Tag == Spec().ETag, "Version precondition missing.");
        Assert(!request.Headers.Contains("Cookie") && request.Headers.Authorization is null, "Ambient authentication present.");
        return Response(Bytes());
    });
    using var engine = Engine(handler);
    var output = await engine.DownloadAsync(Spec(), root.Path);
    Assert((await File.ReadAllBytesAsync(output)).SequenceEqual(Bytes()), "Final checksum/content differs.");
    await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    Assert(handler.Calls == 1, "Existing destination caused another download.");
    Assert(!Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Any(), "Partial remained after promotion.");
}

static async Task Resume() {
    using var root = new DirectoryFixture();
    var first = new FakeHandler((_, _) => Response(Bytes(), stream: new InterruptedStream(Bytes(), 7)));
    using (var engine = Engine(first)) await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    NoFinal(root);
    var partial = Directory.GetFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
    Assert(new FileInfo(partial).Length == 7, "Interrupted prefix was not retained.");
    var state = File.ReadAllText(Directory.GetFiles(root.Path, "*.json", SearchOption.AllDirectories).Single());
    Assert(!state.Contains("https") && !state.Contains("synthetic-do-not-persist") && !state.Contains("opaque-synthetic-resource"), "Session or identity leaked to state.");
    var second = new FakeHandler((request, _) => {
        Assert(request.Headers.Range?.Ranges.Single().From == 7 && request.Headers.IfRange?.EntityTag?.ToString() == Spec().ETag, "Resume offset/version missing.");
        return Response(Bytes()[7..], 7, HttpStatusCode.PartialContent);
    });
    using (var engine = Engine(second)) await engine.DownloadAsync(Spec(), root.Path);
    Assert(File.ReadAllBytes(Path.Combine(root.Path, "example.bin")).SequenceEqual(Bytes()), "Resumed bytes differ.");
}

static async Task SeedPartial(DirectoryFixture root) {
    using var engine = Engine(new FakeHandler((_, _) => Response(Bytes(), stream: new InterruptedStream(Bytes(), 5))));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path));
}
static async Task ResumeFailures() {
    foreach (var kind in new[] { "200", "etag", "range", "length", "encoding", "weak" }) {
        using var root = new DirectoryFixture(); await SeedPartial(root);
        var before = File.ReadAllBytes(Directory.GetFiles(root.Path, "*.part", SearchOption.AllDirectories).Single());
        using var engine = Engine(new FakeHandler((_, _) => {
            var result = Response(Bytes()[5..], 5, kind == "200" ? HttpStatusCode.OK : HttpStatusCode.PartialContent,
                kind == "etag" ? "\"new-version\"" : kind == "weak" ? "W/\"immutable-version-1\"" : Spec().ETag);
            if (kind == "range") result.Content.Headers.ContentRange = new ContentRangeHeaderValue(4, Bytes().Length - 2, Bytes().Length);
            if (kind == "length") result.Content.Headers.ContentLength = Bytes().Length;
            if (kind == "encoding") result.Content.Headers.ContentEncoding.Add("gzip");
            return result;
        }));
        await Reject(() => engine.DownloadAsync(Spec(), root.Path)); NoFinal(root);
        Assert(File.ReadAllBytes(Directory.GetFiles(root.Path, "*.part", SearchOption.AllDirectories).Single()).SequenceEqual(before), "Rejected resume modified valid prefix.");
    }
}

static async Task InvalidBodies() {
    foreach (var kind in new[] { "corrupt", "truncated", "oversized" }) {
        using var root = new DirectoryFixture(); var data = Bytes();
        if (kind == "corrupt") data[0] ^= 1;
        if (kind == "truncated") data = data[..^1];
        if (kind == "oversized") data = [.. data, 99, 100];
        var observed = new CountingStream(data);
        using var engine = Engine(new FakeHandler((_, _) => Response(data, declaredLength: Bytes().Length, stream: observed)));
        await Reject(() => engine.DownloadAsync(Spec(), root.Path)); NoFinal(root);
        Assert(observed.BytesRead <= Bytes().Length + 1, "Reader exceeded trusted size plus a one-byte overflow probe.");
        if (kind == "corrupt") Assert(!Directory.GetFiles(root.Path, "*.part", SearchOption.AllDirectories).Any(), "Corrupt full partial was retained.");
    }
}

static async Task UnsafeInputs() {
    foreach (var name in new[] { "../outside.bin", "..\\outside.bin", "C:\\outside", "file:stream", "CON.txt", "LPT1", "COM¹.dat", "trailing.", "trailing ", "bad\0name", ".ltds-downloads-v1" }) {
        using var root = new DirectoryFixture(); var handler = new FakeHandler((_, _) => throw new Exception("Unexpected HTTP"));
        using var engine = Engine(handler); await Reject(() => engine.DownloadAsync(Spec() with { FileName = name }, root.Path));
        Assert(handler.Calls == 0 && !Directory.EnumerateFileSystemEntries(root.Path).Any(), "Unsafe input mutated local state.");
    }
    foreach (var uri in new[] { "http://files.example.invalid/content", "https://other.example.invalid/content", "https://files.example.invalid.evil/content", "https://files.example.invalid:444/content", "https://user:password@files.example.invalid/content", "https://files.example.invalid/content#fragment" }) {
        using var root = new DirectoryFixture(); var handler = new FakeHandler((_, _) => throw new Exception("Unexpected HTTP"));
        using var engine = Engine(handler); await Reject(() => engine.DownloadAsync(Spec() with { ContentUri = new Uri(uri) }, root.Path));
        Assert(handler.Calls == 0, "Origin validation happened after HTTP.");
    }
}

static async Task ExistingFiles() {
    using var root = new DirectoryFixture(); var file = Path.Combine(root.Path, "example.bin"); File.WriteAllText(file, "preserve-existing");
    using var engine = Engine(new FakeHandler((_, _) => throw new Exception("Unexpected HTTP")));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path)); Assert(File.ReadAllText(file) == "preserve-existing", "Existing destination overwritten.");
    File.Delete(file); Directory.CreateDirectory(Path.Combine(root.Path, ".ltds-downloads-v1"));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path)); Assert(!File.Exists(Path.Combine(root.Path, ".ltds-downloads-v1", "owner.txt")), "Unowned directory claimed.");
}

static async Task Cancellation() {
    using var root = new DirectoryFixture(); using var cancellation = new CancellationTokenSource();
    var handler = new FakeHandler((_, _) => Response(Bytes(), stream: new CancellingStream(Bytes(), cancellation)));
    using var engine = Engine(handler);
    try { await engine.DownloadAsync(Spec(), root.Path, cancellation.Token); throw new Exception("Cancellation not observed."); }
    catch (OperationCanceledException) { }
    NoFinal(root);
    var calls = handler.Calls;
    try { await engine.DownloadAsync(Spec(), root.Path, cancellation.Token); throw new Exception("Pre-cancelled request proceeded."); }
    catch (OperationCanceledException) { }
    Assert(handler.Calls == calls, "Pre-cancelled request sent HTTP.");
}

static async Task Redirect() {
    using var root = new DirectoryFixture(); var handler = new FakeHandler((_, _) => {
        var response = new HttpResponseMessage(HttpStatusCode.Redirect); response.Headers.Location = new Uri("https://evil.example.invalid/content"); return response;
    });
    using var engine = Engine(handler); await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    Assert(handler.Calls == 1, "Redirect followed."); NoFinal(root);
}

static async Task ReparsePaths() {
    using var root = new DirectoryFixture(); using var outside = new DirectoryFixture();
    var link = Path.Combine(root.Path, "linked");
    CreateDirectoryLink(link, outside.Path);
    using var engine = Engine(new FakeHandler((_, _) => throw new Exception("Unexpected HTTP")));
    await Reject(() => engine.DownloadAsync(Spec(), link));
    var output = Path.Combine(root.Path, "example.bin");
    if (OperatingSystem.IsWindows()) CreateDirectoryLink(output, outside.Path);
    else File.CreateSymbolicLink(output, Path.Combine(outside.Path, "missing.bin"));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    Assert(!File.Exists(Path.Combine(outside.Path, "missing.bin")), "Output link created content outside root.");
    if (OperatingSystem.IsWindows()) Directory.Delete(output); else File.Delete(output);
    Directory.Delete(link);
    await SeedPartial(root);
    var part = Directory.GetFiles(root.Path, "*.part", SearchOption.AllDirectories).Single(); File.Delete(part);
    if (OperatingSystem.IsWindows()) CreateDirectoryLink(part, outside.Path);
    else File.CreateSymbolicLink(part, Path.Combine(outside.Path, "other-missing.bin"));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    Assert(!File.Exists(Path.Combine(outside.Path, "other-missing.bin")), "Partial link escaped root.");
    if (OperatingSystem.IsWindows()) Directory.Delete(part); else File.Delete(part);
}

static void CreateDirectoryLink(string link, string target) {
    if (!OperatingSystem.IsWindows()) { Directory.CreateSymbolicLink(link, target); return; }
    // Windows junctions require no developer-mode/elevation. Both paths are synthetic test roots.
    foreach (var value in new[] { link, target })
        if (!Regex.IsMatch(value, @"\A[A-Za-z]:[\\A-Za-z0-9._ -]+\z")) throw new Exception("Unsafe synthetic junction path.");
    var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    start.Arguments = "/d /c mklink /J \"" + link + "\" \"" + target + "\"";
    using var process = Process.Start(start) ?? throw new Exception("Cannot create synthetic junction.");
    process.WaitForExit();
    if (process.ExitCode != 0) throw new Exception("Cannot create synthetic junction: " + process.StandardError.ReadToEnd());
}

static async Task EmptyAndBounds() {
    using var root = new DirectoryFixture(); using var engine = Engine(new FakeHandler((_, _) => Response([])));
    var output = await engine.DownloadAsync(Spec([]), root.Path); Assert(new FileInfo(output).Length == 0, "Empty content failed.");
    using var another = new DirectoryFixture(); using var bounded = Engine(new FakeHandler((_, _) => throw new Exception("Unexpected HTTP")), 2);
    await Reject(() => bounded.DownloadAsync(Spec(), another.Path));
    await Reject(() => bounded.DownloadAsync(Spec() with { ETag = "W/\"version\"" }, another.Path));
    await Reject(() => bounded.DownloadAsync(Spec() with { Sha256 = "not-a-hash" }, another.Path));
}

static async Task StateIntegrity() {
    using var root = new DirectoryFixture(); await SeedPartial(root);
    var json = Directory.GetFiles(root.Path, "*.json", SearchOption.AllDirectories).Single(); var valid = File.ReadAllText(json);
    File.WriteAllText(json, "{}"); using var engine = Engine(new FakeHandler((_, _) => throw new Exception("Unexpected HTTP")));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path)); File.WriteAllText(json, valid);
    var part = Directory.GetFiles(root.Path, "*.part", SearchOption.AllDirectories).Single(); File.WriteAllBytes(part, new byte[Bytes().Length + 1]);
    await Reject(() => engine.DownloadAsync(Spec(), root.Path)); NoFinal(root);
}

static async Task LateDestination() {
    using var root = new DirectoryFixture();
    using var engine = Engine(new FakeHandler((_, _) => {
        File.WriteAllText(Path.Combine(root.Path, "example.bin"), "independent-existing-file");
        return Response(Bytes());
    }));
    await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    Assert(File.ReadAllText(Path.Combine(root.Path, "example.bin")) == "independent-existing-file", "Late destination overwritten.");
}

static async Task ExclusiveTransfer() {
    using var root = new DirectoryFixture();
    var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var first = Engine(new DelayedHandler(start, resume));
    var transfer = first.DownloadAsync(Spec(), root.Path);
    await start.Task;
    using var second = Engine(new FakeHandler((_, _) => throw new Exception("Second transfer sent HTTP.")));
    try { await Reject(() => second.DownloadAsync(Spec(), root.Path)); }
    finally { resume.TrySetResult(); }
    await transfer;
    Assert(File.ReadAllBytes(Path.Combine(root.Path, "example.bin")).SequenceEqual(Bytes()), "Exclusive transfer failed.");
}

static async Task OversizedRetry() {
    using var root = new DirectoryFixture();
    using (var engine = Engine(new FakeHandler((_, _) => Response([.. Bytes(), 99], declaredLength: Bytes().Length))))
        await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    NoFinal(root);
    var handler = new FakeHandler((_, _) => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
    using (var engine = Engine(handler)) await Reject(() => engine.DownloadAsync(Spec(), root.Path));
    Assert(handler.Calls == 1, "Retry silently published an earlier rejected response."); NoFinal(root);
    using (var engine = Engine(new FakeHandler((_, _) => Response(Bytes())))) await engine.DownloadAsync(Spec(), root.Path);
    Assert(File.ReadAllBytes(Path.Combine(root.Path, "example.bin")).SequenceEqual(Bytes()), "Fresh retry did not recover.");
}

static async Task LockedMetadata() {
    using var root = new DirectoryFixture(); FileStream? metadataLock = null;
    using var engine = Engine(new FakeHandler((_, _) => {
        var json = Directory.GetFiles(root.Path, "*.json", SearchOption.AllDirectories).Single();
        metadataLock = new FileStream(json, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Response(Bytes());
    }));
    try {
        var result = await engine.DownloadAsync(Spec(), root.Path);
        Assert(File.ReadAllBytes(result).SequenceEqual(Bytes()), "Committed output should be reported as success.");
    } finally { metadataLock?.Dispose(); }
}

sealed class FakeHandler(Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> responder) : HttpMessageHandler {
    public int Calls { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
        Calls++; return Task.FromResult(responder(request, cancellationToken));
    }
}
sealed class DirectoryFixture : IDisposable {
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ltds-windows-download-test-" + Guid.NewGuid().ToString("N"));
    public DirectoryFixture() => Directory.CreateDirectory(Path);
    public void Dispose() => DeleteOwnedTree(Path);
    private void DeleteOwnedTree(string directory) {
        var full = System.IO.Path.GetFullPath(directory);
        if (full != Path && !full.StartsWith(Path + System.IO.Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new Exception("Synthetic cleanup escaped its owned root.");
        foreach (var entry in Directory.EnumerateFileSystemEntries(full)) {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) {
                if ((attributes & FileAttributes.Directory) != 0) Directory.Delete(entry);
                else File.Delete(entry);
            } else if ((attributes & FileAttributes.Directory) != 0) DeleteOwnedTree(entry);
            else File.Delete(entry);
        }
        Directory.Delete(full);
    }
}
class CountingStream(byte[] data) : MemoryStream(data) {
    public long BytesRead { get; private set; }
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
        var count = Read(buffer.Span); BytesRead += count; return ValueTask.FromResult(count);
    }
}
sealed class InterruptedStream(byte[] data, int stop) : MemoryStream(data) {
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
        if (Position >= stop) throw new IOException("Synthetic interrupted response.");
        return ValueTask.FromResult(Read(buffer.Span[..Math.Min(buffer.Length, stop - (int)Position)]));
    }
}
sealed class CancellingStream(byte[] data, CancellationTokenSource source) : MemoryStream(data) {
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
        source.Cancel(); throw new OperationCanceledException(cancellationToken);
    }
}

sealed class DelayedHandler(TaskCompletionSource start, TaskCompletionSource resume) : HttpMessageHandler {
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
        start.SetResult(); await resume.Task.WaitAsync(cancellationToken);
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent("synthetic-file-content"u8.ToArray()) };
        response.Headers.ETag = new EntityTagHeaderValue("\"immutable-version-1\"");
        return response;
    }
}
