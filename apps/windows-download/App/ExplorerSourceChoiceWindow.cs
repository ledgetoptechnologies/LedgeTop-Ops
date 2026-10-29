using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using LedgeTop.Files.Backends;

namespace LedgeTop.Files;

/// <summary>One source is selected before any backend or authentication flow is constructed.</summary>
internal sealed class ExplorerSourceChoiceWindow : Window
{
    private readonly TaskCompletionSource<AccessMode?> selected = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal Task<AccessMode?> Selection => selected.Task;
    internal IReadOnlyDictionary<AccessMode, Button> Choices { get; }

    internal ExplorerSourceChoiceWindow(IReadOnlyList<AccessMode> modes, string label)
    {
        if (modes.Count == 0 || modes.Distinct().Count() != modes.Count) throw new ArgumentException("Choose a configured file source.");
        foreach (var mode in modes) AccessModes.Validate(mode);
        Title = "LedgeTop Files — choose your files"; Width = 660; Height = 480; MinWidth = 560; MinHeight = 420;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = (Brush)FindResource("Page"); Foreground = (Brush)FindResource("Ink");
        FontFamily = (FontFamily)FindResource("UiFont");
        var panel = new StackPanel { Margin = new Thickness(28) };
        panel.Children.Add(new TextBlock { Text = "LedgeTop Files · " + label, FontSize = 23, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(new TextBlock { Text = "Which files do you want in Explorer?", FontSize = 17, Margin = new Thickness(0, 18, 0, 8) });
        panel.Children.Add(new TextBlock { Text = "Choose one source. You will sign in from Settings when you are ready.", TextWrapping = TextWrapping.Wrap,
            FontSize = 13, Foreground = (Brush)FindResource("Muted"), Margin = new Thickness(0, 0, 0, 20) });
        var buttons = new Dictionary<AccessMode, Button>();
        foreach (var mode in modes) {
            var text = new StackPanel();
            text.Children.Add(new TextBlock { Text = FilesSession.Label(mode), FontSize = 17, FontWeight = FontWeights.SemiBold });
            text.Children.Add(new TextBlock { Text = FilesSession.SignInDetail(mode), TextWrapping = TextWrapping.Wrap, FontSize = 13,
                Margin = new Thickness(0, 6, 0, 0) });
            var button = new Button { Content = text, HorizontalContentAlignment = HorizontalAlignment.Left,
                Padding = new Thickness(16), Margin = new Thickness(0, 0, 0, 12) };
            button.Click += (_, _) => { selected.TrySetResult(mode); Close(); };
            panel.Children.Add(button); buttons.Add(mode, button);
        }
        Choices = new System.Collections.ObjectModel.ReadOnlyDictionary<AccessMode, Button>(buttons);
        Content = new ScrollViewer { Background = Background, Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Closed += (_, _) => selected.TrySetResult(null);
    }
}
