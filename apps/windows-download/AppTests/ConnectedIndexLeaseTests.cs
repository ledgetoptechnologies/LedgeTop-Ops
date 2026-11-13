using LedgeTop.Files;

internal static class ConnectedIndexLeaseTests
{
    internal static Task Run()
    {
        var parent = Path.GetFullPath(Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required."));
        var root = Path.Combine(parent, "index-owner-" + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("Synthetic fixture already exists.");
        Directory.CreateDirectory(root);
        var firstPath = Path.Combine(root, "first.lock"); var secondPath = Path.Combine(root, "second.lock");
        var passed = false;
        try {
            using var first = ConnectedIndexLease.Acquire(firstPath, FileMode.CreateNew);
            using var second = ConnectedIndexLease.Acquire(secondPath, FileMode.CreateNew);
            Require(first.StillHeld(first) && second.StillHeld(second) && !first.StillHeld(second), "owner identity mismatch");
            var refused = false;
            try { using var conflict = new FileStream(firstPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { refused = true; }
            Require(refused, "owned lock admitted another handle");
            first.Dispose(); Require(!first.StillHeld(first), "disposed owner still reported held");
            using (var replacement = ConnectedIndexLease.Acquire(firstPath, FileMode.Open)) {
                Require(replacement.StillHeld(replacement) && !first.StillHeld(replacement), "new owner inherited stale identity");
            }
            passed = true;
        } finally {
            if (passed) {
                try {
                    if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0 ||
                        Directory.GetFileSystemEntries(root).Length != 2 ||
                        new[] { firstPath, secondPath }.Any(path => (File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || new FileInfo(path).Length != 0))
                        throw new IOException("Synthetic ownership fixture changed.");
                    File.Delete(firstPath); File.Delete(secondPath); Directory.Delete(root);
                } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
                    Console.WriteLine("Synthetic index ownership cleanup unconfirmed: " + root);
                }
            } else Console.WriteLine("Synthetic index ownership fixture retained: " + root);
        }
        return Task.CompletedTask;
    }
    private static void Require(bool value, string message) { if (!value) throw new IOException(message); }
}
