namespace LedgeTop.WindowsDownload;

/// <summary>Opt-in for trusted adapters whose Resolve response carries fresh caller/resource authority.
/// Never inferred from an alias. Unknown sources retain separate Session checks.</summary>
internal interface IHydrationAuthoritySource
{
    bool ResolveCarriesCurrentAuthority { get; }
}
