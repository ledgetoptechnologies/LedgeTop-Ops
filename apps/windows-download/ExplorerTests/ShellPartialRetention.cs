using LedgeTop.Files.Explorer;

// Test-harness state only: an uncertain broker result permanently prevents automatic removal,
// even when recording the partial result fails or a later provider disconnect succeeds.
internal sealed class ShellPartialRetention
{
    internal bool Partial { get; private set; }
    internal ShellRegistration? Registration { get; private set; }
    internal bool Capture(Exception error, Action<ShellRegistration> writeEvidence, Action<Exception> reportEvidenceFailure)
    {
        if (error is not ShellRegistrationException { OwnedPartial: { } partial }) return false;
        Partial = true;
        Registration = partial;
        try { writeEvidence(partial); } catch (Exception evidenceError) { reportEvidenceFailure(evidenceError); }
        return true;
    }
    internal bool CanUnregister(bool disconnected, bool observerConfirmed) => !Partial && disconnected && observerConfirmed;
}
