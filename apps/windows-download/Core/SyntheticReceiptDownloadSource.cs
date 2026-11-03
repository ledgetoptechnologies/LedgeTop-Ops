#if LEDGETOP_CACHE_RACE_TEST
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;

namespace LedgeTop.WindowsDownload;

// Sealed no-network source for receipt-session tests only. No Access session,
// delegating handler, arbitrary callbacks, redirects, or external transport.
internal sealed class SyntheticReceiptDownloadSource
{
    private readonly DownloadSpec spec;
    private readonly byte[] bytes;
    private readonly bool ignoreCancellation, timeoutAfterRelease, blockCancellationCallback;
    private int claimed;
    private readonly TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource callbackEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource callbackReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private SyntheticReceiptDownloadSource(DownloadSpec spec, byte[] bytes, bool ignoreCancellation, bool timeoutAfterRelease, bool blockCancellationCallback) { this.spec = spec; this.bytes = bytes; this.ignoreCancellation = ignoreCancellation; this.timeoutAfterRelease = timeoutAfterRelease; this.blockCancellationCallback = blockCancellationCallback; }
    internal static SyntheticReceiptDownloadSource Create(DownloadSpec spec, byte[] bytes, bool ignoreCancellation = false, bool timeoutAfterRelease = false, bool blockCancellationCallback = false)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (!spec.ContentUri.IsAbsoluteUri || spec.ContentUri.Scheme != "https" || spec.ContentUri.UserInfo.Length != 0 || spec.ContentUri.Fragment.Length != 0 ||
            !spec.ContentUri.Host.EndsWith(".invalid", StringComparison.OrdinalIgnoreCase) || spec.Length != bytes.LongLength ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), Convert.FromHexString(spec.Sha256)))
            throw new IOException("Synthetic receipt source is invalid.");
        return new(spec, bytes.ToArray(), ignoreCancellation, timeoutAfterRelease, blockCancellationCallback);
    }
    internal Task Entered => entered.Task;
    internal void Release() => released.TrySetResult();
    internal Task CallbackEntered => callbackEntered.Task;
    internal void ReleaseCancellationCallback() => callbackReleased.TrySetResult();
    internal Downloader Claim(DownloadSpec expected)
    {
        if (expected != spec || Interlocked.Exchange(ref claimed, 1) != 0) throw new IOException("Synthetic receipt source is unavailable.");
        return new Downloader(new Handler(this), [new Uri(spec.ContentUri.GetLeftPart(UriPartial.Authority))]) { ExperimentalColdOwnedStreamForTest = true };
    }
    private sealed class Handler(SyntheticReceiptDownloadSource source) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method != HttpMethod.Get || request.RequestUri != source.spec.ContentUri || request.Headers.Range is not null ||
                request.Headers.Contains("Cookie") || request.Headers.Contains("Cf-Access-Jwt-Assertion"))
                throw new IOException("Synthetic receipt request is invalid.");
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new HeldStream(source)) };
            response.Headers.ETag = new EntityTagHeaderValue(source.spec.ETag); response.Content.Headers.ContentLength = source.bytes.Length;
            return Task.FromResult(response);
        }
    }
    private sealed class HeldStream(SyntheticReceiptDownloadSource source) : MemoryStream(source.bytes, writable: false)
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            using var registration = source.blockCancellationCallback ? token.Register(() => { source.callbackEntered.TrySetResult(); source.callbackReleased.Task.GetAwaiter().GetResult(); }) : default;
            source.entered.TrySetResult();
            // Keep the callback registered until the test explicitly releases the read;
            // WaitAsync(token) can otherwise complete first and dispose the registration.
            if (source.ignoreCancellation || source.blockCancellationCallback) await source.released.Task.ConfigureAwait(false);
            else await source.released.Task.WaitAsync(token).ConfigureAwait(false);
            if (source.timeoutAfterRelease) throw new TimeoutException("Synthetic source timeout.");
            return await base.ReadAsync(buffer, source.ignoreCancellation ? CancellationToken.None : token).ConfigureAwait(false);
        }
    }
}
#endif
