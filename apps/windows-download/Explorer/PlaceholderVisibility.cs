using System.Runtime.InteropServices;

namespace LedgeTop.Files.Explorer;

/// <summary>
/// Exposes Cloud Files metadata for one synchronous metadata inspection on the current thread.
/// Never keep this scope across an await. Restores the caller's previous compatibility mode.
/// </summary>
internal readonly struct PlaceholderVisibility : IDisposable
{
    private readonly sbyte previous;
    private readonly int thread;
    private PlaceholderVisibility(sbyte previous)
    {
        this.previous = previous; thread = Environment.CurrentManagedThreadId;
    }

    internal static PlaceholderVisibility Expose()
    {
        // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/content/ntifs/nf-ntifs-rtlsetthreadplaceholdercompatibilitymode
        var previous = RtlSetThreadPlaceholderCompatibilityMode(2); // PHCM_EXPOSE_PLACEHOLDERS
        if (previous < 0) throw new IOException("Windows could not expose Cloud Files metadata on this thread.");
        return new(previous);
    }

    internal static T Run<T>(Func<T> inspect)
    {
        ArgumentNullException.ThrowIfNull(inspect);
        using var scope = Expose();
        return inspect();
    }

    internal static void Run(Action inspect)
    {
        ArgumentNullException.ThrowIfNull(inspect);
        using var scope = Expose();
        inspect();
    }

    public void Dispose()
    {
        if (Environment.CurrentManagedThreadId != thread)
            throw new InvalidOperationException("A Cloud Files metadata scope crossed threads.");
        if (RtlSetThreadPlaceholderCompatibilityMode(previous) < 0)
            throw new IOException("Windows could not restore the thread's placeholder compatibility mode.");
    }

    [DllImport("ntdll.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern sbyte RtlSetThreadPlaceholderCompatibilityMode(sbyte mode);
}
