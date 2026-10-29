using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files;

// One controller per settings window; the App retains it until process exit. Window actions are
// serialized on its dispatcher. Unknown helper ownership must never be replaced by a fresh attempt.
internal sealed class ExplorerInstalledUpdateController(
    Func<CancellationToken, Task<ConnectedExplorerUpdateBinding>> readBinding,
    Func<ConnectedExplorerUpdateBinding, CancellationToken, Task<WindowsAppReleaseCheck>> check,
    Func<ConnectedExplorerUpdateBinding, ExeUpdateHandoffCoordinator> createCoordinator)
{
    private ExeUpdateHandoffCoordinator? coordinator;

    internal ExplorerUpdateActions Actions(string currentVersion) => new(currentVersion, CheckAsync, InstallAsync);

    private async Task<WindowsAppReleaseCheck> CheckAsync(CancellationToken token)
    {
        var binding = await readBinding(token);
        return await Task.Run(() => check(binding, token), token);
    }

    private async Task<ExeUpdateHandoffResult> InstallAsync(CancellationToken token)
    {
        if (coordinator?.HoldsRecoveryFences != true) {
            ConnectedExplorerUpdateBinding binding;
            // This block has no coordinator/helper capability. Known cancellation/refusal must
            // not be confused with an install-capable child whose shutdown is unconfirmed.
            try { binding = await readBinding(token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) {
                return new(ExeUpdateHandoffStatus.Postponed, false);
            }
            catch { return new(ExeUpdateHandoffStatus.PreparationFailed, false); }
            coordinator = createCoordinator(binding);
        }
        var owned = coordinator;
        // Do not cancel Task.Run scheduling: let the owned flow observe cancellation and join cleanup.
        try { return await Task.Run(() => owned.ApplyAsync(token)); }
        catch (OperationCanceledException) when (token.IsCancellationRequested && !owned.HoldsRecoveryFences) {
            return new(ExeUpdateHandoffStatus.Postponed, false);
        }
    }
}
