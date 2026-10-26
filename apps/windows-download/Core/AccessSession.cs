using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

public sealed class LoginRequiredException() : Exception("Sign in explicitly before accessing your files.");
public sealed class AccessDeniedException() : Exception("Access to this resource was denied.");
internal sealed record AccessCommandResult(int ExitCode, string Stdout, string Stderr);
internal interface IAccessCommandRunner
{
    Task<AccessCommandResult> RunAsync(string binaryPath, IReadOnlyList<string> arguments, CancellationToken cancellationToken);
}

/// <summary>Uses cloudflared's own per-user cache. Tokens are never persisted or logged by this app.
/// Local JWT decoding is only an expiry sanity check; the server verifies identity and authority.</summary>
public sealed class CloudflareAccessSession
{
    private readonly string binaryPath;
    private readonly string binarySha256;
    private readonly IAccessCommandRunner runner;
    private readonly object tokenPins = new();
    private byte[]? pinnedTokenDigest;
    private int pinCount, pendingPins, activeLogins;
    private bool pinInvalidated;
    public Uri Origin { get; }
    public Uri ProtectedApplicationUrl { get; }

    public CloudflareAccessSession(Uri protectedApplicationUrl, string trustedCloudflaredPath, string expectedSha256)
        : this(protectedApplicationUrl, trustedCloudflaredPath, expectedSha256, new AccessCommandRunner()) { }

    internal CloudflareAccessSession(Uri protectedApplicationUrl, string trustedCloudflaredPath, string expectedSha256, IAccessCommandRunner runner)
    {
        if (!protectedApplicationUrl.IsAbsoluteUri || protectedApplicationUrl.Scheme != Uri.UriSchemeHttps
            || protectedApplicationUrl.UserInfo.Length != 0 || protectedApplicationUrl.Query.Length != 0
            || protectedApplicationUrl.Fragment.Length != 0 || protectedApplicationUrl.AbsolutePath == "/")
            throw new ArgumentException("A fixed path-scoped HTTPS Access application URL is required.");
        if (!Path.IsPathFullyQualified(trustedCloudflaredPath)
            || (OperatingSystem.IsWindows() && trustedCloudflaredPath.StartsWith("\\\\", StringComparison.Ordinal))
            || !Regex.IsMatch(expectedSha256, "\\A[0-9a-fA-F]{64}\\z"))
            throw new ArgumentException("An absolute local pinned cloudflared binary is required.");
        ProtectedApplicationUrl = protectedApplicationUrl;
        Origin = new Uri(protectedApplicationUrl.GetLeftPart(UriPartial.Authority));
        binaryPath = Path.GetFullPath(trustedCloudflaredPath);
        binarySha256 = expectedSha256;
        this.runner = runner;
        VerifyBinary();
    }

    private void VerifyBinary()
    {
        try {
            string? path = binaryPath;
            while (path is not null) {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException();
                path = Path.GetDirectoryName(path);
            }
            using var stream = new FileStream(binaryPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!Convert.ToHexString(SHA256.HashData(stream)).Equals(binarySha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException();
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
            throw new TransferException("The trusted cloudflared binary is unavailable or its integrity check failed.");
        }
    }

    public async Task ExplicitLoginAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (tokenPins) {
            // Reserve before awaiting: a pin cannot race an interactive login already in progress,
            // and login cannot enter between a cached pin read and its publication.
            if (pinCount != 0 || pendingPins != 0) throw new LoginRequiredException();
            activeLogins++;
        }
        try {
            // This is the only operation allowed to trigger cloudflared's interactive browser login.
            var result = await RunAsync(["access", "login", "--app", ProtectedApplicationUrl.AbsoluteUri, "--quiet"], cancellationToken);
            if (result.ExitCode != 0) throw new LoginRequiredException();
        } finally { lock (tokenPins) activeLogins--; }
    }

    /// <summary>Reads the normal cached credential without browser interaction and pins its identity
    /// in memory for a bounded operation. Any different credential observed before an HTTP header
    /// is returned invalidates all overlapping leases, even if the cache later switches back.
    /// The lease exposes no credential or digest and must be disposed when the operation finishes.</summary>
    public async Task<IDisposable> PinCachedTokenAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (tokenPins) {
            if (activeLogins != 0 || pinInvalidated) throw new LoginRequiredException();
            pendingPins++;
        }
        byte[]? digest = null;
        try {
            var token = await GetTokenAsync(cancellationToken);
            digest = TokenDigest(token);
            lock (tokenPins) {
                cancellationToken.ThrowIfCancellationRequested();
                if (pinInvalidated || pinnedTokenDigest is not null &&
                    !CryptographicOperations.FixedTimeEquals(pinnedTokenDigest, digest)) {
                    pinInvalidated = pinCount != 0;
                    throw new LoginRequiredException();
                }
                if (pinCount == 0) { pinnedTokenDigest = digest; digest = null; }
                pinCount++;
                return new TokenPin(this);
            }
        } finally {
            if (digest is not null) CryptographicOperations.ZeroMemory(digest);
            lock (tokenPins) pendingPins--;
        }
    }

