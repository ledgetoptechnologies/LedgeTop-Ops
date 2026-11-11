namespace LedgeTop.Files.Explorer;

/// <summary>An owned Windows preview root. The provider must disconnect and drain before unregistering it.</summary>
public interface IPreviewRootRegistration
{
    string Root { get; }
    void VerifyOwned();
    void Unregister();
}
