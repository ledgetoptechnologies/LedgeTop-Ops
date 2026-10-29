namespace LedgeTop.Files;

internal sealed record ExplorerStartupActions(
    Func<CancellationToken, Task<WindowsStartupState>> ReadAsync,
    Func<bool, CancellationToken, Task<WindowsStartupState>> SetAsync);
