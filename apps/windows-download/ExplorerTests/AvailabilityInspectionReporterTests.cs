using LedgeTop.Files.Explorer;

internal static class AvailabilityInspectionReporterTests
{
    internal static int Run()
    {
        var reporter = new AvailabilityInspectionReporter(); var notices = new List<string>();
        void Fail(string path) => reporter.Inspect(path, () => throw new IOException("private filename"), notices.Add, default);
        void Pass(string path) => reporter.Inspect(path, () => { }, notices.Add, default);
        Fail("first"); Fail("FIRST"); Fail("second");
        Need(notices.Count == 1 && notices[0].Contains("try again automatically") && notices[0].Contains("availability/Inspect/LocalIO") && !notices[0].Contains("private"), "one sanitized notice per episode");
        Pass("first"); Fail("first"); Need(notices.Count == 1, "other failure keeps episode active");
        Pass("first"); Pass("second"); Fail("first"); Need(notices.Count == 2, "new failure after recovery is reported");
        using var stop = new CancellationTokenSource(); stop.Cancel();
        reporter.Inspect("cancelled", () => throw new OperationCanceledException(stop.Token), notices.Add, stop.Token);
        Need(notices.Count == 2, "shutdown is not reported as an error");
        try { reporter.Inspect("unexpected", () => throw new InvalidOperationException(), notices.Add, default); throw new Exception("unexpected exception swallowed"); }
        catch (InvalidOperationException) { }
        Console.WriteLine("PASS bounded scanner inspection guidance and retry episode behavior."); return 0;
    }
    private static void Need(bool condition, string message) { if (!condition) throw new Exception(message); }
}
