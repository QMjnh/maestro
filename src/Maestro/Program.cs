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
    static int Main(string[] args)
    {
        // For AI agents (Agent.cs): these talk to the running Maestro, opening it if needed, and never show a window.
        if (args is ["mcp", ..]) return Agent.ServeMcp().GetAwaiter().GetResult();
        if (args is ["agent", .. var rest]) return Agent.RunCommand(rest).GetAwaiter().GetResult();

        // One Maestro at a time: a second launch just brings the first window forward.
        using var mutex = new Mutex(true, "Maestro.SingleInstance", out bool isFirst);
        if (!isFirst)
        {
            NativeMethods.PostMessage(NativeMethods.HWND_BROADCAST, NativeMethods.WM_SHOWMAESTRO, 0, 0);
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }
}
