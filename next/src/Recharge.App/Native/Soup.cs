using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>libsoup 3 symbols used for response headers.</summary>
    internal static class Soup
    {
        internal const string Lib = "libsoup-3.0.so.0";
        internal const int HeadersResponse = 1;

        [DllImport(Lib)]
        internal static extern IntPtr soup_message_headers_new(int type);

        [DllImport(Lib)]
        internal static extern void soup_message_headers_append(
            IntPtr headers,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string name,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string value);

        [DllImport(Lib)]
        internal static extern IntPtr soup_message_headers_get_one(
            IntPtr headers,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    }
}
