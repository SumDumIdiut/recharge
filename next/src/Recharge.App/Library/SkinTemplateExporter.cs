using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

namespace Recharge.App.Library
{
    /// <summary>Exports the same starter files as the stable app, from the official skins repository.</summary>
    internal static class SkinTemplateExporter
    {
        private const string ArchiveUrl = "https://codeload.github.com/SumDumIdiut/recharge-skins/zip/refs/heads/main";
        private const long MaxArchiveBytes = 32L * 1024 * 1024;
        private const long MaxUnpackedBytes = 64L * 1024 * 1024;
        private static readonly HttpClient Client = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(45),
            MaxResponseContentBufferSize = MaxArchiveBytes,
        };

        public static async Task<string> ExportAsync(string folder)
        {
            string target = Path.Combine(folder, "SkinTemplate");
            if (Directory.Exists(target) || File.Exists(target))
                throw new IOException("SkinTemplate already exists in this folder. Choose another destination.");

            using var response = await Client.GetAsync(ArchiveUrl).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            using var package = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
            using var zip = FolderStore.OpenZip(package);
            string tmp = FolderStore.NewScratch(folder);
            try
            {
                Directory.CreateDirectory(tmp);
                FolderStore.ExtractSafely(zip, tmp, MaxUnpackedBytes);
                string template = Path.Combine(tmp, "recharge-skins-main", "templates", "skin-template");
                if (!File.Exists(Path.Combine(template, "skin-template.png")))
                    throw new InvalidOperationException("the skin template is missing from the archive");

                // Publish only after extraction succeeds. Move also refuses to replace another export.
                Directory.Move(template, target);
                return target;
            }
            finally { FolderStore.TryDelete(tmp); }
        }
    }
}
