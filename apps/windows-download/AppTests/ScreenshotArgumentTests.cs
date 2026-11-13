using System;
using System.IO;
using System.Linq;

internal static class ScreenshotArgumentTests
{
    internal static string Resolve(string[] args) =>
        args.FirstOrDefault(arg => !arg.StartsWith("--", StringComparison.Ordinal))
        ?? Path.Combine(Path.GetTempPath(), "ltfiles-screens-" + Guid.NewGuid().ToString("N"));

    internal static void Run()
    {
        var flagOnly = Resolve(new[] { "--connection-diagnostics-only" });
        if (!Path.IsPathFullyQualified(flagOnly) || Path.GetFileName(flagOnly).StartsWith("--", StringComparison.Ordinal))
            throw new Exception("A flag was treated as the screenshot directory.");
        const string path = "explicit-screenshots";
        if (Resolve(new[] { path, "--connection-diagnostics-only" }) != path ||
            Resolve(new[] { "--connection-diagnostics-only", path }) != path)
            throw new Exception("An explicit screenshot directory was not preserved.");
    }
}
