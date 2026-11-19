using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Recharge.App.Bridge;
using Recharge.App.Scheme;
using Recharge.Core.Json;

namespace Recharge.Tests
{
    public static class AppTests
    {
        [Test]
        public static void UiPathResolvesFilesAndMimeTypes()
        {
            string root = Path.Combine(Path.GetTempPath(), "rn-ui-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                File.WriteAllText(Path.Combine(root, "index.html"), "<!doctype html>");
                File.WriteAllText(Path.Combine(root, "app.js"), "0");
                File.WriteAllText(Path.Combine(root, "app.mjs"), "0");
                File.WriteAllText(Path.Combine(root, "app.css"), "0");
                File.WriteAllText(Path.Combine(root, "logo.png"), "0");
                File.WriteAllText(Path.Combine(root, "photo.jpg"), "0");
                File.WriteAllText(Path.Combine(root, "photo.jpeg"), "0");
                File.WriteAllText(Path.Combine(root, "photo.webp"), "0");
                File.WriteAllText(Path.Combine(root, "anim.gif"), "0");
                File.WriteAllText(Path.Combine(root, "icon.svg"), "0");
                File.WriteAllText(Path.Combine(root, "data.json"), "{}");
                File.WriteAllText(Path.Combine(root, "font.woff2"), "0");
                File.WriteAllText(Path.Combine(root, "clip.mp4"), "0");
                File.WriteAllText(Path.Combine(root, "clip.webm"), "0");

                UiPathResult index = UiPathResolver.Resolve(root, "recharge://app/");
                Assert.Equal(UiPathStatus.Ok, index.Status, "root status");
                Assert.Equal(Path.Combine(root, "index.html"), index.FullPath, "root index");
                Assert.True(index.MimeType.StartsWith("text/html", StringComparison.Ordinal), "html mime");

                var expected = new Dictionary<string, string>
                {
                    ["app.js"] = "text/javascript",
                    ["app.mjs"] = "text/javascript",
                    ["app.css"] = "text/css",
                    ["logo.png"] = "image/png",
                    ["photo.jpg"] = "image/jpeg",
                    ["photo.jpeg"] = "image/jpeg",
                    ["photo.webp"] = "image/webp",
                    ["anim.gif"] = "image/gif",
                    ["icon.svg"] = "image/svg+xml",
                    ["data.json"] = "application/json",
                    ["font.woff2"] = "font/woff2",
                    ["clip.mp4"] = "video/mp4",
                    ["clip.webm"] = "video/webm",
                };

                foreach (KeyValuePair<string, string> item in expected)
                {
                    UiPathResult result = UiPathResolver.Resolve(root, "recharge://app/" + item.Key);
                    Assert.Equal(UiPathStatus.Ok, result.Status, item.Key + " status");
                    Assert.True(
                        result.MimeType.StartsWith(item.Value, StringComparison.Ordinal),
                        item.Key + " mime was " + result.MimeType);
                }

                UiPathResult withQuery = UiPathResolver.Resolve(root, "recharge://app/app.js?v=1#frag");
                Assert.Equal(UiPathStatus.Ok, withQuery.Status, "query status");
                Assert.Equal(Path.Combine(root, "app.js"), withQuery.FullPath, "query path");
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        }

        [Test]
        public static void UiPathRejectsTraversalAndAbsolutes()
        {
            string parent = Path.Combine(Path.GetTempPath(), "rn-ui-" + Guid.NewGuid().ToString("N"));
            string root = Path.Combine(parent, "ui");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(parent, "secret.txt"), "secret");
            try
            {
                string[] attacks =
                {
                    "recharge://app/../secret.txt",
                    "recharge://app/%2e%2e/secret.txt",
                    "recharge://app/sub/%2E%2E/secret.txt",
                    "recharge://app//etc/passwd",
                    "recharge://app/%2Fetc/passwd",
                    "recharge://other/index.html",
                };

                foreach (string attack in attacks)
                {
                    UiPathResult result = UiPathResolver.Resolve(root, attack);
                    Assert.Equal(UiPathStatus.Forbidden, result.Status, attack);
                    Assert.Equal(string.Empty, result.FullPath, attack + " path");
                }

                UiPathResult missing = UiPathResolver.Resolve(root, "recharge://app/nope.js");
                Assert.Equal(UiPathStatus.NotFound, missing.Status, "missing status");
            }
            finally
            {
                Directory.Delete(parent, recursive: true);
            }
        }

