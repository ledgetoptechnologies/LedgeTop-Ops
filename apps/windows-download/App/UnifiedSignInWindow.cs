using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using LedgeTop.Files.Backends;

namespace LedgeTop.Files;

// Source/test-only first-window candidate. Startup does not construct this window until
// native authentication + exact discovery response + source admission contracts are agreed.
internal sealed class UnifiedSignInWindow : Window
{
    private readonly UnifiedSignInCoordinator coordinator;
    private readonly TaskCompletionSource<UnifiedSignInSelection?> selection = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 16, 0, 20) };
    private CancellationTokenSource? cancellation;
    private Task operation = Task.CompletedTask;
    private bool closing, readyToClose;
    internal readonly Button SignInButton = new() { Content = "Sign in", MinWidth = 110 };
    internal readonly Button CancelButton = new() { Content = "Cancel", MinWidth = 90, Margin = new Thickness(12, 0, 0, 0) };
    internal Task<UnifiedSignInSelection?> Selection => selection.Task;
    internal string StatusText => status.Text;

    internal UnifiedSignInWindow(UnifiedSignInCoordinator coordinator, string label)
    {
        this.coordinator = coordinator;
        Title = "LedgeTop Files — sign in"; Width = 580; Height = 340; MinWidth = 500; MinHeight = 300;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = (Brush)FindResource("Page"); Foreground = (Brush)FindResource("Ink"); FontFamily = (FontFamily)FindResource("UiFont");
        var panel = new StackPanel { Margin = new Thickness(28) };
        panel.Children.Add(new TextBlock { Text = "LedgeTop Files · " + label, FontSize = 23, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(new TextBlock { Text = "Sign in to connect your files", FontSize = 17, Margin = new Thickness(0, 18, 0, 0) });
        status.Text = "We will check which files your signed-in account can access.";
        panel.Children.Add(status);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        buttons.Children.Add(SignInButton); buttons.Children.Add(CancelButton); panel.Children.Add(buttons);
        Content = panel;
        SignInButton.Click += (_, _) => { if (operation.IsCompleted && !closing) operation = SignInAsync(); };
        CancelButton.Click += (_, _) => Close();
        Closed += (_, _) => selection.TrySetResult(null);
    }

    private async Task SignInAsync()
    {
        // Yield so the caller publishes operation before synchronous failures or close events.
        await System.Windows.Threading.Dispatcher.Yield();
        if (closing) return;
        using var attempt = new CancellationTokenSource(); cancellation = attempt;
        SignInButton.IsEnabled = false; status.Text = "Signing in and checking your account…";
        try {
            var result = await coordinator.SignInAsync(attempt.Token);
            if (closing) { if (result.Selection is { } late) await late.DisposeAsync(); return; }
            if (result.Selection is { } accepted) {
                selection.TrySetResult(accepted); readyToClose = true; Close(); return;
            }
            status.Text = result.Decision.Status switch {
                UnifiedSignInStatus.NoAccess or UnifiedSignInStatus.Denied => "This account does not have access to files. Ask your LedgeTop contact to check your access.",
                UnifiedSignInStatus.LoginRequired => "Sign-in was not confirmed. Choose Sign in to try again.",
                UnifiedSignInStatus.Ambiguous => "This account's file connection needs a setup decision. Ask your LedgeTop contact to check it.",
                UnifiedSignInStatus.Disabled or UnifiedSignInStatus.Unavailable => "Account access could not be checked. Try again later.",
                _ => "The account check could not be confirmed. Sign in again."
            };
        } catch (OperationCanceledException) when (attempt.IsCancellationRequested) { status.Text = "Sign-in cancelled."; }
        catch { status.Text = "Sign-in could not finish. Try again later."; }
        finally { cancellation = null; if (!closing) SignInButton.IsEnabled = true; }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        if (e.Cancel || readyToClose) return;
        if (closing) { e.Cancel = !operation.IsCompleted; return; }
        coordinator.Invalidate(); closing = true; cancellation?.Cancel(); SignInButton.IsEnabled = false;
        if (operation.IsCompleted) return;
        e.Cancel = true; status.Text = "Waiting for sign-in to stop safely…";
        _ = FinishCloseAsync();
    }
    private async Task FinishCloseAsync()
    {
        await System.Windows.Threading.Dispatcher.Yield();
        try { await operation; } catch { /* SignInAsync already sanitizes failures. */ }
        readyToClose = true; Close();
    }
}
