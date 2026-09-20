namespace RechargeCustomSkins
{
    internal struct GlobalSoundSlot
    {
        public readonly string Name;
        public readonly Audio.AUDIO_ID Id;

        public GlobalSoundSlot(string name, Audio.AUDIO_ID id)
        {
            Name = name;
            Id = id;
        }
    }

    // Footsteps, landing, and the low-stamina "tired" sound aren't fields on
    // Movement at all - they're entries in the shared Audio singleton's
    // audioLibrary, looked up by AUDIO_ID (see Audio.PlayAudio). Movement is
    // the only class anywhere in the game that reads these four IDs, so
    // overriding them is effectively player-only despite going through a
    // "global" system that other objects (springs, boxes, ...) also share.
    internal static class GlobalSoundSlots
    {
        public static readonly GlobalSoundSlot[] All =
        {
            new GlobalSoundSlot("MetalFootstep", Audio.AUDIO_ID.MetalFootstep),
            new GlobalSoundSlot("GrassFootstep", Audio.AUDIO_ID.GrassFootstep),
            new GlobalSoundSlot("MetalLand", Audio.AUDIO_ID.MetalLand),
            new GlobalSoundSlot("Tired", Audio.AUDIO_ID.mossTiredSound),
        };
    }
}
