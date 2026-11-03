#if LEDGETOP_NATIVE_DIAGNOSTICS
namespace LedgeTop.Files.Explorer;

// Synthetic comparison only. A published build may not contain this type.
internal static class DiagnosticConnectionFlags
{
    internal static int Connect(Func<uint, int> connect, bool blockSelfImplicitHydration) =>
        connect(4u | (blockSelfImplicitHydration ? 8u : 0u));
}
#endif
