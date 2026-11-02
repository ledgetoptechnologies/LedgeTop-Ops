using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using Windows.ApplicationModel;
using Windows.Management.Deployment;
using Windows.System;

namespace LedgeTop.Files.Updates;

/// <summary>Installed-only Windows deployment adapter. A nonnull identity must come from an approved
/// compiled release profile; this class supplies no publisher, package or feed defaults.
/// No deployment is requested until the caller explicitly invokes StageDeferredAsync.</summary>
internal sealed class WindowsInstalledUpdatePlatform : IInstalledUpdatePlatform
{
    private readonly InstalledUpdateIdentity? identity;
    private const string Unavailable = "This installed copy cannot use the configured update source.";
    private const string StageFailed = "Windows could not stage the update. Try again later.";

    internal WindowsInstalledUpdatePlatform(InstalledUpdateIdentity? identity)
    {
        if (identity is not null) ValidateIdentity(identity);
        this.identity = identity;
    }

    internal static void ValidateIdentity(InstalledUpdateIdentity value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Channel is not ("pilot" or "stable") || value.PackageName is null ||
            !Regex.IsMatch(value.PackageName, "\\A[A-Za-z0-9][A-Za-z0-9.-]{2,49}\\z") ||
            string.IsNullOrWhiteSpace(value.Publisher) || value.Publisher.Length > 8192 ||
            value.Publisher != value.Publisher.Trim())
            throw new ArgumentException("An approved explicit installed-update identity is required.");
        try { _ = new X500DistinguishedName(value.Publisher); }
        catch (CryptographicException) { throw new ArgumentException("An exact approved publisher distinguished name is required."); }
        var uri = value.FeedUri;
        if (uri is null || !uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps ||
            uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 ||
            !uri.IsDefaultPort || uri.OriginalString != uri.AbsoluteUri ||
            uri.OriginalString.IndexOfAny(['%', '?', '#']) >= 0)
            throw new ArgumentException("A fixed canonical HTTPS App Installer URI is required.");
        var authorityEnd = uri.OriginalString.IndexOf('/', "https://".Length);
        if (authorityEnd < 0 || uri.OriginalString["https://".Length..authorityEnd].IndexOfAny([':', '@']) >= 0)
            throw new ArgumentException("The fixed App Installer URI cannot contain a port or credential.");
    }

    public async Task<InstalledUpdateCheck> CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (identity is null) return new(InstalledUpdateStatus.NotConfigured);
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22621)) return new(InstalledUpdateStatus.Unsupported);
        string? version = null;
        try {
            var validated = FindOwnedPackage();
            if (validated.Package is null) return new(validated.Status);
            version = Version(validated.Package);
            // Package.Current directly has a documented Access denied issue; use the reacquired
            // own package returned by FindPackageForUser instead.
            // https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.package.checkupdateavailabilityasync
            var operation = validated.Package.CheckUpdateAvailabilityAsync();
            var result = await operation.AsTask(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            var status = result.Availability switch {
                PackageUpdateAvailability.NoUpdates => InstalledUpdateStatus.Current,
                PackageUpdateAvailability.Available => InstalledUpdateStatus.Available,
                PackageUpdateAvailability.Required => InstalledUpdateStatus.Required,
                PackageUpdateAvailability.Unknown => InstalledUpdateStatus.Unknown,
                _ => InstalledUpdateStatus.Error
            };
            if (result.ExtendedError is { HResult: < 0 }) status = InstalledUpdateStatus.Error;
            return new(status, version);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception) { return new(InstalledUpdateStatus.Error, version); }
    }

    public async Task StageDeferredAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (identity is null || !OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22621))
            throw new InstalledUpdateException(Unavailable);
        try {
            if (FindOwnedPackage().Package is null) throw new InstalledUpdateException(Unavailable);
            cancellationToken.ThrowIfCancellationRequested();
            var manager = new PackageManager();
            // App Installer URI support starts at build22556, so the runtime gate deliberately
            // requires released22621 even though this method itself exists on19041.
            // https://learn.microsoft.com/en-us/uwp/api/windows.management.deployment.packagemanager.addpackagebyuriasync
            // https://learn.microsoft.com/en-us/uwp/api/windows.management.deployment.addpackageoptions.deferregistrationwhenpackagesareinuse
            var operation = manager.AddPackageByUriAsync(identity.FeedUri, new AddPackageOptions {
                DeferRegistrationWhenPackagesAreInUse = true
            });
            // Keep the deployment operation alive and observe it. Success means staging/deferred
            // registration was accepted, never that this running process has changed version.
            var result = await operation.AsTask(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (result.ExtendedErrorCode is { HResult: < 0 }) throw new InstalledUpdateException(StageFailed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (InstalledUpdateException) { throw; }
        catch (Exception) { throw new InstalledUpdateException(StageFailed); }
    }

    private (Package? Package, InstalledUpdateStatus Status) FindOwnedPackage()
    {
        // Distinguish unpackaged previews without constructing any WinRT package object.
        uint length = 0;
        var presence = Native.GetCurrentPackageFullName(ref length, 0);
        if (presence == 15700) return (null, InstalledUpdateStatus.NotInstalled); // APPMODEL_ERROR_NO_PACKAGE
        if (presence != 122) return (null, InstalledUpdateStatus.Error); // ERROR_INSUFFICIENT_BUFFER proves identity exists.
        var current = Package.Current;
        var status = ValidatePackage(current);
        if (status != InstalledUpdateStatus.Current) return (null, status);
        var package = new PackageManager().FindPackageForUser(string.Empty, current.Id.FullName);
        if (package is null || package.Id.FullName != current.Id.FullName) return (null, InstalledUpdateStatus.Error);
        status = ValidatePackage(package);
        return status == InstalledUpdateStatus.Current ? (package, status) : (null, status);
    }

    private InstalledUpdateStatus ValidatePackage(Package package)
    {
        if (package.Id.Name != identity!.PackageName || package.Id.Publisher != identity.Publisher)
            return InstalledUpdateStatus.NotInstalled;
        if (package.IsDevelopmentMode || package.Id.Architecture != ProcessorArchitecture.X64)
            return InstalledUpdateStatus.Unsupported;
        var association = package.GetAppInstallerInfo();
        if (association is null) return InstalledUpdateStatus.NotConfigured;
        if (association.Uri is null || association.Uri.OriginalString != identity.FeedUri.AbsoluteUri)
            return InstalledUpdateStatus.Error;
        return InstalledUpdateStatus.Current;
    }

    private static string Version(Package package)
    {
        var version = package.Id.Version;
        return FormattableString.Invariant($"{version.Major}.{version.Minor}.{version.Build}.{version.Revision}");
    }
    private static class Native
    {
        [DllImport("kernel32.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int GetCurrentPackageFullName(ref uint packageFullNameLength, nint packageFullName);
    }
}
