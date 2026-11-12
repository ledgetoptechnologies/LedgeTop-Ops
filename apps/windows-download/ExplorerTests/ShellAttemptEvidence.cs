using System.Text.Json;

// Test-only evidence, not an ownership grant. Missing or zero identities mean unknown,
// and a partial outcome must never be replayed or automatically unregistered.
internal static class ShellAttemptEvidence
{
    internal sealed record Intent(Guid PreviewId, string Root, string ShellId, string IconResource, string DisplayName, string ContextBase64);
    internal sealed record Partial(Guid PreviewId, string Root, string ShellId, string IconResource, string DisplayName,
        long RootFileId, Guid NamespaceClsid, bool OwnershipVerified = false);

    internal static void WriteNew<T>(string file, T value)
    {
        using var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        JsonSerializer.Serialize(stream, value);
        stream.Flush(flushToDisk: true);
    }
}
