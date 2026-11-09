namespace LedgeTop.WindowsDownload;

/// <summary>Prefer multiplexed HTTP/2 while retaining compatibility with HTTP/1.1 origins.</summary>
internal static class HttpRequestProtocol
{
    internal static void PreferHttp2(HttpRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        request.Version = System.Net.HttpVersion.Version20;
        request.VersionPolicy = HttpVersionPolicy.RequestVersionOrLower;
    }
}
