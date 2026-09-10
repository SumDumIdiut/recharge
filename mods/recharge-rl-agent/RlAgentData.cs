using System.Collections.Generic;

namespace RechargeRlAgent
{
    // Persisted via IRechargeHost.LoadConfig/SaveConfig, one entry per real
    // course - so training progress on Course 1 survives a restart/relaunch
    // instead of starting the evolution search over from random weights.
    internal class RlAgentSave
    {
        public Dictionary<int, CourseRecord> Courses { get; set; } = new Dictionary<int, CourseRecord>();
    }

    internal class CourseRecord
    {
        public float[] ChampionWeights { get; set; }
        public float BestTime { get; set; } = float.MaxValue;
        public int Generation { get; set; }
        public int EpisodesRun { get; set; }
    }
}
