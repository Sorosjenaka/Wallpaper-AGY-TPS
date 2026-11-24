using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class StartKit
{
    private static void Main()
    {
        try
        {
            var directory = AppDomain.CurrentDomain.BaseDirectory;
            var node = File.ReadAllText(Path.Combine(directory, "node-path.txt")).Trim();
            var script = Path.Combine(directory, "launcher", "launch.mjs");
            var info = new ProcessStartInfo(node, "\"" + script + "\"") {
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" + Environment.GetEnvironmentVariable("PATH");
            Process.Start(info);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Antigravity Kit", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
