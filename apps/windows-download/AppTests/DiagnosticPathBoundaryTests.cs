internal static class DiagnosticPathBoundaryTests
{
    internal static void Run(string parent, char fill, string leaf, string temporary, Action<string, Func<bool>> save)
    {
        const string name = "connected-explorer-pilot-employee";
        var padding = 208 - parent.Length - 2 - name.Length;
        if (padding is < 1 or > 200) throw new IOException("Short generated artifact root required.");
        var directory = Path.Combine(parent, new string(fill, padding), name);
        Directory.CreateDirectory(directory);
        if (Path.Combine(directory, leaf).Length > 240 || Path.Combine(directory, temporary).Length <= 240)
            throw new IOException("Boundary fixture does not exercise the temporary path limit.");
        var checks = 0; save(directory, () => ++checks == 1);
        if (Directory.GetFiles(directory).Length != 0) throw new Exception("Long temporary path created a file.");
        var original = Path.Combine(directory, leaf); File.WriteAllText(original, "foreign-data");
        save(directory, () => true);
        if (File.ReadAllText(original) != "foreign-data" || Directory.GetFiles(directory).Length != 1)
            throw new Exception("Long temporary path modified an existing record.");
    }
}
