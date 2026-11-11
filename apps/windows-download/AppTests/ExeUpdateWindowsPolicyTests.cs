using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Formats.Asn1;

internal static class ExeUpdateWindowsPolicyTests
{
    internal static void TrustedForeignSignerProbe(string path) {
        try { WindowsAuthenticodePublisher.RequireTrustedCompanyInstallerForTest(path, "1.3.6.1.4.1.311.97.123.456.789"); }
        catch (IOException error) when (error.Message == "The installer publisher does not match Ledge Top Technologies LLC.") {
            Console.WriteLine("PASS trusted primary WinTrust signer extracted and foreign publisher refused; no Artifact Signing acceptance tested."); return;
        }
        throw new Exception("The trusted foreign signer was not observed and refused as expected.");
    }
    internal static async Task Run()
    {
        foreach (var alias in new[] { "portal", "employee" }) {
            var arguments = ExeUpdateWindowsPolicy.RelaunchArguments(alias);
            Require(arguments.SequenceEqual([ExeUpdateWindowsPolicy.ResumeSavedSourceArgument, alias]) && arguments.Count == 2,
                "fixed resume arguments contain only flag and selected source alias");
            try { ((IList<string>)arguments)[1] = "other"; throw new Exception("Mutable relaunch arguments."); }
            catch (NotSupportedException) { }
        }
        foreach (var badAlias in new string?[] { null, "", "Portal", "other", "portal employee", "--demo", @"C:\private\file", "credential-shaped-input" }) {
            try { ExeUpdateWindowsPolicy.RelaunchArguments(badAlias); throw new Exception("Unsupported relaunch source accepted."); }
            catch (IOException error) { Require(error.Message == "The saved update source is unsupported.", "unsupported aliases are refused without echoing private input"); }
        }
        await MetadataChecks();
        Require(ExeUpdateWindowsPolicy.MinimumWindowsBuild == 22000, "updater matches installed Windows11 compatibility");
        foreach (var version in new[] { new Version(10, 0, 19045), new Version(10, 0, 21999), new Version(6, 3, 9600) })
            Require(!ExeUpdateWindowsPolicy.SupportedHost(true, version, true), "pre-Windows11 host refused");
        foreach (var version in new[] { new Version(10, 0, 22000), new Version(10, 0, 22621), new Version(10, 0, 26100), new Version(11, 0, 0) })
            Require(ExeUpdateWindowsPolicy.SupportedHost(true, version, true), "all declared Windows11 builds remain eligible");
        Require(!ExeUpdateWindowsPolicy.SupportedHost(false, new(10, 0, 22000), true) &&
            !ExeUpdateWindowsPolicy.SupportedHost(true, new(10, 0, 22000), false) &&
            !ExeUpdateWindowsPolicy.SupportedHost(true, null, true), "non-Windows, x86 or unknown host refused");
        var hash = new string('a', 64); var commit = new string('b', 40);
        var comments = "LedgeTop.Files.Payload/1:" + hash + ":" + commit;
        Require(ExeUpdateInstallerAnchor.Parse(comments) == new ExeUpdateInstallerAnchor(hash, commit), "exact SHA-pinned PE Comments anchor");
        foreach (var bad in new string?[] { null, "", comments + " ", " " + comments, comments + "\n", comments.ToUpperInvariant(),
            comments.Replace("/1:", "/2:", StringComparison.Ordinal), "LedgeTop.Files.Payload/1:" + hash[..63] + ":" + commit,
            "LedgeTop.Files.Payload/1:" + hash + ":" + commit[..39], comments + ":extra" }) {
            try { ExeUpdateInstallerAnchor.Parse(bad); throw new Exception("Accepted invalid anchor."); } catch (IOException) { }
        }
        var owner = new ExeUpdateInstalledOwner("S-1-5-21-111-222-333-1001", 5, "0.5.3.0", @"C:\synthetic\installed",
            "LedgeTop.Files.UnsignedPilotInstaller/1", hash, commit, hash, hash);
        var parent = new ExeUpdateParentIdentity(100, 12345);
        var observed = new ExeUpdateProcessObservation(100, 12345, owner.WindowsSid, owner.SessionId, Path.Combine(owner.InstallRoot, "LedgeTop.Files.exe"));
        Require(ExeUpdateWindowsPolicy.SamePeer(observed, parent, owner), "matching retained OS observations");
        foreach (var wrong in new[] { observed with { ProcessId = 101 }, observed with { StartTimeUtcTicks = 99999 },
            observed with { Sid = "S-1-5-21-999-222-333-1001" }, observed with { SessionId = 9 }, observed with { ImagePath = @"C:\other\LedgeTop.Files.exe" } })
            Require(!ExeUpdateWindowsPolicy.SamePeer(wrong, parent, owner), "PID reuse/other user/session/image refused");

        var log = new List<string>();
        Task Arm() { log.Add("arm"); return Task.CompletedTask; }
        Task Final() { log.Add("final"); return Task.CompletedTask; }
        Task Disarm() { log.Add("stopped"); return Task.CompletedTask; }
        Require(await ExeUpdateExitCommit.InvokeAsync(async finish => { await finish(); log.Add("close"); return ExeUpdateParentExitDecision.Accepted; }, Arm, Final, Disarm) ==
            ExeUpdateParentExitDecision.Accepted && string.Join(',', log) == "arm,final,close", "final ACK precedes accepted shutdown");
        log.Clear();
        Require(await ExeUpdateExitCommit.InvokeAsync(_ => Task.FromResult(ExeUpdateParentExitDecision.Rejected), Arm, Final, Disarm) == ExeUpdateParentExitDecision.Rejected &&
            string.Join(',', log) == "arm,stopped", "rejected dispatcher never invokes final intent and confirms stop");
        log.Clear();
        Require(await ExeUpdateExitCommit.InvokeAsync(_ => Task.FromResult(ExeUpdateParentExitDecision.Accepted), Arm, Final, Disarm) == ExeUpdateParentExitDecision.Rejected &&
            !log.Contains("final"), "accepted claim without final ACK is refused");
        log.Clear();
        Require(await ExeUpdateExitCommit.InvokeAsync(async finish => { await finish(); throw new IOException("close fault"); }, Arm, Final, Disarm) == ExeUpdateParentExitDecision.Uncertain &&
            !log.Contains("stopped"), "close exception after ACK retains uncertainty/fences");
        log.Clear();
        Require(await ExeUpdateExitCommit.InvokeAsync(async finish => { await finish(); await finish(); return ExeUpdateParentExitDecision.Accepted; }, Arm, Final, Disarm) ==
            ExeUpdateParentExitDecision.Uncertain && log.Count(x => x == "final") == 1, "final commit delegate one-shot");
        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lostAck = ExeUpdateExitCommit.InvokeAsync(async finish => { await finish(); return ExeUpdateParentExitDecision.Accepted; }, Arm,
            () => throw new IOException("lost ACK"), async () => { stopping.SetResult(); await stopped.Task; });
        await stopping.Task; Require(!lostAck.IsCompleted, "lost final ACK cannot recover before helper positively stops");
        stopped.SetResult(); Require(await lostAck == ExeUpdateParentExitDecision.Rejected, "known stopped helper permits rejected-exit recovery");
        Require(await ExeUpdateExitCommit.InvokeAsync(async finish => { await finish(); return ExeUpdateParentExitDecision.Accepted; }, Arm,
            () => throw new IOException("lost ACK"), () => throw new IOException("unknown stop")) == ExeUpdateParentExitDecision.Uncertain,
            "lost ACK plus unknown helper lifetime cannot recover");

        foreach (var code in new uint[] { 0, 20 }) {
            var process = new Child { Code = code };
            Require(await ExeUpdateInstallerWait.ObserveAsync(process) == (code == 0 ? ExeUpdateInstallResult.Succeeded : ExeUpdateInstallResult.Failed) &&
                process.Waits == 1 && process.Joins == 0, "known installer outcome");
        }
        foreach (var waitThrows in new[] { false, true }) {
            var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var joining = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var process = new Child { TimedOut = true, WaitThrows = waitThrows, Join = async () => { joining.SetResult(); await ended.Task; } };
            var result = ExeUpdateInstallerWait.ObserveAsync(process); await joining.Task;
            Require(!result.IsCompleted && process.Waits == 1 && process.CodeReads == 0, "deadline/unknown wait keeps actual handle owner alive");
            ended.SetResult();
            Require(await result == ExeUpdateInstallResult.Uncertain && process.Waits == 1 && process.Joins == 1 && process.CodeReads == 0,
                "natural late termination never causes retry or late-success relabeling");
        }
        Require(await ExeUpdateInstallerWait.ObserveAsync(new Child { CodeThrows = true }) == ExeUpdateInstallResult.Uncertain, "unknown exit code is not success");
        Console.WriteLine("Windows update policy tests passed; the unsigned local test executable was refused before update execution.");
    }
    private static async Task MetadataChecks()
    {
        Require(WindowsAuthenticodePublisher.MatchesExpectedCommonName("Ledge Top Technologies LLC") &&
            !WindowsAuthenticodePublisher.MatchesExpectedCommonName("LedgeTop Technologies LLC") &&
            !WindowsAuthenticodePublisher.MatchesExpectedCommonName("Ledge Top Technologies LLC, Inc.") &&
            !WindowsAuthenticodePublisher.MatchesExpectedCommonName(null), "publisher common name must match the approved company exactly");
        using (var correctSubject = SubjectCertificate("CN=Ledge Top Technologies LLC,O=Example"))
            Require(WindowsAuthenticodePublisher.HasExactCommonName(correctSubject), "explicit exact CN accepted");
        using (var noCommonName = SubjectCertificate("O=Ledge Top Technologies LLC"))
            Require(!WindowsAuthenticodePublisher.HasExactCommonName(noCommonName), "organization fallback is not an explicit CN");
        using (var duplicate = SubjectCertificate("CN=Ledge Top Technologies LLC,CN=Other"))
            Require(!WindowsAuthenticodePublisher.HasExactCommonName(duplicate), "ambiguous duplicate CNs refused");
        foreach (var tag in new[] { UniversalTagNumber.UTF8String, UniversalTagNumber.PrintableString })
            Require(WindowsAuthenticodePublisher.HasExactCommonNameEncoded(EncodedCommonName(tag)), "explicit supported CN string type accepted");
        Require(!WindowsAuthenticodePublisher.HasExactCommonNameEncoded(EncodedCommonName(UniversalTagNumber.BMPString)), "unsupported CN string type refused");
        Require(!WindowsAuthenticodePublisher.HasExactCommonNameEncoded(new byte[] { 0x30, 0x03, 0x31, 0x01, 0x00 }), "malformed subject refused");
        const string profile = "1.3.6.1.4.1.311.97.123.456.789";
        const string code = "1.3.6.1.5.5.7.3.3", publicTrust = "1.3.6.1.4.1.311.97.1.0";
        using (var correct = Certificate(code, publicTrust, profile)) {
            Require(WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(correct, profile), "matching profile, public trust and code signing EKUs accepted");
            Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(correct, "1.3.6.1.4.1.311.97.123.456.790"), "different profile refused");
            foreach (var bad in new string?[] { null, "", "1.3.6.1.4.1.311.97.1.0", "1.3.6.1.4.1.311.97.123.0456.789", profile + "." })
                Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(correct, bad), "missing or noncanonical profile refused");
        }
        using (var noCode = Certificate(publicTrust, profile))
            Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(noCode, profile), "missing code-signing EKU refused");
        using (var noPublic = Certificate(code, profile))
            Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(noPublic, profile), "missing public-trust EKU refused");
        using (var noProfile = Certificate(code, publicTrust))
            Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(noProfile, profile), "missing profile EKU refused");
        using (var noEku = Certificate())
            Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(noEku, profile), "missing EKU extension refused");
        using (var malformed = MalformedEkuCertificate())
            Require(!WindowsAuthenticodePublisher.HasRequiredArtifactSigningEkus(malformed, profile), "malformed EKU extension refused");
        Require(!WindowsAuthenticodePublisher.ValidProfileEku(WindowsAuthenticodePublisher.ExpectedArtifactSigningProfileEku), "unconfigured profile keeps updates fail-closed");
        if (IntPtr.Size == 8) Require(WindowsAuthenticodePublisher.HasExpectedX64Abi(), "WinTrust x64 layouts match their native structures");
        if (OperatingSystem.IsWindows()) {
            try {
                WindowsAuthenticodePublisher.RequireTrustedCompanyInstaller(Environment.ProcessPath!);
                throw new Exception("An unsigned local test executable passed publisher verification.");
            } catch (IOException) {
                // Synthetic builds are intentionally unsigned; they must fail closed before install.
            }
        }
        foreach (var status in Enum.GetValues<WindowsAppReleaseStatus>()) {
            var log = new List<string>();
            var result = new WindowsAppReleaseCheck(status, "0.5.3.0", status == WindowsAppReleaseStatus.Available
                ? new("pilot", "0.5.4.0", 100, new string('a', 64), "\"artifact\"", new string('b', 40), "exe") : null);
            var read = await ExeUpdateMetadataCheck.ReadAsync(_ => { log.Add("metadata"); return Task.FromResult(result); },
                _ => { log.Add("owner"); return Task.CompletedTask; }, _ => { log.Add("authority"); return Task.CompletedTask; }, default);
            Require(ReferenceEquals(read, result) && string.Join(',', log) == "owner,metadata,owner,authority",
                "all metadata statuses are checked/rechecked without stage, drain, helper or installer capabilities");
        }
        foreach (var fault in new[] { "before", "metadata", "after", "authority" }) {
            var log = new List<string>(); var owners = 0;
            await Fails(async () => await ExeUpdateMetadataCheck.ReadAsync(_ => {
                log.Add("metadata"); if (fault == "metadata") throw new IOException();
                return Task.FromResult(new WindowsAppReleaseCheck(WindowsAppReleaseStatus.Current, "0.5.3.0"));
            }, _ => {
                var step = ++owners == 1 ? "before" : "after"; log.Add(step);
                if (fault == step) throw new IOException(); return Task.CompletedTask;
            }, _ => { log.Add("authority"); if (fault == "authority") throw new IOException(); return Task.CompletedTask; }, default));
            if (fault == "before") Require(!log.Contains("metadata"), "unknown installation makes no metadata request");
            if (fault == "after") Require(!log.Contains("authority"), "owner mutation cannot return an apparently successful check");
        }
        foreach (var cancelAt in new[] { "before", "metadata", "after", "authority" }) {
            using var cancel = new CancellationTokenSource(); var owners = 0; var returned = false;
            try {
                await ExeUpdateMetadataCheck.ReadAsync(_ => {
                    if (cancelAt == "metadata") cancel.Cancel();
                    return Task.FromResult(new WindowsAppReleaseCheck(WindowsAppReleaseStatus.NoRelease, "0.5.3.0"));
                }, _ => { var step = ++owners == 1 ? "before" : "after"; if (step == cancelAt) cancel.Cancel(); return Task.CompletedTask; },
                    _ => { if (cancelAt == "authority") cancel.Cancel(); return Task.CompletedTask; }, cancel.Token);
                returned = true;
            } catch (OperationCanceledException) { }
            Require(!returned, "metadata cancellation never returns stale result at " + cancelAt);
        }
    }

    private static X509Certificate2 Certificate(params string[] usages) {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Synthetic only", key, HashAlgorithmName.SHA256);
        if (usages.Length != 0) {
            var oids = new OidCollection(); foreach (var usage in usages) oids.Add(new Oid(usage));
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(oids, false));
        }
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
    }
    private static X509Certificate2 MalformedEkuCertificate() {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Synthetic only", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509Extension("2.5.29.37", [0x30, 0xff], false));
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
    }
    private static X509Certificate2 SubjectCertificate(string subject) {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256);
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
    }
    private static byte[] EncodedCommonName(UniversalTagNumber tag) {
        var writer = new AsnWriter(AsnEncodingRules.DER);
        writer.PushSequence(); writer.PushSetOf(); writer.PushSequence();
        writer.WriteObjectIdentifier("2.5.4.3"); writer.WriteCharacterString(tag, "Ledge Top Technologies LLC");
        writer.PopSequence(); writer.PopSetOf(); writer.PopSequence();
        return writer.Encode();
    }
    private static async Task Fails(Func<Task> work)
    { try { await work(); } catch (IOException) { return; } throw new Exception("Expected metadata verification refusal."); }
    private static void Require(bool value, string reason) { if (!value) throw new Exception(reason); }
    private sealed class Child : IExeUpdateInstallerProcess
    {
        internal bool TimedOut, WaitThrows, CodeThrows;
        internal uint Code;
        internal int Waits, Joins, CodeReads;
        internal Func<Task>? Join;
        public Task<bool> WaitAsync(TimeSpan timeout) { Waits++; if (WaitThrows) throw new IOException(); return Task.FromResult(!TimedOut); }
        public async Task WaitUntilConfirmedExitAsync() { Joins++; if (Join is not null) await Join(); }
        public uint ExitCode { get { CodeReads++; if (CodeThrows) throw new IOException(); return Code; } }
    }
}
