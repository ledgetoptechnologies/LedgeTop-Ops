using System.Net;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class AccessSessionTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("Access cached lookup never invokes interactive login", Commands),
        ("Access binary pin and protected application URL fail closed", Configuration),
        ("Access wrong content origin fails before token acquisition", WrongOrigin),
        ("Access command failures and malformed tokens are redacted", TokenFailures),
        ("Access token is attached only to exact origin and refreshed per request", Headers),
        ("Access redirects, authorization denial and cancellation never launch login", Responses),
        ("real synthetic subprocess preserves arguments bounds both outputs and cancels", RealSubprocess)
    ];

    private static void Assert(bool condition) { if (!condition) throw new Exception("Access assertion failed."); }
    private static string Token(long? expiry = null) => "eyJhbGciOiJSUzI1NiJ9." + Convert.ToBase64String(
        JsonSerializer.SerializeToUtf8Bytes(new { exp = expiry ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c3ludGhldGlj";
    private static async Task Throws<T>(Func<Task> action) where T : Exception {
        try { await action(); } catch (T) { return; }
        throw new Exception("Expected safe Access failure.");
    }
    private static async Task Commands() {
        using var fixture = new Fixture(); var runner = new Runner(); var session = fixture.Session(runner);
        Assert(await session.GetTokenAsync() == runner.Result.Stdout);
        Assert(runner.Calls.Single().SequenceEqual(new[] { "access", "token", "--app", "https://files.example.invalid/portal" }));
        await session.ExplicitLoginAsync();
        Assert(runner.Calls[1].SequenceEqual(new[] { "access", "login", "--app", "https://files.example.invalid/portal", "--quiet" }));
        Assert(session.Origin == new Uri("https://files.example.invalid"));
    }
    private static async Task Configuration() {
        using var fixture = new Fixture();
        foreach (var url in new[] { "https://files.example.invalid/", "http://files.example.invalid/portal", "https://user@files.example.invalid/portal", "https://files.example.invalid/portal?q=token", "https://files.example.invalid/portal#fragment" })
            await Throws<ArgumentException>(() => Task.FromResult(new CloudflareAccessSession(new Uri(url), fixture.Binary, fixture.Pin, new Runner())));
        await Throws<TransferException>(() => Task.FromResult(new CloudflareAccessSession(new Uri("https://files.example.invalid/portal"), fixture.Binary, new string('0', 64), new Runner())));
        var runner = new Runner(); var session = fixture.Session(runner);
        File.AppendAllText(fixture.Binary, "changed");
        await Throws<TransferException>(() => session.GetTokenAsync()); Assert(runner.Calls.Count == 0);
        using var linked = new Fixture(); var alias = Path.Combine(linked.Root, "binary-alias");
        if (OperatingSystem.IsWindows()) {
            // Only synthetic, validated temp paths are passed to the Windows junction builtin.
            foreach (var path in new[] { alias, fixture.Root })
                Assert(System.Text.RegularExpressions.Regex.IsMatch(path, "\\A[A-Za-z]:[\\\\A-Za-z0-9._ -]+\\z"));
            var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.Arguments = "/d /c mklink /J \"" + alias + "\" \"" + fixture.Root + "\"";
            using var process = Process.Start(start)!; await process.WaitForExitAsync(); Assert(process.ExitCode == 0);
        } else Directory.CreateSymbolicLink(alias, fixture.Root);
        try {
            await Throws<TransferException>(() => Task.FromResult(new CloudflareAccessSession(new Uri("https://files.example.invalid/portal"), Path.Combine(alias, Path.GetFileName(fixture.Binary)), fixture.Pin, new Runner())));
        } finally { Directory.Delete(alias); } // Remove only the link itself before ordinary fixture cleanup.
    }
    private static async Task WrongOrigin() {
        using var fixture = new Fixture(); var runner = new Runner(); var session = fixture.Session(runner);
        var handler = new Handler(_ => throw new Exception("HTTP must not run."));
        using var engine = new Downloader(handler, [session.Origin], session: session);
        var spec = Spec("one.bin") with { ContentUri = new Uri("https://elsewhere.example.invalid/content") };
        await Throws<TransferException>(() => engine.DownloadAsync(spec, fixture.Root));
        Assert(runner.Calls.Count == 0 && handler.Calls == 0);
        await Throws<ArgumentException>(() => Task.FromResult(new Downloader(new Handler(_ => Good()), [session.Origin, new Uri("https://other.example.invalid")], session: session)));
    }
    private static async Task TokenFailures() {
        foreach (var text in new[] { "not-a-jwt", Token(0), Token(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 2), "e30.e30.c2ln", "e30.a.c2ln", new string('a', 32769) }) {
            using var fixture = new Fixture(); var runner = new Runner { Result = new(0, text, "private-stderr") };
            var session = fixture.Session(runner); var handler = new Handler(_ => Good());
            using var engine = new Downloader(handler, [session.Origin], session: session);
            await Throws<LoginRequiredException>(() => engine.DownloadAsync(Spec("one.bin"), fixture.Root));
            Assert(handler.Calls == 0);
        }
        using var failure = new Fixture(); var secret = Token(); var failed = new Runner { Result = new(1, secret, "secret-provider-error") };
        try { await failure.Session(failed).GetTokenAsync(); throw new Exception("Expected denial."); }
        catch (LoginRequiredException error) { Assert(!error.ToString().Contains(secret) && !error.ToString().Contains("secret-provider-error")); }
        failed.Error = new IOException(secret);
        await Throws<LoginRequiredException>(() => failure.Session(failed).GetTokenAsync());
        failed.Error = null; failed.Result = new(0, Token(), new string('x', 32769));
        await Throws<LoginRequiredException>(() => failure.Session(failed).GetTokenAsync());
    }
    private static async Task Headers() {
        using var fixture = new Fixture(); var runner = new Runner(); var session = fixture.Session(runner);
        var handler = new Handler(request => {
            Assert(request.RequestUri!.GetLeftPart(UriPartial.Authority) == session.Origin.GetLeftPart(UriPartial.Authority));
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == runner.Result.Stdout);
            Assert(!request.Headers.Contains("Cookie") && request.Headers.Authorization is null);
            return Good();
        });
        using var engine = new Downloader(handler, [session.Origin], session: session);
        await engine.DownloadAsync(Spec("one.bin"), fixture.Root);
        runner.Result = new(0, Token(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 7200), "");
        await engine.DownloadAsync(Spec("two.bin") with { OpaqueIdentity = "second" }, fixture.Root);
        Assert(runner.Calls.Count == 2 && runner.Calls.All(call => call[1] == "token"));
        foreach (var state in Directory.GetFiles(Path.Combine(fixture.Root, ".ltds-downloads-v1")))
            Assert(!File.ReadAllText(state).Contains("eyJ") && !File.ReadAllText(state).Contains("https://"));
    }
    private static async Task Responses() {
        foreach (var status in new[] { HttpStatusCode.Redirect, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden }) {
            using var fixture = new Fixture(); var runner = new Runner(); var session = fixture.Session(runner);
            var handler = new Handler(_ => { var r = new HttpResponseMessage(status); r.Headers.Location = new Uri("https://other.example.invalid/"); return r; });
            using var engine = new Downloader(handler, [session.Origin], session: session);
            if (status == HttpStatusCode.Unauthorized) await Throws<LoginRequiredException>(() => engine.DownloadAsync(Spec("one.bin"), fixture.Root));
            else if (status == HttpStatusCode.Forbidden) await Throws<AccessDeniedException>(() => engine.DownloadAsync(Spec("one.bin"), fixture.Root));
            else await Throws<TransferException>(() => engine.DownloadAsync(Spec("one.bin"), fixture.Root));
            Assert(handler.Calls == 1 && runner.Calls.Count == 1 && runner.Calls[0][1] == "token");
        }
        using var cancelled = new Fixture(); var blocking = new Runner { WaitForCancellation = true }; var s = cancelled.Session(blocking);
        using var cancellation = new CancellationTokenSource();
        var noHttp = new Handler(_ => throw new Exception("HTTP must not run."));
        using var download = new Downloader(noHttp, [s.Origin], session: s);
        var pending = download.DownloadAsync(Spec("one.bin"), cancelled.Root, cancellation.Token); cancellation.Cancel();
        await Throws<OperationCanceledException>(() => pending);
        Assert(blocking.Calls.Single()[1] == "token" && noHttp.Calls == 0);
    }

    // Reserved test-only entry point in this test assembly. No cloudflared binary is executed.
    internal static async Task<int> RunChildAsync(string[] arguments) {
        if (arguments.Length < 2) return 64;
        switch (arguments[1]) {
            case "echo":
                Console.Out.Write(arguments[2]); Console.Error.Write(arguments[3]); return 7;
            case "stdout-limit": Console.Out.Write(new string('o', 32768)); return 0;
            case "stdout-overflow": Console.Out.Write(new string('o', 65536)); return 0;
            case "stderr-overflow": Console.Error.Write(new string('e', 65536)); return 0;
            case "sleep":
                // Publish readiness only after the PID file's writer is closed. Otherwise the
                // parent's existence probe may race the Windows FileShare.None write handle.
                var pendingPid = arguments[2] + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try {
                    await File.WriteAllTextAsync(pendingPid, Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    File.Move(pendingPid, arguments[2], overwrite: false);
                } finally { if (File.Exists(pendingPid)) File.Delete(pendingPid); }
                await Task.Delay(Timeout.Infinite); return 0;
            default: return 64;
        }
    }

    private static async Task RealSubprocess() {
        var assembly = typeof(AccessSessionTests).Assembly.Location;
        var executable = Path.Combine(Path.GetDirectoryName(assembly)!, Path.GetFileNameWithoutExtension(assembly)
            + (OperatingSystem.IsWindows() ? ".exe" : ""));
        Assert(File.Exists(executable));
        var runner = new AccessCommandRunner();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        const string argument = "literal spaced \"quotes\" $shell `text`";
        var echo = await runner.RunAsync(executable, ["--synthetic-access-child-v1", "echo", argument, "synthetic stderr"], deadline.Token);
        Assert(echo.ExitCode == 7 && echo.Stdout == argument && echo.Stderr == "synthetic stderr");
        var limit = await runner.RunAsync(executable, ["--synthetic-access-child-v1", "stdout-limit"], deadline.Token);
        Assert(limit.ExitCode == 0 && limit.Stdout.Length == 32768);
        foreach (var mode in new[] { "stdout-overflow", "stderr-overflow" })
            await Throws<LoginRequiredException>(() => runner.RunAsync(executable, ["--synthetic-access-child-v1", mode], deadline.Token));
        using var fixture = new Fixture();
        var pidPath = Path.Combine(fixture.Root, "synthetic-child.pid");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var pending = runner.RunAsync(executable, ["--synthetic-access-child-v1", "sleep", pidPath], cancellation.Token);
        var wait = Stopwatch.StartNew();
        while (!File.Exists(pidPath) && !pending.IsCompleted && wait.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(20);
        Assert(File.Exists(pidPath));
        var pid = int.Parse(await File.ReadAllTextAsync(pidPath), System.Globalization.CultureInfo.InvariantCulture);
        cancellation.Cancel(); await Throws<OperationCanceledException>(() => pending);
        // Observe the exact synthetic child, without terminating any unrelated process.
        wait.Restart();
        while (wait.Elapsed < TimeSpan.FromSeconds(5)) {
            try { using var child = Process.GetProcessById(pid); if (child.HasExited) return; }
            catch (ArgumentException) { return; }
            await Task.Delay(20);
        }
        throw new Exception("The synthetic cancelled child did not exit.");
    }

    private static byte[] Bytes => "synthetic authenticated bytes"u8.ToArray();
    private static DownloadSpec Spec(string name) => new("synthetic-id", new Uri("https://files.example.invalid/api/files/opaque/download"), name, Bytes.Length, "\"version-1\"", Convert.ToHexStringLower(SHA256.HashData(Bytes)));
    private static HttpResponseMessage Good() {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
        response.Headers.ETag = EntityTagHeaderValue.Parse("\"version-1\""); return response;
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> action) : HttpMessageHandler {
        internal int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { Calls++; return Task.FromResult(action(request)); }
    }
    private sealed class Runner : IAccessCommandRunner {
        internal AccessCommandResult Result = new(0, Token(), "");
        internal Exception? Error;
        internal bool WaitForCancellation;
        internal List<string[]> Calls = [];
        public async Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> arguments, CancellationToken cancellationToken) {
            Calls.Add(arguments.ToArray()); if (Error is not null) throw Error;
            if (WaitForCancellation) await Task.Delay(Timeout.Infinite, cancellationToken);
            return Result;
        }
    }
    private sealed class Fixture : IDisposable {
        internal string Root = Path.Combine(Path.GetTempPath(), "ltds-access-synthetic-" + Guid.NewGuid().ToString("N"));
        internal string Binary => Path.Combine(Root, "cloudflared-synthetic-not-executable.bin");
        internal string Pin => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Binary)));
        internal Fixture() { Directory.CreateDirectory(Root); File.WriteAllText(Binary, "synthetic binary never executed"); }
        internal CloudflareAccessSession Session(Runner runner) => new(new Uri("https://files.example.invalid/portal"), Binary, Pin, runner);
        public void Dispose() { Directory.Delete(Root, true); }
    }
}
