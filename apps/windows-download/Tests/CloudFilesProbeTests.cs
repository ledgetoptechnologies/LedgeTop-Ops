using System.Security.Cryptography;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class CloudFilesProbeTests {
    public static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("Cloud Files platform results distinguish support, absence and HRESULT errors", PlatformResults),
        ("Cloud Files exact-file metadata rejects unsafe paths and unknown states", MetadataResults),
        ("Cloud Files real Windows owned-file metadata probe is read-only", NativeOwnedFile),
    ];
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    private static Task PlatformResults() {
        var native = new FakeNative(); var probe = new CloudFilesProbe(native);
        var success = probe.GetPlatformInfo();
        Assert(success.Status == CloudFilesProbeStatus.Supported && success.Platform?.IntegrationNumber == 3, "S_OK platform result lost.");
        foreach (var hr in new[] { unchecked((int)0x80070032), unchecked((int)0x80004001) }) {
            native.Platform = new(hr, new(1, 2, 3));
            Assert(probe.GetPlatformInfo().Status == CloudFilesProbeStatus.Unsupported, "Unsupported HRESULT treated as supported.");
        }
        native.Platform = new(unchecked((int)0x80070005), new(1, 2, 3));
        Assert(probe.GetPlatformInfo().Status == CloudFilesProbeStatus.Error, "Native failure treated as unsupported or supported.");
        native.Platform = new(1, new(1, 2, 3));
        Assert(probe.GetPlatformInfo().Status == CloudFilesProbeStatus.Error, "Non-S_OK treated as success.");
        native.Platform = new(0, new(0, 0, 0));
        Assert(probe.GetPlatformInfo().Status == CloudFilesProbeStatus.Error, "Invalid platform info accepted.");
        foreach (var unavailable in new Exception[] { new DllNotFoundException(), new EntryPointNotFoundException(), new PlatformNotSupportedException(), new BadImageFormatException() }) {
            native.Failure = unavailable;
            Assert(probe.GetPlatformInfo().Status == CloudFilesProbeStatus.Unsupported, "Absent native API was not explicit.");
        }
        native.Failure = new InvalidOperationException("private-path-and-native-details");
        var failed = probe.GetPlatformInfo();
        Assert(failed.Status == CloudFilesProbeStatus.Error && !JsonSerializer.Serialize(failed).Contains("private-path"), "Unsafe exception escaped result.");
        return Task.CompletedTask;
    }
    private static Task MetadataResults() {
        var native = new FakeNative(); var probe = new CloudFilesProbe(native);
        foreach (var path in new[] { "", "relative.txt", @"\\server\share\file", @"\\?\C:\file", @"C:\folder\*.bin", @"C:\folder\file:stream", @"C:\folder\..\file", @"C:\folder\.\file", @"C:\folder\", @"C:\file.", @"C:\NUL.txt", @"C:\COM1\file", @"C:\CONIN$", @"C:\CONOUT$.txt", @"C:\COM¹.bin", @"C:\LPT²\file", "C:\\x\nfile", "C:\\" + new string('a', 260) })
            Assert(probe.InspectExistingFile(path).Code == "literal-local-file-required", "Unsafe file path accepted.");
        Assert(native.Calls == 0, "Invalid path reached native boundary.");
        native.State = 0;
        var ordinary = probe.InspectExistingFile(@"C:\synthetic\ordinary.bin");
        Assert(ordinary.Status == CloudFilesProbeStatus.Supported && ordinary.IsPlaceholder == false, "Ordinary file misclassified.");
        native.State = 1 | 8 | 16 | 32;
        var partial = probe.InspectExistingFile(@"C:\synthetic\placeholder.bin");
        Assert(partial.IsPlaceholder == true && partial.State!.Value.HasFlag(CloudPlaceholderState.PartiallyOnDisk), "Placeholder metadata lost.");
        foreach (var state in new uint[] { uint.MaxValue, 0x40, 8, 1 | 32 }) {
            native.State = state;
            Assert(probe.InspectExistingFile(@"C:\synthetic\file.bin").Status == CloudFilesProbeStatus.Error, "Invalid/unknown/inconsistent state accepted.");
        }
        native.Metadata = new(false, 0, 0, 2);
        Assert(probe.InspectExistingFile(@"C:\synthetic\missing.bin").NativeError == 2, "Missing file metadata failure lost.");
        native.Metadata = new(false, 0, 0, 50);
        Assert(probe.InspectExistingFile(@"C:\synthetic\file.bin").Status == CloudFilesProbeStatus.Unsupported, "Unsupported metadata path treated as supported.");
        native.Metadata = new(true, 0x10, 0, 0);
        Assert(probe.InspectExistingFile(@"C:\synthetic\directory").Code == "existing-file-required", "Directory accepted as existing file.");
        native.Metadata = new(true, uint.MaxValue, 0, 0);
        Assert(probe.InspectExistingFile(@"C:\synthetic\file.bin").Status == CloudFilesProbeStatus.Error, "Invalid file attributes accepted.");
        native.Platform = new(unchecked((int)0x80070032), new(1, 2, 3));
        var metadataCalls = native.MetadataCalls;
        Assert(probe.InspectExistingFile(@"C:\synthetic\file.bin").Status == CloudFilesProbeStatus.Unsupported && native.MetadataCalls == metadataCalls, "Unsupported platform touched a file.");
        return Task.CompletedTask;
    }
    private static Task NativeOwnedFile() {
        var probe = new CloudFilesProbe();
        var platform = probe.GetPlatformInfo();
        if (!OperatingSystem.IsWindows()) {
            Assert(platform.Status == CloudFilesProbeStatus.Unsupported, "Non-Windows native boundary was not unsupported.");
            Console.WriteLine("SKIP Cloud Files native acceptance: non-Windows; only unsupported result verified.");
            return Task.CompletedTask;
        }
        Assert(platform.Status == CloudFilesProbeStatus.Supported, "Windows native Cloud Files acceptance held: " + platform.Code);
        var root = Path.Combine(Path.GetTempPath(), "ledgetop-cloud-files-probe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var file = Path.Combine(root, "owned-ordinary.bin");
        try {
            File.WriteAllBytes(file, "owned synthetic Cloud Files capability probe"u8.ToArray());
            var bytes = File.ReadAllBytes(file); var digest = SHA256.HashData(bytes);
            var modified = File.GetLastWriteTimeUtc(file); var attributes = File.GetAttributes(file);
            var result = probe.InspectExistingFile(file);
            Assert(result.Status == CloudFilesProbeStatus.Supported && result.IsPlaceholder == false && result.State == CloudPlaceholderState.None, "Owned ordinary file was not classified correctly.");
            Assert(SHA256.HashData(File.ReadAllBytes(file)).SequenceEqual(digest) && File.GetLastWriteTimeUtc(file) == modified && File.GetAttributes(file) == attributes, "Read-only probe changed owned file.");
            Console.WriteLine(JsonSerializer.Serialize(new { cloudFilesNativeAcceptance = true, platform.Platform, result.State,
                ownedOrdinaryFile = true, contentUnchanged = true, metadataUnchanged = true,
                registration = false, hydration = false, pinMutation = false, explorerIntegration = false }));
        } finally {
            // Exactly the two test-owned paths, no traversal of user folders.
            if (File.Exists(file)) File.Delete(file);
            Directory.Delete(root);
        }
        return Task.CompletedTask;
    }
    private sealed class FakeNative : ICloudFilesNative {
        public NativeCloudPlatform Platform = new(0, new(1, 2, 3));
        public NativeFileAttributeTag Metadata = new(true, 0x20, 0, 0);
        public uint State;
        public int Calls, MetadataCalls;
        public Exception? Failure;
        public NativeCloudPlatform GetPlatformInfo() { Calls++; if (Failure is not null) throw Failure; return Platform; }
        public NativeFileAttributeTag ReadAttributeTag(string path) { Calls++; MetadataCalls++; return Metadata; }
        public uint GetPlaceholderState(uint attributes, uint tag) { Calls++; return State; }
    }
}
