using System.Runtime.Versioning;

namespace LedgeTop.Files;

/// <summary>Only the installed pilot's per-user fixed Run value. Source preference is a UX coordinate;
/// startup admission must separately verify installation and reconnect the owned cached source.</summary>
internal sealed class WindowsStartupAdapter(IWindowsStartupOwnershipReader ownership, IWindowsStartupRunStore store)
{
    private readonly SemaphoreSlim operations = new(1, 1);

    [SupportedOSPlatform("windows")]
    internal WindowsStartupAdapter() : this(new WindowsStartupOwnershipReader(), new WindowsStartupRegistryStore()) { }

    // Does not read/mutate Run or authenticate. App must call before admitting the reserved startup route.
    internal async Task<bool> ValidateRunningInstallationAsync(CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            await using var proof = await ownership.ReadAsync(token).ConfigureAwait(false);
            _ = WindowsStartupPolicy.Command(proof.ExecutablePath, "portal");
            await proof.VerifyStillCurrentAsync(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
            return true;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { return false; }
        finally { operations.Release(); }
    }

    internal async Task<WindowsStartupState> GetStateAsync(CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            await using var proof = await ownership.ReadAsync(token).ConfigureAwait(false);
            _ = WindowsStartupPolicy.Command(proof.ExecutablePath, "portal");
            var state = WindowsStartupPolicy.State(proof.ExecutablePath, store.Read());
            await proof.VerifyStillCurrentAsync(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
            return state;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (WindowsStartupOwnershipUnavailableException) { return new(WindowsStartupAvailability.Unavailable); }
        catch { return new(WindowsStartupAvailability.Error); }
        finally { operations.Release(); }
    }

    // Called only after App has selected the source. This coordinate grants no account access.
    // Existing explicit preference and existing Run values are preserved; absence defaults on.
    internal async Task<WindowsStartupState> ApplyDefaultAsync(string verifiedSourceAlias, CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            await using var proof = await ownership.ReadAsync(token).ConfigureAwait(false);
            var command = WindowsStartupPolicy.Command(proof.ExecutablePath, verifiedSourceAlias);
            var preference = store.ReadPreference();
            var previous = store.Read(); var state = WindowsStartupPolicy.State(proof.ExecutablePath, previous);
            await proof.VerifyStillCurrentAsync(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
            if (preference == WindowsStartupPreference.Invalid) return new(WindowsStartupAvailability.Conflict);
            if (state.Availability != WindowsStartupAvailability.Available || preference != WindowsStartupPreference.Unset || previous is not null) return state;
            var desired = new WindowsStartupRunValue(WindowsStartupValueKind.String, command);
            if (!store.TryReplace(null, desired, requireUnsetPreference: true)) return new(WindowsStartupAvailability.Conflict);
            await proof.VerifyStillCurrentAsync(CancellationToken.None).ConfigureAwait(false);
            var observed = store.Read();
            if (observed != desired) return new(WindowsStartupAvailability.Conflict);
            store.SavePreference(true);
            return WindowsStartupPolicy.State(proof.ExecutablePath, observed);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (WindowsStartupOwnershipUnavailableException) { return new(WindowsStartupAvailability.Unavailable); }
        catch { return new(WindowsStartupAvailability.Error); }
        finally { operations.Release(); }
    }

    internal async Task<WindowsStartupState> SetEnabledAsync(bool enabled, string verifiedSourceAlias, CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            await using var proof = await ownership.ReadAsync(token).ConfigureAwait(false);
            // Source comes from App selection; recognized spelling is a coordinate, never account proof.
            var command = WindowsStartupPolicy.Command(proof.ExecutablePath, verifiedSourceAlias);
            if (store.ReadPreference() == WindowsStartupPreference.Invalid) return new(WindowsStartupAvailability.Conflict);
            var previous = store.Read(); var state = WindowsStartupPolicy.State(proof.ExecutablePath, previous);
            if (state.Availability != WindowsStartupAvailability.Available) return state;
            await proof.VerifyStillCurrentAsync(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
            WindowsStartupRunValue? desired = enabled ? new(WindowsStartupValueKind.String, command) : null;
            if (previous != desired && !store.TryReplace(previous, desired)) return new(WindowsStartupAvailability.Conflict);
            // Mutation is committed. Cancellation is not rollback: observe its real result and retain
            // an explicit error if ownership/readback cannot be confirmed, never delete foreign data.
            await proof.VerifyStillCurrentAsync(CancellationToken.None).ConfigureAwait(false);
            var observed = store.Read();
            if (observed != desired) return new(WindowsStartupAvailability.Conflict);
            // Record explicit user intent only after exact owned Run state is confirmed. Absence
            // alone historically meant either never configured or disabled, so upgrades use this marker.
            store.SavePreference(enabled);
            return WindowsStartupPolicy.State(proof.ExecutablePath, observed);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (WindowsStartupOwnershipUnavailableException) { return new(WindowsStartupAvailability.Unavailable); }
        catch { return new(WindowsStartupAvailability.Error); }
        finally { operations.Release(); }
    }
}
