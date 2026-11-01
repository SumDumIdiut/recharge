using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Windows
{
    /// <summary>The few user32/kernel32/shell32 calls the plain Win32 window needs.</summary>
    internal static class Win32
    {
        internal const uint WM_DESTROY = 0x0002, WM_SIZE = 0x0005, WM_SETFOCUS = 0x0007, WM_CLOSE = 0x0010, WM_GETMINMAXINFO = 0x0024,
            WM_DPICHANGED = 0x02E0, WM_APP = 0x8000;
        internal const uint WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_VISIBLE = 0x10000000, WS_CLIPCHILDREN = 0x02000000;
        internal const int CW_USEDEFAULT = unchecked((int)0x80000000), SW_SHOW = 5, IDC_ARROW = 32512, ICON_SMALL = 0, ICON_BIG = 1;
        internal const uint WM_SETICON = 0x0080;

        internal delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct WNDCLASSEX
        {
            public uint cbSize, style;
            public IntPtr lpfnWndProc;
            public int cbClsExtra, cbWndExtra;
            public IntPtr hInstance, hIcon, hCursor, hbrBackground;
            public string? lpszMenuName, lpszClassName;
            public IntPtr hIconSm;
        }

        [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct MINMAXINFO { public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize; }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern ushort RegisterClassExW(ref WNDCLASSEX c);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style, int x, int y, int w, int h,
            IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] internal static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] internal static extern bool UpdateWindow(IntPtr h);
        [DllImport("user32.dll")] internal static extern bool DestroyWindow(IntPtr h);
        [DllImport("user32.dll")] internal static extern void PostQuitMessage(int code);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetMessageW(out MSG m, IntPtr h, uint min, uint max);
        [DllImport("user32.dll")] internal static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr DispatchMessageW(ref MSG m);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] internal static extern IntPtr LoadCursorW(IntPtr inst, IntPtr name);
        [DllImport("user32.dll")] internal static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] internal static extern bool AdjustWindowRectExForDpi(ref RECT r, uint style, bool menu, uint exStyle, uint dpi);
        [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int MessageBoxW(IntPtr h, string text, string caption, uint type);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandleW(string? name);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint ExtractIconExW(string file, int index, out IntPtr large, out IntPtr small, uint count);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr ShellExecuteW(IntPtr h, string? verb, string file, string? args, string? dir, int show);

        /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2</summary>
        internal static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    }
}
