using LedgeTop.Files.Explorer;

internal static class CurrentProcessPackageContextTests
{
    internal static int Run()
    {
        Require(CurrentProcessPackageContextObserver.Classify(15700, 0).Kind == CurrentProcessPackageContextKind.NoPackage);
        Require(CurrentProcessPackageContextObserver.Classify(15700, uint.MaxValue).Kind == CurrentProcessPackageContextKind.NoPackage);
        Require(CurrentProcessPackageContextObserver.Classify(15700, 31, 0, 31, new char[31]).Kind == CurrentProcessPackageContextKind.Unknown);
        foreach (int status in new[] { 0, 5, 87, -1, 122 })
            Require(CurrentProcessPackageContextObserver.Classify(status, 0).Kind == CurrentProcessPackageContextKind.Unknown);
        foreach (uint length in new uint[] { 0, 1, 30, 129, uint.MaxValue })
            Require(CurrentProcessPackageContextObserver.Classify(122, length, 0, length, []).Kind == CurrentProcessPackageContextKind.Unknown);
        const string name = "AAA_1.0.0.0_x64__1234567890123";
        var valid = (name + '\0').ToCharArray();
        Require(valid.Length == 31);
        Require(CurrentProcessPackageContextObserver.Classify(122, 31, 0, 31, valid).Kind == CurrentProcessPackageContextKind.HasPackage);
        var maximum = (new string('A', 127) + '\0').ToCharArray();
        Require(CurrentProcessPackageContextObserver.Classify(122, 128, 0, 128, maximum).Kind == CurrentProcessPackageContextKind.HasPackage);
        foreach (int readStatus in new[] { 5, 122, 15700, -1 })
            Require(CurrentProcessPackageContextObserver.Classify(122, 31, readStatus, 31, valid).Kind == CurrentProcessPackageContextKind.Unknown);
        Require(CurrentProcessPackageContextObserver.Classify(122, 31).Kind == CurrentProcessPackageContextKind.Unknown);
        Require(CurrentProcessPackageContextObserver.Classify(122, 31, 0, 32, valid).Kind == CurrentProcessPackageContextKind.Unknown);
        Require(CurrentProcessPackageContextObserver.Classify(122, 31, 0, 30, valid).Kind == CurrentProcessPackageContextKind.Unknown);
        Require(CurrentProcessPackageContextObserver.Classify(122, 31, 0, 31, null).Kind == CurrentProcessPackageContextKind.Unknown);
        foreach (char invalid in new[] { '\0', '\n', '\\', ':', ' ', '\uD800' }) {
            var corrupt = valid.ToArray(); corrupt[4] = invalid;
            Require(CurrentProcessPackageContextObserver.Classify(122, 31, 0, 31, corrupt).Kind == CurrentProcessPackageContextKind.Unknown);
        }
        var unterminated = valid.ToArray(); unterminated[^1] = 'A';
        Require(CurrentProcessPackageContextObserver.Classify(122, 31, 0, 31, unterminated).Kind == CurrentProcessPackageContextKind.Unknown);
        // DTO cannot accidentally serialize an identity buffer/name or infer another process.
        Require(typeof(CurrentProcessPackageContextObservation).GetProperties().Select(property => property.Name)
            .Order(StringComparer.Ordinal).SequenceEqual(new[] { "Kind", "QueryStatus", "ReadStatus" }.Order(StringComparer.Ordinal)));
        Console.WriteLine("PASS current-process package-context pure policy; no native identity query.");
        return 0;
    }
    private static void Require(bool condition) { if (!condition) throw new IOException("Package-context pure policy failed."); }
}
