using System;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>Authenticated HTTP proxy for Cloudflare's SFU REST API. SDP/track JSON is opaque here.</summary>
    public sealed partial class SocialServer
    {
        private async Task VoiceApi(HttpListenerContext ctx, string method, string[] seg, string me)
        {
            _voiceLimit.Hit(SocialService.Norm(me), "You are making voice requests too fast.");

            if (seg.Length == 3 && seg[2] == "session" && method == "POST")
            {
                await ReplyRaw(ctx, await _voiceApi.NewSession().ConfigureAwait(false)).ConfigureAwait(false);
                return;
            }
            if (seg.Length == 3 && seg[2] == "ice" && method == "GET")
            {
                await ReplyRaw(ctx, await _voiceApi.Ice().ConfigureAwait(false)).ConfigureAwait(false);
                return;
            }
            if (seg.Length >= 4 && seg[2] == "session")
            {
                string sid = seg[3];
                if (!CloudflareVoiceClient.ValidSessionId(sid)) throw new SocialException(400, "That voice session id is not valid.");
                if (seg.Length == 4 && method == "GET")
                {
                    await ReplyRaw(ctx, await _voiceApi.Session(sid).ConfigureAwait(false)).ConfigureAwait(false);
                    return;
                }
                if (seg.Length == 5 && seg[4] == "tracks" && method == "POST")
                {
                    byte[] body = await ReadRawBody(ctx.Request).ConfigureAwait(false);
                    await ReplyRaw(ctx, await _voiceApi.NewTracks(sid, body).ConfigureAwait(false)).ConfigureAwait(false);
                    return;
                }
                if (seg.Length == 5 && seg[4] == "renegotiate" && method == "PUT")
                {
                    byte[] body = await ReadRawBody(ctx.Request).ConfigureAwait(false);
                    await ReplyRaw(ctx, await _voiceApi.Renegotiate(sid, body).ConfigureAwait(false)).ConfigureAwait(false);
                    return;
                }
                if (seg.Length == 6 && seg[4] == "tracks" && seg[5] == "close" && method == "PUT")
                {
                    byte[] body = await ReadRawBody(ctx.Request).ConfigureAwait(false);
                    await ReplyRaw(ctx, await _voiceApi.CloseTracks(sid, body).ConfigureAwait(false)).ConfigureAwait(false);
                    return;
                }
            }
            throw new SocialException(404, "Not found.");
        }

        private async Task<byte[]> ReadRawBody(HttpListenerRequest req)
        {
            if (!req.HasEntityBody) return Array.Empty<byte>();
            if (req.ContentLength64 > _o.MaxBodyBytes) throw new SocialException(413, "That request is too large.");
            using var ms = new MemoryStream();
            var buf = new byte[4096];
            int n;
            while ((n = await req.InputStream.ReadAsync(buf).ConfigureAwait(false)) > 0)
            {
                ms.Write(buf, 0, n);
                if (ms.Length > _o.MaxBodyBytes) throw new SocialException(413, "That request is too large.");
            }
            return ms.ToArray();
        }

        private static async Task ReplyRaw(HttpListenerContext ctx, byte[] bytes)
        {
            try
            {
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.ContentLength64 = bytes.Length;
                await ctx.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
                ctx.Response.Close();
            }
            catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException || e is IOException || e is InvalidOperationException)
            {
                try { ctx.Response.Abort(); } catch (ObjectDisposedException) { }
            }
        }
    }
}
