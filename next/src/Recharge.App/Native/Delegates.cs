using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate void GtkDestroyCallback(IntPtr widget, IntPtr userData);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate void WebKitUriSchemeRequestCallback(IntPtr request, IntPtr userData);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate void WebKitScriptMessageCallback(
        IntPtr manager,
        IntPtr jsValue,
        IntPtr userData);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GSourceFunc(IntPtr userData);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate void GAsyncReadyCallback(IntPtr sourceObject, IntPtr result, IntPtr userData);
}
