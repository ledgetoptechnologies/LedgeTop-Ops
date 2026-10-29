namespace LedgeTop.Files.Updates;

internal sealed record InstalledUpdateIdentity(string Channel, string PackageName, string Publisher, Uri FeedUri);

internal enum InstalledUpdateStatus
{
    NotConfigured, NotInstalled, Unsupported, Current, Available, Required, Unknown, Error
}

internal sealed record InstalledUpdateCheck(InstalledUpdateStatus Status, string? CurrentVersion = null);

internal interface IInstalledUpdatePlatform
{
    Task<InstalledUpdateCheck> CheckAsync(CancellationToken cancellationToken);
    Task StageDeferredAsync(CancellationToken cancellationToken);
}

internal sealed class InstalledUpdateException(string message) : Exception(message);
