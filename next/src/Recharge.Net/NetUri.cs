using System;
using System.Globalization;
using System.Text;

namespace Recharge.Net
{
    /// <summary>The connection rule: port 443 is the public portal-proxied relay, anything else a plain self-hosted one.</summary>
    public static class NetUri
    {
        public const string DefaultHost = "codecade.co.za";
        public const int DefaultPort = 443;

        public static Uri For(string host, int port)
            => port == 443
                ? new Uri("wss://" + host + "/dotnet")
                : new Uri("ws://" + host + ":" + port.ToString(CultureInfo.InvariantCulture) + "/");
    }

    /// <summary>Cleaning of anything from the wire that is meant for display (TextMeshPro rich text).</summary>
    public static class NetText
    {
        public const string DefaultNameColor = "#FFFFFF";
        public const string DefaultDotColor = "#3399FF";

        /// <summary>Replaces &lt; and &gt; with the full-width forms so a name cannot inject rich-text tags.</summary>
        public static string SanitizeForRichText(string? s)
            => string.IsNullOrEmpty(s) ? (s ?? "") : s!.Replace('<', '＜').Replace('>', '＞');

        /// <summary>The client's colour check: exactly seven characters starting with '#'.</summary>
        public static bool IsValidColor(string? c)
            => !string.IsNullOrEmpty(c) && c!.Length == 7 && c[0] == '#';

        public static string ColorOr(string? c, string fallback) => IsValidColor(c) ? c! : fallback;

        /// <summary>"name: text" with the name coloured when the colour is trusted; both parts sanitised.</summary>
        public static string FormatChatLine(string? from, string? fromColor, string? text)
        {
            var safeFrom = SanitizeForRichText(from ?? "?");
            var safeText = SanitizeForRichText(text ?? "");
            var namePart = IsValidColor(fromColor) ? "<color=" + fromColor + ">" + safeFrom + "</color>" : safeFrom;
            return namePart + ": " + safeText;
        }
    }
}
