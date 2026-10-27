using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files;

// The parent factory supplies installed-update policy. This window creates no real adapter.
// Unexpected install exceptions cannot establish that an armed helper has stopped.
internal sealed record ExplorerUpdateActions(string CurrentVersion,
    Func<CancellationToken, Task<WindowsAppReleaseCheck>> CheckAsync,
    Func<CancellationToken, Task<ExeUpdateHandoffResult>> InstallAsync);
