namespace Maestro;

static class Program
{
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