        [Test]
        public static void JsLiteralEscapesDangerousText()
        {
            string input = "a\"b\\c\nd\r\t</script>\u2028\u2029 & < >";
            string literal = JsLiteral.Quote(input);

            var parsed = JsonReader.Parse(literal);
            Assert.True(parsed is JsonString, "literal parses as a JSON string");
            Assert.Equal(input, ((JsonString)parsed).Value, "literal round trip");
            Assert.False(literal.Contains("</script>", StringComparison.Ordinal), "closing script tag");
            Assert.True(literal.Contains("\\u003C/script", StringComparison.Ordinal), "escaped script tag");
            Assert.True(literal.Contains("\\u2028", StringComparison.Ordinal), "line separator");
            Assert.True(literal.Contains("\\u2029", StringComparison.Ordinal), "paragraph separator");
            Assert.True(literal.Contains("\\n", StringComparison.Ordinal), "newline");
            Assert.True(literal.Contains("\\\\", StringComparison.Ordinal), "backslash");
        }

        [Test]
        public static void BridgeParsesMessages()
        {
            bool ok = BridgeRequest.TryParse(
                "{\"id\":7,\"cmd\":\"echo\",\"args\":{\"x\":\"hi\"}}",
                out BridgeRequest? request,
                out string? error);
            Assert.True(ok, error ?? "parse failed");
            Assert.True(request is not null, "request");
            Assert.Equal("7", request!.IdJson, "id");
            Assert.Equal("echo", request.Command, "cmd");
            Assert.Equal("hi", ((JsonString)request.Args["x"]).Value, "args");

            Assert.False(BridgeRequest.TryParse("{", out _, out string? jsonError), "invalid json");
            Assert.True(jsonError is not null, "json error");
            Assert.False(BridgeRequest.TryParse("{\"id\":1}", out _, out string? cmdError), "missing cmd");
            Assert.True(cmdError is not null, "cmd error");
            Assert.False(
                BridgeRequest.TryParse("{\"id\":1,\"cmd\":\"x\",\"args\":[]}", out _, out string? argsError),
                "array args");
            Assert.True(argsError is not null, "args error");
        }

        [Test]
        public static void BridgeDispatchesFakeCommand()
        {
            var registry = new CommandRegistry();
            registry.Register("echo", args =>
            {
                string value = ((JsonString)args["x"]).Value.ToUpperInvariant();
                return Task.FromResult<JsonNode>(new JsonString(value));
            });

            var dispatcher = new BridgeDispatcher(registry);
            BridgeReply? reply = dispatcher
                .DispatchAsync("{\"id\":\"a1\",\"cmd\":\"echo\",\"args\":{\"x\":\"hi\"}}")
                .GetAwaiter()
                .GetResult();

            Assert.True(reply is not null, "reply");
            Assert.Equal("\"a1\"", reply!.IdJson, "string id");
            Assert.True(reply.Ok, "ok");
            Assert.Equal("HI", ((JsonString)reply.Payload).Value, "payload");
            Assert.True(
                reply.ToScript().StartsWith("window.__rechargeReply(\"a1\", true, ", StringComparison.Ordinal),
                "reply script");
        }

        [Test]
        public static void BridgeRegistersNativeVoiceAndSocialSend()
        {
            CommandRegistry registry = Commands.CreateRegistry();
            foreach (string name in new[]
            {
                "social.send", "voice.native.join", "voice.native.leave", "voice.native.mute", "voice.native.deafen",
            })
            {
                Assert.True(registry.TryGet(name, out _), name);
            }
        }

