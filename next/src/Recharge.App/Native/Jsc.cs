using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>JavaScriptCore symbols used by the shell.</summary>
    internal static class Jsc
    {
        internal const string Lib = "libjavascriptcoregtk-4.1.so.0";

        [DllImport(Lib)]
        internal static extern IntPtr jsc_value_to_string(IntPtr value);
    }
}