    private static byte[] TokenDigest(string token)
    {
        var bytes = Encoding.UTF8.GetBytes(token);
        try { return SHA256.HashData(bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private void ReleaseTokenPin()
    {
        lock (tokenPins) {
            if (--pinCount != 0) return;
            CryptographicOperations.ZeroMemory(pinnedTokenDigest!);
            pinnedTokenDigest = null; pinInvalidated = false;
        }
    }

    private sealed class TokenPin(CloudflareAccessSession owner) : IDisposable
    {
        private CloudflareAccessSession? current = owner;
        public void Dispose() => Interlocked.Exchange(ref current, null)?.ReleaseTokenPin();
    }

    internal async Task<string> GetTokenAsync(CancellationToken cancellationToken = default)
    {
        // Unlike access login/curl, access token only reads an existing cached application token.
        var result = await RunAsync(["access", "token", "--app", ProtectedApplicationUrl.AbsoluteUri], cancellationToken);
        if (result.ExitCode != 0) throw new LoginRequiredException();
        var token = result.Stdout.Trim();
        try {
            if (token.Length > 32768 || !Regex.IsMatch(token, "\\A[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\z"))
                throw new FormatException();
            var payload = token.Split('.')[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
            using var json = JsonDocument.Parse(Convert.FromBase64String(payload));
            if (!json.RootElement.TryGetProperty("exp", out var exp) || !exp.TryGetInt64(out var expiry)
                || expiry <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 5) throw new FormatException();
        } catch (Exception error) when (error is FormatException or JsonException or InvalidOperationException) {
            throw new LoginRequiredException();
        }
        lock (tokenPins) {
            cancellationToken.ThrowIfCancellationRequested();
            if (pinCount != 0) {
                var digest = TokenDigest(token);
                try {
                    if (pinInvalidated || !CryptographicOperations.FixedTimeEquals(pinnedTokenDigest!, digest)) {
                        pinInvalidated = true;
                        throw new LoginRequiredException();
                    }
                } finally { CryptographicOperations.ZeroMemory(digest); }
            }
        }
        return token;
    }

    private async Task<AccessCommandResult> RunAsync(string[] arguments, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        VerifyBinary();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(arguments[1] == "login" ? TimeSpan.FromMinutes(5) : TimeSpan.FromMinutes(1));
        try {
            var result = await runner.RunAsync(binaryPath, arguments, deadline.Token);
            if (result.Stdout.Length > 32768 || result.Stderr.Length > 32768) throw new LoginRequiredException();
            return result;
        } catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception) { throw new LoginRequiredException(); }
    }
}

internal sealed class AccessCommandRunner : IAccessCommandRunner
{
    public async Task<AccessCommandResult> RunAsync(string binaryPath, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(binaryPath) {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new LoginRequiredException();
        using var stop = cancellationToken.Register(() => Kill(process));
        try {
            var stdout = ReadBoundedAsync(process.StandardOutput, process, cancellationToken);
            var stderr = ReadBoundedAsync(process.StandardError, process, cancellationToken);
            await Task.WhenAll(stdout, stderr, process.WaitForExitAsync(cancellationToken));
            return new(process.ExitCode, await stdout, await stderr);
        } catch { Kill(process); throw; }
    }

    private static void Kill(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, Process process, CancellationToken cancellationToken)
    {
        var output = new StringBuilder(); var buffer = new char[1024];
        while (true) {
            var count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (count == 0) return output.ToString();
            if (output.Length + count > 32768) { Kill(process); throw new LoginRequiredException(); }
            output.Append(buffer, 0, count);
        }
    }
}
