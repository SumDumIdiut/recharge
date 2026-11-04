using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Models;

namespace Recharge.App.Updates
{
    public enum CheckState
    {
        /// <summary>The manifest URL answered 404: nothing has been published for this channel yet.</summary>
        NoneYet,
        UpToDate,
        Available,
    }

    public sealed class CheckResult
    {
        public CheckState State { get; set; }
        public string Version { get; set; } = "";
        public int Build { get; set; }
        public int FileCount { get; set; }
        public long DownloadBytes { get; set; }
    }

    public enum StartupAction
    {
        None,
        /// <summary>A staged version was swapped in; start it (see <see cref="StartupResult.Launch"/>) and exit.</summary>
        Applied,
        /// <summary>The last swapped-in version never confirmed a start; the previous one is back. Restart.</summary>
        RolledBack,
    }

    public sealed class StartupResult
    {
        public StartupAction Action { get; set; }
        public string Version { get; set; } = "";
        public string Launch { get; set; } = "";
    }

    public sealed class UpdaterOptions
    {
        public string ManifestUrl { get; set; } = "";
        /// <summary>Where content-addressed files live (url + "/" + sha256). Default: "files" beside the channel folder.</summary>
        public string? FilesBase { get; set; }
        /// <summary>The folder that holds the running app; the new version is built beside it and swapped in on the next start.</summary>
        public string AppDir { get; set; } = "";
        public string DataDir { get; set; } = "";
        public string Platform { get; set; } = Updater.CurrentPlatform();
        public string CurrentVersion { get; set; } = "0.0.0";
        /// <summary>The running build number (the launcher's global CI counter); 0 when unknown, then versions decide.</summary>
        public int CurrentBuild { get; set; }
        /// <summary>A second channel manifest to consider (beta also takes stable releases, like the launcher); the higher build wins.</summary>
        public string? AltManifestUrl { get; set; }
        public HttpClient? Http { get; set; }
        public int Parallel { get; set; } = 4;
    }

    /// <summary>
    /// Recharge's own updater for installs the launcher does not manage. Check reads the launcher's channel manifest (format 1,
    /// /recharge/update/&lt;beta|stable&gt;/manifest.json; beta also looks at stable and takes the higher build) and compares build numbers; Download builds a
    /// complete copy of the new version next to the app folder (unchanged files copied from the running app, the rest fetched by sha256 and
    /// verified); the swap happens on the next start (<see cref="Startup"/>): the app folder becomes "&lt;app&gt;.old" and the copy takes its
    /// place. If the new version doesn't confirm a start (<see cref="Confirm"/>) the next start swaps the old one back and never offers
    /// that build again.
    /// </summary>
    public sealed class Updater
    {
        public const string DefaultBase = "https://codecade.co.za/recharge/update";

        private static readonly HttpClient SharedHttp = MakeHttp();
        private readonly UpdaterOptions _o;
        private ManifestInfo? _manifest;

        public Updater(UpdaterOptions options)
        {
            _o = options ?? throw new ArgumentNullException(nameof(options));
            if (string.IsNullOrEmpty(_o.ManifestUrl)) throw new ArgumentException("A manifest URL is required.");
            if (string.IsNullOrEmpty(_o.AppDir) || string.IsNullOrEmpty(_o.DataDir)) throw new ArgumentException("AppDir and DataDir are required.");
        }

        private static HttpClient MakeHttp()
        {
            var c = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            c.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext-Updater");
            return c;
        }

        public static string CurrentPlatform()
        {
            string arch = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
            return (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "windows-" : "linux-") + arch;
        }

        /// <summary>https://codecade.co.za/recharge/update/&lt;beta|stable&gt;/manifest.json (the launcher's channels) unless the user set another address.</summary>
        public static string ManifestUrlFor(string channel, string? overrideUrl) =>
            !string.IsNullOrWhiteSpace(overrideUrl) ? overrideUrl!.Trim() : DefaultBase + "/" + UpdateRules.NormalizeChannel(channel) + "/manifest.json";

        /// <summary>The stable manifest a beta install also considers; null for stable or a custom address.</summary>
        public static string? AltManifestUrlFor(string channel, string? overrideUrl) =>
            string.IsNullOrWhiteSpace(overrideUrl) && UpdateRules.NormalizeChannel(channel) == "beta" ? ManifestUrlFor("stable", null) : null;

