using System;
using System.Collections.Generic;
using System.Linq;

namespace Recharge.App.Library
{
    /// <summary>
    /// Decides whether uploading a local map is a new hub entry or an update of one of the author's existing uploads.
    /// The old rule ("same map uid means update") let a copy of a map overwrite its source's upload, because copies share the uid.
    /// Now a uid match is only an automatic update when it is unambiguous and plausible; otherwise the default is a new upload
    /// and <see cref="Decision.NeedsChoice"/> tells the UI to show the choice. The user can always pick "Update of" explicitly.
    /// </summary>
    public static class UploadMatcher
    {
        public sealed class Local
        {
            public string Folder = "";
            public string Name = "";
            public string? Uid;
            /// <summary>hub.json id: the upload this folder was installed from or uploaded as.</summary>
            public string? HubId;
        }

        public sealed class Upload
        {
            public string Id = "";
            public string Name = "";
            public string? MapUid;
        }

        public sealed class Decision
        {
            public bool IsUpdate;
            public string? TargetId;
            public bool NeedsChoice;
            public string Reason = "";
            /// <summary>Uploads the user may pick as "Update of" (all plausible-by-uid or same-name ones).</summary>
            public List<string> Candidates = new List<string>();
        }

        public static Decision Match(Local map, IReadOnlyList<Local> localFolders, IReadOnlyList<Upload> uploads)
        {
            var d = new Decision();
            var byUid = string.IsNullOrEmpty(map.Uid) ? new List<Upload>() : uploads.Where(u => u.MapUid == map.Uid).ToList();
            var sameName = uploads.Where(u => Same(u.Name, map.Name)).ToList();
            d.Candidates = byUid.Concat(sameName).Select(u => u.Id).Distinct().ToList();

            if (byUid.Count > 0)
            {
                bool sharedLocally = localFolders.Count(f => f.Uid == map.Uid && f.Folder != map.Folder) > 0;
                if (sharedLocally) return New(d, "another local map folder has the same map id", true);
                if (byUid.Count > 1) return New(d, "several uploads have this map id", true);
                Upload u = byUid[0];
                string? recordedFolder = localFolders.FirstOrDefault(f => f.HubId == u.Id)?.Folder;
                if (!Same(u.Name, map.Name) && recordedFolder != map.Folder)
                    return New(d, "the map id matches \"" + u.Name + "\" but the name and folder differ", true);
                return Update(d, u.Id, "same map id, " + (recordedFolder == map.Folder ? "same folder" : "same name"));
            }

            // no uid match: the hub id this folder was installed or uploaded as, then a unique same-named upload
            if (map.HubId != null && uploads.Any(u => u.Id == map.HubId)
                && !localFolders.Any(f => f.HubId == map.HubId && f.Folder != map.Folder))
                return Update(d, map.HubId, "this folder was uploaded as it");
            if (sameName.Count == 1 && !localFolders.Any(f => f.HubId == sameName[0].Id && f.Folder != map.Folder))
                return Update(d, sameName[0].Id, "same name");
            return New(d, "no matching upload", sameName.Count > 0);
        }

        private static bool Same(string a, string b) => string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);

        private static Decision New(Decision d, string reason, bool choice) { d.IsUpdate = false; d.TargetId = null; d.Reason = reason; d.NeedsChoice = choice; return d; }

        private static Decision Update(Decision d, string id, string reason) { d.IsUpdate = true; d.TargetId = id; d.Reason = reason; return d; }
    }
}
