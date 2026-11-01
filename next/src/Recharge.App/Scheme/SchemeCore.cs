using System;
using System.IO;

namespace Recharge.App.Scheme
{
    /// <summary>
    /// The platform-neutral answer to a recharge:// request: which file (or which error), its type, and the byte window to send.
    /// The Windows shell turns this into a WebView2 response; it uses the same resolvers as the Linux handler (UiPathResolver,
    /// MapPathResolver, BackgroundPathResolver), so the path rules and mime types are identical on both.
    /// </summary>
    internal sealed class SchemeAnswer
    {
        internal int Status { get; init; } = 200;
        internal string Message { get; init; } = "";
        internal string FullPath { get; init; } = "";
        internal string MimeType { get; init; } = "application/octet-stream";
        /// <summary>First byte to send.</summary>
        internal long Start { get; init; }
        /// <summary>How many bytes to send.</summary>
        internal long Count { get; init; }
        /// <summary>The whole file's length.</summary>
        internal long Total { get; init; }
        /// <summary>Content-Range value for a 206/416, else null.</summary>
        internal string? ContentRange { get; init; }
        /// <summary>Maps and backgrounds are read by the app pages from another origin.</summary>
        internal bool CrossOrigin { get; init; }
        internal bool IsFile => Status == 200 || Status == 206;

        internal static SchemeAnswer Error(int code, string message) => new SchemeAnswer { Status = code, Message = message };
    }

    internal static class SchemeCore
    {
        /// <summary>Resolves one recharge:// address. rangeHeader is the request's Range header (used for backgrounds only).</summary>
        internal static SchemeAnswer Resolve(string uiRoot, string uri, string? rangeHeader)
        {
            if (uri.StartsWith("recharge://maps/", StringComparison.OrdinalIgnoreCase))
            {
                string? game = Recharge.App.Bridge.GameFinder.Find();
                if (game is null) return SchemeAnswer.Error(404, "The game is not installed.");
                return Whole(MapPathResolver.Resolve(MapPathResolver.MapsRoot(game), uri), true);
            }
            if (uri.StartsWith("recharge://bg/", StringComparison.OrdinalIgnoreCase))
            {
                UiPathResult r = BackgroundPathResolver.Resolve(
                    BackgroundPathResolver.Root(Recharge.App.Settings.SettingsStore.DataDir()), uri);
                SchemeAnswer whole = Whole(r, true);
                if (!whole.IsFile) return whole;
                ByteRange range = ByteRange.Parse(rangeHeader, whole.Total);
                if (range.Result == ByteRange.Kind.Unsatisfiable)
                    return new SchemeAnswer { Status = 416, MimeType = r.MimeType, FullPath = r.FullPath, Total = whole.Total, ContentRange = "bytes */" + whole.Total, CrossOrigin = true };
                if (range.Result == ByteRange.Kind.Partial)
                    return new SchemeAnswer
                    {
                        Status = 206, MimeType = r.MimeType, FullPath = r.FullPath, Start = range.Start, Count = range.Length, Total = whole.Total,
                        ContentRange = "bytes " + range.Start + "-" + range.End + "/" + whole.Total, CrossOrigin = true,
                    };
                return whole;
            }
            return Whole(UiPathResolver.Resolve(uiRoot, uri), false);
        }

        private static SchemeAnswer Whole(UiPathResult r, bool crossOrigin)
        {
            if (r.Status == UiPathStatus.Forbidden) return SchemeAnswer.Error(403, r.Message);
            if (r.Status == UiPathStatus.NotFound) return SchemeAnswer.Error(404, r.Message);
            try
            {
                long length = new FileInfo(r.FullPath).Length;
                return new SchemeAnswer { Status = 200, FullPath = r.FullPath, MimeType = r.MimeType, Start = 0, Count = length, Total = length, CrossOrigin = crossOrigin };
            }
            catch (Exception ex) { return SchemeAnswer.Error(500, ex.Message); }
        }
    }
}
