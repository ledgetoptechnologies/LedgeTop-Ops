using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;

namespace LedgeTop.Files.Presentation;

public abstract class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Raise(name);
        return true;
    }

    protected void Raise([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>A command that runs an async action once at a time and reports failures instead of crashing.</summary>
public sealed class Command(Func<Task> run, Func<bool>? canRun = null, Action<Exception>? failed = null) : ICommand
{
    private bool running;

    public Command(Action run, Func<bool>? canRun = null) : this(() => { run(); return Task.CompletedTask; }, canRun) { }

    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => !running && (canRun?.Invoke() ?? true);
    public void Refresh() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);

    public async void Execute(object? parameter)
    {
        if (!CanExecute(parameter)) return;
        running = true; Refresh();
        try { await run(); }
        catch (Exception error) { failed?.Invoke(error); }
        finally { running = false; Refresh(); }
    }
}
