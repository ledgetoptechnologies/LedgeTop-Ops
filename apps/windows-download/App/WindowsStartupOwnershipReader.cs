using System.Runtime.Versioning;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

[SupportedOSPlatform("windows")]
internal sealed class WindowsStartupOwnershipReader : IWindowsStartupOwnershipReader
{
    public async Task<IWindowsStartupOwnership> ReadAsync(CancellationToken token)
    {
        try {
            var profile = ExeUpdateWindowsTrust.Profile();
            var observed = await ExeUpdateWindowsTrust.ReadCurrentAsync(profile, token).ConfigureAwait(false);
            return new Proof(observed.Owner, observed.Payload);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { throw new WindowsStartupOwnershipUnavailableException(); }
    }
    private sealed class Proof(ExeUpdateInstalledOwner owner, VerifiedInstalledPayload payload) : IWindowsStartupOwnership
    {
        public string ExecutablePath => Path.Combine(owner.InstallRoot, "LedgeTop.Files.exe");
        public async Task VerifyStillCurrentAsync(CancellationToken token)
        {
            try {
                ExeUpdateWindowsTrust.CheckOwner(owner);
                await payload.RevalidateAsync(token).ConfigureAwait(false);
                ExeUpdateWindowsTrust.CheckOwner(owner);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch { throw new WindowsStartupOwnershipUnavailableException(); }
        }
        public ValueTask DisposeAsync() => payload.DisposeAsync();
    }
}
