using System.Security.Cryptography;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

internal static class ConnectionFailureDiagnosticsTests
{
    internal static async Task Run()
    {
        const string privateValue = "private URL https://private.invalid/token/secret; account and path C:\\private\\person";
        var transfer = new TransferException(privateValue, TransferFailureReason.UnexpectedHttpStatus, 503);
        transfer.Data[privateValue] = privateValue;
        var text = ConnectionFailureTrace.Format(ConnectionAction.Recheck, ConnectionPhase.CurrentSession, transfer);
        Need(text == "Connection action failed. Support code: connection/Recheck/CurrentSession/Transfer/UnexpectedHttpStatus; HTTP 503",
            "only fixed operation/phase/category/reason and numeric HTTP are formatted");
        var other = new TransferException("different confidential metadata", TransferFailureReason.UnexpectedHttpStatus, 503);
        Need(text == ConnectionFailureTrace.Format(ConnectionAction.Recheck, ConnectionPhase.CurrentSession, other),
            "message and exception Data cannot influence diagnostic output");
        var unknown = ConnectionFailureTrace.Format(ConnectionAction.ExplicitConnect, ConnectionPhase.DisposePrevious,
            new Exception(privateValue, new IOException(privateValue)), settings: true);
        Need(unknown.EndsWith("settings/ExplicitConnect/DisposePrevious/Unknown/Unknown", StringComparison.Ordinal) && !unknown.Contains(privateValue, StringComparison.Ordinal),
            "unknown type and inner exception never leak strings or type names");
        Need(ConnectionFailureTrace.Format(ConnectionAction.Recheck, ConnectionPhase.CurrentSession,
            new LoginRequiredException(LoginFailureReason.TokenExpired, LoginFailureOperation.CachedToken)).Contains("auth=CachedToken/TokenExpired", StringComparison.Ordinal),
            "cached credential reason survives without any credential value");
        Need(ConnectionFailureTrace.Format(ConnectionAction.Recheck, ConnectionPhase.SourceSession,
            new LoginRequiredException(LoginFailureReason.HttpUnauthorized, LoginFailureOperation.QueueSession)).EndsWith("auth=QueueSession/HttpUnauthorized; HTTP 401", StringComparison.Ordinal),
            "401 and helper/token expiration are distinguishable");

        var root = Path.Combine(Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? Path.GetTempPath(), "connection-diagnostic-gateway-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var binary = Path.Combine(root, "inert-constructor-fixture.exe");
        await File.WriteAllBytesAsync(binary, "inert fixture never executed"u8.ToArray());
        var pin = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(binary)));
        var access = new CloudflareAccessSession(new Uri("https://session-diagnostic.invalid/api/staff/files"), binary, pin);
        var probe = new DiagnosticSource();
        var session = new LiveBackend.LiveSession(access, probe);
        foreach (var failure in new Exception[] {
            new LoginRequiredException(LoginFailureReason.TokenExpired, LoginFailureOperation.CachedToken),
            new LoginRequiredException(LoginFailureReason.HttpUnauthorized, LoginFailureOperation.QueueSession),
            new TransferException(privateValue, TransferFailureReason.UnexpectedHttpStatus, 502)
        }) {
            probe.Failure = failure; var before = probe.Calls;
            try { await ((IConnectionSessionGateway)session).CheckCurrentForConnectionAsync(); throw new InvalidOperationException("Failure required."); }
            catch (Exception observed) when (ReferenceEquals(observed, failure)) { }
            Need(probe.Calls == before + 1, "diagnostic session performs the same single authoritative source check, without retry or helper login");
            if (failure is LoginRequiredException) {
                Need(await session.TryCurrentAsync() is null && probe.Calls == before + 2,
                    "ordinary gateway retains null-for-login-required contract with one request");
            }
        }
        probe.Failure = null;
        var current = await ((IConnectionSessionGateway)session).CheckCurrentForConnectionAsync();
        Need(current?.PrincipalId == "synthetic-only", "successful diagnostic current-session adaptation preserves identity");
        Console.WriteLine("Connection diagnostic formatting and actual LiveSession adaptation passed; inert helper bytes only, fake source calls, no helper execution or HTTP.");
    }
    private static void Need(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    private sealed class DiagnosticSource : IQueuedDownloadSource
    {
        internal Exception? Failure;
        internal int Calls;
        public string Alias => "employee";
        public Uri Origin => new("https://session-diagnostic.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        { Calls++; if (Failure is { } error) throw error; return Task.FromResult(new QueuedDownloadSession("synthetic-only", DateTimeOffset.UtcNow.AddHours(1))); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
    }
}