        [Test]
        public static void BridgeRejectsUnknownAndHandlesReady()
        {
            var dispatcher = new BridgeDispatcher(new CommandRegistry());
            BridgeReply? unknown = dispatcher
                .DispatchAsync("{\"id\":3,\"cmd\":\"nope\",\"args\":{}}")
                .GetAwaiter()
                .GetResult();

            Assert.True(unknown is not null, "unknown reply");
            Assert.False(unknown!.Ok, "unknown ok");
            Assert.Equal(
                "{\"error\":\"unknown command\"}",
                JsonWriter.Write(unknown.Payload, 0),
                "unknown payload");

            bool ready = false;
            dispatcher.Ready += () => ready = true;
            BridgeReply? readyReply = dispatcher
                .DispatchAsync("{\"id\":0,\"cmd\":\"__ready\",\"args\":{}}")
                .GetAwaiter()
                .GetResult();
            Assert.True(ready, "ready event");
            Assert.True(readyReply is null, "ready has no reply");
        }

        [Test]
        public static void VdfPathsParsesLibraryFolders()
        {
            const string sample = "\"libraryfolders\"\n" +
                "{\n" +
                "  \"0\"\n" +
                "  {\n" +
                "    \"path\" \"/home/oliver/.local/share/Steam\"\n" +
                "    \"label\" \"\"\n" +
                "  }\n" +
                "  \"1\"\n" +
                "  {\n" +
                "    \"path\" \"/mnt/games/Steam Library\"\n" +
                "  }\n" +
                "  \"2\"\n" +
                "  {\n" +
                "    \"path\" \"D:\\\\Games\\\\Steam\"\n" +
                "  }\n" +
                "}\n";

            IReadOnlyList<string> paths = VdfPaths.Parse(sample);
            Assert.Equal(3, paths.Count, "path count");
            Assert.Equal("/home/oliver/.local/share/Steam", paths[0], "first path");
            Assert.Equal("/mnt/games/Steam Library", paths[1], "spaced path");
            Assert.Equal("D:\\Games\\Steam", paths[2], "escaped path");
        }

        [Test]
        public static void HubGalleryPathValidation()
        {
            Assert.True(HubClient.IsGalleryPath("/api/skins/af65d3f0/gallery/gallery_1_player.png"), "skin sheet");
            Assert.True(HubClient.IsGalleryPath("/api/maps/83745288/gallery/Zrzut%20ekranu%202026.png"), "encoded name");
            Assert.False(HubClient.IsGalleryPath("/api/skins"), "list");
            Assert.False(HubClient.IsGalleryPath("/api/skins/x/file"), "package file");
            Assert.False(HubClient.IsGalleryPath("/api/skins/../gallery/x.png"), "dot segment");
            Assert.False(HubClient.IsGalleryPath("/api/skins/x/gallery/%2e%2e"), "encoded dot segment");
            Assert.False(HubClient.IsGalleryPath("/api/skins/x/gallery/a.png?y=1"), "query");
            Assert.False(HubClient.IsGalleryPath("/api/skins/x/gallery/"), "no file");
            Assert.False(HubClient.IsGalleryPath(null), "null");
        }

        [Test]
        public static void HubPathValidation()
        {
            Assert.True(HubPath.IsValid("/api/maps"), "maps");
            Assert.True(HubPath.IsValid("/api/maps?page=2"), "query");
            Assert.True(HubPath.IsValid("/api/"), "bare api");
            Assert.False(HubPath.IsValid(null), "null");
            Assert.False(HubPath.IsValid(""), "empty");
            Assert.False(HubPath.IsValid("/api"), "no slash");
            Assert.False(HubPath.IsValid("api/maps"), "relative");
            Assert.False(HubPath.IsValid("https://codecade.co.za/recharge/api/maps"), "absolute");
            Assert.False(HubPath.IsValid("/api/maps\nHost: evil"), "control character");

            Assert.Equal(
                "https://codecade.co.za/recharge/api/maps",
                HubPath.BuildUri("/api/maps"),
                "built uri");
        }
    }
}
