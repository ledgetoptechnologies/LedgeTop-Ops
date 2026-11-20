using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

internal static class TokenHelperGuidanceTests
{
    internal static async Task Run()
    {
        var fake = new SignInFixture();
        var model = new MainViewModel(fake, fake, "unused");

        fake.Failure = LoginFailureReason.HelperLaunchFailed;
        await model.StartAsync();
        Require(model.Screen == Screen.SignIn && model.SignInStatus.Contains("couldn't start", StringComparison.Ordinal));
        Require(fake.ExplicitAttempts == 0);

        fake.Failure = LoginFailureReason.HelperTimedOut;
        await model.SignIn.RunAsync();
        Require(model.SignInStatus.Contains("took too long", StringComparison.Ordinal) && fake.ExplicitAttempts == 1);

        fake.Failure = LoginFailureReason.HelperOutputInvalid;
        fake.FailAfterExplicitSignIn = true;
        await model.SignIn.RunAsync();
        Require(model.SignInStatus.Contains("unreadable response", StringComparison.Ordinal));

        fake.Failure = LoginFailureReason.HelperExitedUnsuccessfully;
        await model.SignIn.RunAsync();
        Require(model.SignInStatus.Contains("weren't signed in", StringComparison.Ordinal));

        fake.CancelExplicitSignIn = true;
        await model.SignIn.RunAsync();
        Require(model.SignInStatus == "Sign-in was cancelled." && model.SignIn.CanExecute(null));
    }

    private static void Require(bool condition)
    {
        if (!condition) throw new InvalidOperationException("Token helper guidance assertion failed.");
    }

    private sealed class SignInFixture : IFilesBackend, IShell, ISessionGateway, IConnectionSessionGateway
    {
        public LoginFailureReason Failure { get; set; }
        public bool FailAfterExplicitSignIn { get; set; }
        public bool CancelExplicitSignIn { get; set; }
        public int ExplicitAttempts { get; private set; }
        public ISessionGateway Session => this;
        public IFileCatalog Catalog => throw new NotSupportedException();
        public IReadOnlyList<IQueuedDownloadSource> Sources => [];
        public string StateDirectory => throw new NotSupportedException();

        public Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken) => Task.FromResult<SessionInfo?>(null);

        public Task<SessionInfo?> CheckCurrentForConnectionAsync(CancellationToken cancellationToken) =>
            Task.FromException<SessionInfo?>(new LoginRequiredException(Failure, LoginFailureOperation.CachedToken));

        public Task SignInAsync(CancellationToken cancellationToken)
        {
            ExplicitAttempts++;
            if (CancelExplicitSignIn) throw new OperationCanceledException();
            if (FailAfterExplicitSignIn) return Task.CompletedTask;
            throw new LoginRequiredException(Failure, LoginFailureOperation.ExplicitLogin);
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        public void OnUi(Action action) => action();
        public string? PickFolder(string current) => throw new NotSupportedException();
        public void OpenFile(string path) => throw new NotSupportedException();
        public void ShowInFolder(string path) => throw new NotSupportedException();
    }
}
