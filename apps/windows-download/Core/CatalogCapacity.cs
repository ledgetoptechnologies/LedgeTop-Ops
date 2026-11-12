namespace LedgeTop.WindowsDownload;

// Test-only capacity experiment: release builds retain their established boundary.
public static class CatalogCapacity
{
#if LEDGETOP_LARGE_CATALOG_TEST
    public const int MaximumEntries = 5000;
#else
    public const int MaximumEntries = 1000;
#endif
}
