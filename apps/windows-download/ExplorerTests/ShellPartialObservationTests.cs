using System.Reflection;
using System.Text;
using LedgeTop.Files.Explorer;

internal static class ShellPartialObservationTests
{
    internal static int Run()
    {
        static ShellRegistration Receipt(long existingId = 0) => (ShellRegistration)typeof(ShellRegistration)
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single()
            .Invoke([@"C:\synthetic-root", "synthetic-id", "synthetic-icon", Encoding.UTF8.GetBytes("synthetic-context"),
                Guid.Empty, existingId, ShellRegistration.DisplayName]);
        static void Require(bool value) { if (!value) throw new IOException("Partial native observation assertion failed."); }
        static void Refuse(Action action) { try { action(); } catch (IOException) { return; } throw new IOException("Expected refusal."); }
        var match = new NativeRootObservation(0, 42, true, true, true, 2, 0, 3, 0, 1023, 0);
        var observed = Receipt();
        Refuse(() => observed.VerifyObservedIdentity(match, true, () => throw new IOException("shell unavailable")));
        Require(observed.RootFileId == 42 && observed.NamespaceClsid == Guid.Empty);
        var invalid = Receipt(); var metadataRead = false;
        Refuse(() => invalid.VerifyObservedIdentity(match with { ExpectedContextMatches = false }, true,
            () => { metadataRead = true; return Guid.NewGuid(); }));
        Require(invalid.RootFileId == 0 && !metadataRead);
        var changed = Receipt(7); metadataRead = false;
        Refuse(() => changed.VerifyObservedIdentity(match, true, () => { metadataRead = true; return Guid.NewGuid(); }));
        Require(changed.RootFileId == 7 && !metadataRead);
        var absent = Receipt(); metadataRead = false;
        Refuse(() => absent.VerifyObservedIdentity(match with { Hresult = unchecked((int)0x80070186) }, true,
            () => { metadataRead = true; return Guid.NewGuid(); }));
        Require(absent.RootFileId == 0 && !metadataRead);
        var complete = Receipt(); var expectedNamespace = Guid.NewGuid();
        complete.VerifyObservedIdentity(match, true, () => expectedNamespace);
        Require(complete.RootFileId == 42 && complete.NamespaceClsid == expectedNamespace);
        Console.WriteLine("PASS partial shell observation retains only a verified native ID; no native operations.");
        return 0;
    }
}
