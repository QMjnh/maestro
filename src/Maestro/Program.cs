namespace Maestro;

static class Program
{
    /// <summary>A text file embedded in the exe (see Maestro.csproj).</summary>
    public static string Resource(string name)
    {
        using var s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(name)!;
        return new StreamReader(s).ReadToEnd();
    }

    [STAThread]
    static void Main()
    {
        // One Maestro at a time: a second launch just brings the first window forward.
        using var mutex = new Mutex(true, "Maestro.SingleInstance", out bool isFirst);
        if (!isFirst)
        {
            NativeMethods.PostMessage(NativeMethods.HWND_BROADCAST, NativeMethods.WM_SHOWMAESTRO, 0, 0);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