        /// <summary>The "files" folder beside the manifest's channel folder: .../update/next-beta/manifest.json gives .../update/files.</summary>
        public static string DefaultFilesBase(string manifestUrl)
        {
            var u = new Uri(manifestUrl);
            string path = u.AbsolutePath;
            int last = path.LastIndexOf('/');
            string dir = last <= 0 ? "" : path.Substring(0, last);
            int up = dir.LastIndexOf('/');
            string parent = up < 0 ? "" : dir.Substring(0, up);
            return u.GetLeftPart(UriPartial.Authority) + parent + "/files";
        }

        private string FilesBase => (_o.FilesBase ?? DefaultFilesBase(_o.ManifestUrl)).TrimEnd('/');
        private HttpClient Http => _o.Http ?? SharedHttp;
        private string AppDir => Path.TrimEndingDirectorySeparator(Path.GetFullPath(_o.AppDir));
        public static string NextDir(string appDir) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(appDir)) + ".next";
        public static string OldDir(string appDir) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(appDir)) + ".old";
        private string CacheDir => Path.Combine(UpdateState.UpdatesDir(_o.DataDir), "cache");

        // ---- check ----

        public async Task<CheckResult> CheckAsync(CancellationToken ct = default)
        {
            _manifest = null;
            Task<ManifestInfo?> own = FetchAsync(_o.ManifestUrl, ct);
            Task<ManifestInfo?> alt = string.IsNullOrEmpty(_o.AltManifestUrl) ? Task.FromResult<ManifestInfo?>(null) : FetchAsync(_o.AltManifestUrl!, ct);
            ManifestInfo? ownInfo = null;
            Exception? ownError = null;
            try { ownInfo = await own.ConfigureAwait(false); } catch (Exception e) { ownError = e; }
            ManifestInfo? altInfo = await SafeAsync(alt).ConfigureAwait(false);
            if (ownError != null && altInfo == null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ownError).Throw();
            // Only builds of this app count: the other product on a channel (the old app on stable) is never an update.
            if (ownInfo != null && !ownInfo.IsRechargeApp) ownInfo = null;
            if (altInfo != null && !altInfo.IsRechargeApp) altInfo = null;
            ManifestInfo? m = UpdateRules.PickNewest(ownInfo, altInfo);
            if (m == null) return new CheckResult { State = CheckState.NoneYet };

            UpdateState state = UpdateState.Load(_o.DataDir);
            var result = new CheckResult { Version = m.Version, Build = m.Build, FileCount = m.Files.Count };
            string haveVersion = !string.IsNullOrEmpty(state.InstalledVersion) ? state.InstalledVersion : _o.CurrentVersion;
            int haveBuild = _o.CurrentBuild > 0 ? _o.CurrentBuild : state.InstalledBuild;
            if (!UpdateRules.IsNewer(m.Version, m.Build, haveVersion, haveBuild) || state.Bad.Contains(m.Build))
            {
                result.State = CheckState.UpToDate;
                return result;
            }
            result.State = CheckState.Available;
            result.DownloadBytes = UpdateRules.DownloadBytes(m.Files, HasInstalled);
            _manifest = m;
            return result;
        }

        private static async Task<ManifestInfo?> SafeAsync(Task<ManifestInfo?> t)
        {
            try { return await t.ConfigureAwait(false); } catch (Exception) { return null; }
        }

        /// <summary>Fetches and validates one manifest. A 404 or 410 means nothing is published (null); other failures throw.</summary>
        private async Task<ManifestInfo?> FetchAsync(string url, CancellationToken ct)
        {
            using HttpResponseMessage response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotFound || response.StatusCode == HttpStatusCode.Gone) return null;
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException("The update server answered " + (int)response.StatusCode + ".");
            if (response.Content.Headers.ContentLength > 16 * 1024 * 1024) throw new InvalidOperationException("The update manifest is too big.");
            string text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            try { return ManifestInfo.Parse(text, _o.Platform); }
            catch (UpdateFormatException e) { throw new InvalidOperationException("The update manifest isn't usable: " + e.Message); }
        }

        private bool HasInstalled(UpdateManifest.UpdateFile f)
        {
            string? path = SafePath(AppDir, f.Path);
            return path != null && Matches(path, f);
        }

        // ---- download ----

        /// <summary>Builds the complete new version in "&lt;app&gt;.next" (run <see cref="CheckAsync"/> first). Nothing the running app uses is touched.</summary>
        public async Task<StagedBuild> DownloadAsync(IProgress<double>? progress = null, CancellationToken ct = default)
        {
            ManifestInfo m = _manifest ?? throw new InvalidOperationException("Check for updates first.");
            string next = NextDir(AppDir);
            if (Directory.Exists(next)) Directory.Delete(next, true);
            Directory.CreateDirectory(next);
            Directory.CreateDirectory(CacheDir);

            var files = m.Files.ToList();
            long total = Math.Max(1, files.Sum(f => Math.Max(1, f.Size)));
            long done = 0;
            var gate = new SemaphoreSlim(Math.Max(1, _o.Parallel));
            var tasks = new List<Task>();
            foreach (UpdateManifest.UpdateFile file in files)
            {
                string? target = SafePath(next, file.Path);
                if (target == null) throw new InvalidOperationException("The manifest has an unsafe path: " + file.Path);
                if (!IsHex(file.Sha256)) throw new InvalidOperationException("The manifest has a bad checksum for " + file.Path);
                await gate.WaitAsync(ct).ConfigureAwait(false);
                tasks.Add(Task.Run(async () =>
                {
                    try
                    {
                        await Place(file, target, ct).ConfigureAwait(false);
                        long now = Interlocked.Add(ref done, Math.Max(1, file.Size));
                        progress?.Report(Math.Min(1.0, (double)now / total));
                    }
                    finally { gate.Release(); }
                }, ct));
            }
            try { await Task.WhenAll(tasks).ConfigureAwait(false); }
            catch
            {
                try { Directory.Delete(next, true); } catch (IOException) { }
                throw;
            }

            // Verify the finished tree against the manifest before offering it.
            foreach (UpdateManifest.UpdateFile file in files)
            {
                string target = SafePath(next, file.Path)!;
                if (!Matches(target, file)) { Directory.Delete(next, true); throw new InvalidOperationException("Verification failed for " + file.Path); }
            }
            if (!string.IsNullOrEmpty(m.Launch))
            {
                string? launch = SafePath(next, m.Launch);
                if (launch != null && File.Exists(launch) && !OperatingSystem.IsWindows())
                    File.SetUnixFileMode(launch, File.GetUnixFileMode(launch) | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
            }

            UpdateState state = UpdateState.Load(_o.DataDir);
            var staged = new StagedBuild { Version = m.Version, Build = m.Build, Channel = m.Channel, Dir = next, Launch = m.Launch };
            state.Staged = staged;
            state.Save(_o.DataDir);
            PruneCache(files);
            return staged;
        }

        private async Task Place(UpdateManifest.UpdateFile file, string target, CancellationToken ct)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            string? current = SafePath(AppDir, file.Path);
            if (current != null && Matches(current, file)) { File.Copy(current, target, true); return; }
            string cached = Path.Combine(CacheDir, file.Sha256.ToLowerInvariant());
            if (!(File.Exists(cached) && Matches(cached, file)))
            {
                await Fetch(file, cached, ct).ConfigureAwait(false);
            }
            File.Copy(cached, target, true);
        }

        /// <summary>Downloads one content-addressed file, checks size and sha256, retries a couple of times.</summary>
        private async Task Fetch(UpdateManifest.UpdateFile file, string cached, CancellationToken ct)
        {
            string url = FilesBase + "/" + file.Sha256.ToLowerInvariant();
            string part = cached + "." + Guid.NewGuid().ToString("N") + ".part";
            Exception? last = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    using HttpResponseMessage r = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
                    if (!r.IsSuccessStatusCode) throw new InvalidOperationException(file.Path + ": the server answered " + (int)r.StatusCode);
                    using (Stream src = await r.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
                    using (FileStream dst = File.Create(part))
                        await src.CopyToAsync(dst, ct).ConfigureAwait(false);
                    if (!Matches(part, file)) throw new InvalidDataException(file.Path + ": the download doesn't match its checksum");
                    File.Move(part, cached, true);
                    return;
                }
                catch (Exception e) when (!(e is OperationCanceledException) && (e is HttpRequestException || e is IOException || e is InvalidDataException || e is InvalidOperationException))
                {
                    last = e;
                    await Task.Delay(100 * (attempt + 1), ct).ConfigureAwait(false);
                }
                finally { try { if (File.Exists(part)) File.Delete(part); } catch (IOException) { } }
            }
            throw new InvalidOperationException(last?.Message ?? "download failed", last);
        }

        private void PruneCache(IEnumerable<UpdateManifest.UpdateFile> keep)
        {
            try
            {
                var keepNames = new HashSet<string>(keep.Select(f => f.Sha256.ToLowerInvariant()), StringComparer.Ordinal);
                foreach (string f in Directory.EnumerateFiles(CacheDir))
                    if (!keepNames.Contains(Path.GetFileName(f))) File.Delete(f);
            }
            catch (IOException) { }
        }

        // ---- startup (apply, confirm, roll back) ----

        /// <summary>
        /// Call first thing at start. If the previous swapped-in version never confirmed, swaps back to the old one; otherwise swaps in a staged
        /// version. Either way the caller must restart the app from <see cref="StartupResult.Launch"/> (or its own launcher) and exit.
        /// </summary>
        public static StartupResult Startup(string appDir, string dataDir)
        {
            if (InstallMode.DetectCurrent().Managed) return new StartupResult { Action = StartupAction.None }; // the launcher swaps files, never the app
            string app = Path.TrimEndingDirectorySeparator(Path.GetFullPath(appDir));
            string old = OldDir(app);
            string next = NextDir(app);
            UpdateState state = UpdateState.Load(dataDir);

            if (state.Pending != null)
            {
                if (state.Pending.Launches < 1)
                {
                    state.Pending.Launches++;
                    state.Save(dataDir);
                    return new StartupResult { Action = StartupAction.None };
                }
                // The version swapped in last time started but never confirmed: it failed. Put the old one back.
                if (Directory.Exists(old))
                {
                    string bad = app + ".bad";
                    if (Directory.Exists(bad)) Directory.Delete(bad, true);
                    Directory.Move(app, bad);
                    Directory.Move(old, app);
                    TryDelete(bad);
                    if (!state.Bad.Contains(state.Pending.Build)) state.Bad.Add(state.Pending.Build);
                    state.LastRollback = state.Pending.Version;
                    state.InstalledVersion = state.PreviousVersion;
                    state.InstalledBuild = state.PreviousBuild;
                    state.Pending = null;
                    state.Staged = null;
                    state.Save(dataDir);
                    return new StartupResult { Action = StartupAction.RolledBack, Version = state.InstalledVersion };
                }
                state.Pending = null; // nothing to go back to
                state.Save(dataDir);
                return new StartupResult { Action = StartupAction.None };
            }

            StagedBuild? staged = state.Staged;
            if (staged != null)
            {
                if (!Directory.Exists(next) || state.Bad.Contains(staged.Build))
                {
                    state.Staged = null;
                    state.Save(dataDir);
                    if (Directory.Exists(next)) TryDelete(next);
                    return new StartupResult { Action = StartupAction.None };
                }
                if (Directory.Exists(old)) Directory.Delete(old, true);
                Directory.Move(app, old);
                try { Directory.Move(next, app); }
                catch { Directory.Move(old, app); throw; }
                state.PreviousVersion = state.InstalledVersion;
                state.PreviousBuild = state.InstalledBuild;
                state.InstalledVersion = staged.Version;
                state.InstalledBuild = staged.Build;
                state.Pending = new PendingBuild { Version = staged.Version, Build = staged.Build, Launches = 0 };
                state.Staged = null;
                state.Save(dataDir);
                return new StartupResult { Action = StartupAction.Applied, Version = staged.Version, Launch = Path.Combine(app, staged.Launch) };
            }
            return new StartupResult { Action = StartupAction.None };
        }

        /// <summary>The app is up and working: the swapped-in version is kept. Call once the UI has loaded.</summary>
        public static void Confirm(string dataDir)
        {
            // A launcher-started build must write started-<build>.ok or the launcher rolls it back after 20 seconds.
            try
            {
                string? marker = InstallMode.DetectCurrent().StartedMarkerPath();
                if (marker != null) File.WriteAllText(marker, "ok");
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            UpdateState state = UpdateState.Load(dataDir);
            if (state.Pending == null) return;
            state.Pending = null;
            state.Save(dataDir);
        }

        // ---- helpers ----

        private static void TryDelete(string dir)
        {
            try { Directory.Delete(dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        private static bool IsHex(string s) => s.Length == 64 && s.All(Uri.IsHexDigit);

        /// <summary>A manifest path below <paramref name="root"/>, or null when it would escape it.</summary>
        public static string? SafePath(string root, string relative)
        {
            if (string.IsNullOrEmpty(relative) || relative.Contains('\0') || relative.Contains('\\')) return null;
            if (relative.StartsWith('/') || Path.IsPathRooted(relative)) return null;
            if (relative.Split('/').Any(p => p == ".." || p == "." || p.Length == 0)) return null;
            string full = Path.GetFullPath(Path.Combine(root, relative));
            string prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
            return full.StartsWith(prefix, StringComparison.Ordinal) ? full : null;
        }

        private static bool Matches(string path, UpdateManifest.UpdateFile f)
        {
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists || (f.Size > 0 && info.Length != f.Size)) return false;
                using FileStream s = File.OpenRead(path);
                string got = Convert.ToHexString(SHA256.HashData(s));
                return string.Equals(got, f.Sha256, StringComparison.OrdinalIgnoreCase);
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }
    }
}
