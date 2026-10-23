using System.Globalization;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Presentation;

/// <summary>Everything the app says, in one place, in plain words.</summary>
public static class Text
{
    /// <summary>The file's own extension (KML, ZIP, TIF…), matching the Operations file badges.</summary>
    public static string FileType(string name)
    {
        var dot = name.LastIndexOf('.');
        var extension = dot > 0 ? name[(dot + 1)..] : "";
        return extension.Length is >= 1 and <= 8 && extension.All(char.IsAsciiLetterOrDigit) ? extension.ToUpperInvariant() : "File";
    }

    public static string Size(long bytes)
    {
        if (bytes < 0) return "—";
        string[] units = ["bytes", "KB", "MB", "GB", "TB"];
        double value = bytes; var unit = 0;
        while (value >= 1024 && unit < units.Length - 1) { value /= 1024; unit++; }
        return unit == 0 ? $"{bytes} bytes" : value.ToString(value >= 100 ? "0" : "0.0", CultureInfo.CurrentCulture) + " " + units[unit];
    }

    public static string SignedInUntil(DateTimeOffset expiresAt) =>
        "Signed in until " + expiresAt.ToLocalTime().ToString("t", CultureInfo.CurrentCulture);

    public const string SessionExpired = "Your sign-in expired. Downloads are paused — sign in to continue.";
    public static string SessionExpiring(TimeSpan left) =>
        $"Your sign-in ends in {Math.Max(1, (int)Math.Ceiling(left.TotalMinutes))} min. Downloads pause then until you sign in again.";

    public const string ChecksumUnavailable = "Can't verify yet";
    public const string ChecksumUnavailableDetail = "This file is waiting for its integrity check on the server, so it can't be downloaded safely yet.";

    /// <summary>Short status for a transfer row.</summary>
    public static string State(QueuedTransfer job) => job.State switch {
        QueuedTransferState.Queued => "Waiting",
        QueuedTransferState.Running => "Downloading",
        QueuedTransferState.Paused when job.RecoveryRequired => "Needs checking",
        QueuedTransferState.Paused => "Paused",
        QueuedTransferState.Cancelled => "Cancelled",
        QueuedTransferState.Completed => "Downloaded",
        QueuedTransferState.VersionChanged => "Changed on the server",
        QueuedTransferState.LoginRequired => "Sign in to continue",
        QueuedTransferState.AccessDenied => "No longer available to you",
        QueuedTransferState.ResourceUnavailable => "No longer available",
        _ => "Couldn't download",
    };

    /// <summary>One sentence explaining a stopped transfer and what to do next; empty when nothing needs saying.</summary>
    public static string Detail(QueuedTransfer job) => (job.State, job.ErrorCode) switch {
        (QueuedTransferState.Paused, _) when job.RecoveryRequired =>
            "The app closed while this was downloading. Resume to check the file and finish it.",
        (QueuedTransferState.VersionChanged, _) =>
            "This file was updated after you added it. Select it again to download the current version.",
        (QueuedTransferState.LoginRequired, _) => "Sign in again to continue this download.",
        (QueuedTransferState.AccessDenied, "resource-identity-changed") => "This file was replaced. Select it again from its folder.",
        (QueuedTransferState.AccessDenied, _) => "You no longer have access to this file.",
        (QueuedTransferState.ResourceUnavailable, _) =>
            "This file isn't available anymore. If its delivery was updated, select it again.",
        (QueuedTransferState.Failed, "existing-content-mismatch") =>
            "A different file with this name is already in the folder. It was left untouched — move it or choose another folder.",
        (QueuedTransferState.Failed, _) => "The download didn't finish. Check your connection and retry.",
        _ => "",
    };

    public static string Progress(DownloadProgress progress, double bytesPerSecond)
    {
        if (progress.Phase == DownloadPhase.Verifying) return "Checking the file…";
        var done = $"{Size(progress.BytesTransferred)} of {Size(progress.TotalBytes)}";
        if (bytesPerSecond <= 0 || progress.TotalBytes <= progress.BytesTransferred) return done;
        var left = TimeSpan.FromSeconds((progress.TotalBytes - progress.BytesTransferred) / bytesPerSecond);
        return done + " · " + (left.TotalMinutes >= 1 ? $"{(int)Math.Ceiling(left.TotalMinutes)} min left" : "less than a minute left");
    }

    /// <summary>Why a chosen download folder can't be used, or null when it can.</summary>
    public static string? DestinationProblem(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) return "Choose a folder on this PC.";
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return "Choose a folder on this PC — network folders can't be used.";
        var lower = path.ToLowerInvariant();
        if (lower.Contains(@"\onedrive") || lower.Contains(@"\dropbox") || lower.Contains(@"\google drive") || lower.Contains(@"\icloud"))
            return "Choose a folder that isn't managed by OneDrive, Dropbox or another sync app.";
        try {
            for (var current = new DirectoryInfo(Path.GetFullPath(path)); current is not null; current = current.Parent)
                if (current.Exists && current.Attributes.HasFlag(FileAttributes.ReparsePoint)) return "Choose a normal folder, not a shortcut or linked folder.";
        } catch (Exception) { return "That folder can't be used. Choose another one."; }
        return null;
    }
}
