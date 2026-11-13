namespace LedgeTop.Files.Backends;

// This is a temporary hold on the exact retired pilot origins. A replacement
// source requires a reviewed release-profile and qualification change.
internal static class RetiredStagingSource
{
    internal const string Message = "This test version's staging connection is unavailable. Keep your existing files folder; online-only files may be unavailable. Contact LedgeTop support for an updated version.";

    internal static bool IsHeld(bool packaged, ReleaseChannel? channel, Uri origin) =>
        packaged && channel == ReleaseChannel.Pilot && origin.IsAbsoluteUri &&
        origin.Scheme == Uri.UriSchemeHttps && origin.IsDefaultPort &&
        (origin.Host.Equals("ops-staging.ledgetopdroneservices.com", StringComparison.OrdinalIgnoreCase) ||
         origin.Host.Equals("portal-staging.ledgetopdroneservices.com", StringComparison.OrdinalIgnoreCase));
}
