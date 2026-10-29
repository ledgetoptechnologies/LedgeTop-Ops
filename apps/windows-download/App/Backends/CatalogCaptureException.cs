using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

public enum CatalogCaptureOperation { SessionPin, InitialSession, Sections, Roots, FolderListing, FileReference, FileResolution, FinalSession }
public enum CatalogCaptureBoundary { BeforeSession, MetadataRequest, AfterSession, ValidateInventory }

/// <summary>Redacted capture coordinates only. Never retains the originating error, its message or a resource selector.</summary>
public sealed class CatalogCaptureException : Exception
{
    public CatalogCaptureOperation Operation { get; }
    public CatalogCaptureBoundary Boundary { get; }
    public TransferFailureReason Reason { get; }
    public int? HttpStatus { get; }
    internal CatalogCaptureException(CatalogCaptureOperation operation, CatalogCaptureBoundary boundary,
        TransferFailureReason reason, int? httpStatus) : base("The current file list could not be verified.")
    {
        if (!Enum.IsDefined(operation) || !Enum.IsDefined(boundary)) throw new ArgumentException("A bounded capture coordinate is required.");
        // Reuse the validated Core reason/status pair without retaining the original exception.
        var validated = new TransferException("Capture failure.", reason, httpStatus);
        Operation = operation; Boundary = boundary; Reason = validated.Reason; HttpStatus = validated.HttpStatus;
    }
    public string SupportCode => $"catalog/{Operation}/{Boundary}/{Reason}";
}
