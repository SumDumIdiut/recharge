using System;
using System.Globalization;

namespace Recharge.App
{
    /// <summary>Parsed command-line options.</summary>
    public sealed class AppOptions
    {
        public string? SnapshotPath { get; private set; }
        public string Route { get; private set; } = string.Empty;
        public string? MapFolder { get; private set; }
        public bool Modded { get; private set; }
        public int Width { get; private set; } = 1280;
        public int Height { get; private set; } = 800;
        public int TimeoutSeconds { get; private set; } = 20;
        public bool EvalLog { get; private set; }
        public bool Help { get; private set; }

        public bool IsSnapshot => !string.IsNullOrEmpty(SnapshotPath);
        public bool IsAutoPlay => MapFolder != null;

        public static AppOptions Parse(string[] args)
        {
            var options = new AppOptions();
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                switch (arg)
                {
                    case "--snapshot":
                        options.SnapshotPath = NextValue(args, ref i, arg);
                        if (options.SnapshotPath.Length == 0)
                        {
                            throw new ArgumentException("--snapshot needs a file path");
                        }
                        break;
                    case "--route":
                        options.Route = NextValue(args, ref i, arg);
                        break;
                    case "--map":
                        options.MapFolder = NextValue(args, ref i, arg);
                        break;
                    case "--modded":
                        options.Modded = true;
                        break;
                    case "--size":
                        string size = NextValue(args, ref i, arg);
                        string[] parts = size.Split(new[] { 'x', 'X' }, StringSplitOptions.None);
                        if (parts.Length != 2 ||
                            !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out int width) ||
                            !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out int height) ||
                            width <= 0 || height <= 0)
                        {
                            throw new ArgumentException("--size must look like 1280x800");
                        }
                        options.Width = width;
                        options.Height = height;
                        break;
                    case "--timeout":
                        string timeout = NextValue(args, ref i, arg);
                        if (!int.TryParse(timeout, NumberStyles.None, CultureInfo.InvariantCulture, out int seconds) ||
                            seconds <= 0)
                        {
                            throw new ArgumentException("--timeout must be a positive number of seconds");
                        }
                        options.TimeoutSeconds = seconds;
                        break;
                    case "--eval-log":
                        options.EvalLog = true;
                        break;
                    case "--help":
                    case "-h":
                        options.Help = true;
                        break;
                    default:
                        throw new ArgumentException("unknown argument: " + arg);
                }
            }
            return options;
        }

        public static string Usage =>
            "usage: recharge [--snapshot <out.png> [--route <route>] [--map <folder>] [--modded] " +
            "[--size 1280x800] [--timeout 20] [--eval-log]]";

        private static string NextValue(string[] args, ref int index, string option)
        {
            if (index + 1 >= args.Length)
            {
                throw new ArgumentException(option + " needs a value");
            }
            index++;
            return args[index];
        }
    }
}
