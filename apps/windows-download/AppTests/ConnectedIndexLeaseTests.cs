using LedgeTop.Files;
using System.Runtime.InteropServices;

internal static class ConnectedIndexLeaseTests
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLinkW(string link, string existing, IntPtr securityAttributes);
    internal static void CreateSyntheticHardLink(string link, string existing)
    {
        if (!CreateHardLinkW(link, existing, IntPtr.Zero)) throw new IOException("Could not create synthetic hardlink: " + Marshal.GetLastWin32Error());
    }
    internal static Task Run()
    {
        var parent = Path.GetFullPath(Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required."));
        var root = Path.Combine(parent, "index-owner-" + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("Synthetic fixture already exists.");
        Directory.CreateDirectory(root);
        var firstPath = Path.Combine(root, "first.lock"); var secondPath = Path.Combine(root, "second.lock");
        var linkedPath = Path.Combine(root, "linked.lock"); var aliasPath = Path.Combine(root, "alias.lock");
        var passed = false;
        try {
            using var first = ConnectedIndexLease.Acquire(firstPath, FileMode.CreateNew);
            using var second = ConnectedIndexLease.Acquire(secondPath, FileMode.CreateNew);
            Require(first.StillHeld(first) && second.StillHeld(second) && !first.StillHeld(second), "owner identity mismatch");
            var refused = false;
            try { using var conflict = new FileStream(firstPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { refused = true; }
            Require(refused, "owned lock admitted another handle");
            using var transferred = first.Transfer();
            first.Dispose(); Require(!first.StillHeld(first) && transferred.StillHeld(transferred), "transferred owner was lost or old alias survived");
            refused = false;
            try { using var conflict = new FileStream(firstPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { refused = true; }
            Require(refused, "stale owner disposal released transferred lock");
            transferred.Dispose(); Require(!transferred.StillHeld(transferred), "disposed owner still reported held");
            using (var replacement = ConnectedIndexLease.Acquire(firstPath, FileMode.Open)) {
                Require(replacement.StillHeld(replacement) && !first.StillHeld(replacement), "new owner inherited stale identity");
            }
            using (File.Create(linkedPath)) { }
            CreateSyntheticHardLink(aliasPath, linkedPath);
            var pinRejected = false;
            try { using var invalid = ConnectedIndexLease.Acquire(linkedPath, FileMode.Open); }
            catch (IOException) { pinRejected = true; }
            Require(pinRejected, "multi-link file passed the physical lock pin");
            using (new FileStream(linkedPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            passed = true;
        } finally {
            if (passed) {
                try {
                    if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0 ||
                        Directory.GetFileSystemEntries(root).Length != 4 ||
                        new[] { firstPath, secondPath, linkedPath, aliasPath }.Any(path => (File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || new FileInfo(path).Length != 0))
                        throw new IOException("Synthetic ownership fixture changed.");
                    File.Delete(firstPath); File.Delete(secondPath); File.Delete(aliasPath); File.Delete(linkedPath); Directory.Delete(root);
                } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
                    Console.WriteLine("Synthetic index ownership cleanup unconfirmed: " + root);
                }
            } else Console.WriteLine("Synthetic index ownership fixture retained: " + root);
        }
        return Task.CompletedTask;
    }
    private static void Require(bool value, string message) { if (!value) throw new IOException(message); }
}
