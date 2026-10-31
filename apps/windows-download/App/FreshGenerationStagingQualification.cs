using LedgeTop.Files.Backends;

namespace LedgeTop.Files;

// A separate, explicitly compiled pilot build only. The release metadata and
// exact trusted staging origin are both checked again at each operation boundary.
internal static class FreshGenerationStagingQualification
{
    internal static bool UpdaterAvailable =>
#if LEDGETOP_FRESH_GENERATION_STAGING
        false;
#else
        true;
#endif
    internal static bool Allows(string channel, string alias, string origin)
    {
#if LEDGETOP_FRESH_GENERATION_STAGING
        var compiled = ReleaseProfiles.Compiled(typeof(FreshGenerationStagingQualification).Assembly);
        return compiled is { Packaged: true, Channel: ReleaseChannel.Pilot } && channel == "pilot" && alias == "employee" &&
            origin == "https://ops-staging.ledgetopdroneservices.com";
#else
        return false;
#endif
    }
    internal static bool Allows(FreshGenerationPlan.Scope scope) => Allows(scope.Channel, scope.Source, scope.Origin);
}
