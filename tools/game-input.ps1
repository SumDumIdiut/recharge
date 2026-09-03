<#
Minimal Win32 automation for testing the actual IGTAP game window (not a
webview - CDP/devtools.js doesn't apply here). Screenshot via PrintWindow,
input via SendInput (not the legacy keybd_event/mouse_event) so it registers
with Unity's new Input System, which reads via raw input and can miss
synthesized legacy messages.
#>

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;

public static class GameWin32 {
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x02, MOUSEEVENTF_LEFTUP = 0x04;
    public const uint KEYEVENTF_KEYUP = 0x02;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1;

    public static IntPtr FindGameWindow() {
        return FindWindow(null, "IGTAPsnfDemo");
    }

    public static Bitmap Capture(IntPtr hWnd) {
        RECT rect;
        GetWindowRect(hWnd, out rect);
        int w = rect.Right - rect.Left, h = rect.Bottom - rect.Top;
        var bmp = new Bitmap(w, h);
        using (var g = Graphics.FromImage(bmp)) {
            var hdc = g.GetHdc();
            PrintWindow(hWnd, hdc, 2); // PW_RENDERFULLCONTENT
            g.ReleaseHdc(hdc);
        }
        return bmp;
    }

    public static void ClickScreen(int x, int y) {
        SetCursorPos(x, y);
        var down = new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_LEFTDOWN } } };
        var up = new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_LEFTUP } } };
        SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(50);
        SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void PressKey(ushort vk) {
        HoldKey(vk, 80);
    }

    public static void HoldKey(ushort vk, int holdMs) {
        var down = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk } } };
        var up = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, dwFlags = KEYEVENTF_KEYUP } } };
        SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(holdMs);
        SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@ -ReferencedAssemblies System.Drawing

function Get-GameWindow {
    $h = [GameWin32]::FindGameWindow()
    if ($h -eq [IntPtr]::Zero) { throw "Game window not found - is it running and titled correctly?" }
    return $h
}

function Show-GameWindowTopmost {
    $h = Get-GameWindow
    [GameWin32]::SetForegroundWindow($h) | Out-Null
    [GameWin32]::SetWindowPos($h, [GameWin32]::HWND_TOPMOST, 0, 0, 0, 0, [GameWin32]::SWP_NOMOVE -bor [GameWin32]::SWP_NOSIZE) | Out-Null
}

function Save-GameScreenshot([string]$Path) {
    $h = Get-GameWindow
    $bmp = [GameWin32]::Capture($h)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Saved screenshot to $Path"
}

function Get-GameWindowRect {
    $h = Get-GameWindow
    $rect = New-Object GameWin32+RECT
    [GameWin32]::GetWindowRect($h, [ref]$rect) | Out-Null
    return $rect
}

# x/y are fractions (0-1) of the game window's client area, so coordinates
# survive window moves/resizes between calls.
function Send-GameClick([double]$xFrac, [double]$yFrac) {
    $rect = Get-GameWindowRect
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $x = $rect.Left + [int]($w * $xFrac)
    $y = $rect.Top + [int]($h * $yFrac)
    [GameWin32]::ClickScreen($x, $y)
}

function Send-GameKey([int]$vk) {
    [GameWin32]::PressKey([uint16]$vk)
}

function Send-GameKeyHold([int]$vk, [int]$holdMs) {
    [GameWin32]::HoldKey([uint16]$vk, $holdMs)
}
