namespace RechargeCustomSkins
{
    internal struct PlayerSoundSlot
    {
        public readonly string Name;
        public readonly string FieldName;
        public readonly bool IsArray;

        public PlayerSoundSlot(string name, string fieldName, bool isArray)
        {
            Name = name;
            FieldName = fieldName;
            IsArray = isArray;
        }
    }

    // Every sound Movement.audioSource plays for the player, keyed by the
    // filename a skin's sfx/ folder can supply to override it (BigJump.wav,
    // SmallJump.wav, ...). Landing/footstep sounds route through a separate
    // shared Audio singleton used by non-player objects too, so they're out
    // of scope for a per-skin override.
    internal static class PlayerSoundSlots
    {
        public static readonly PlayerSoundSlot[] All =
        {
            new PlayerSoundSlot("BigJump", "bigJumpSFX", true),
            new PlayerSoundSlot("SmallJump", "smallJumpSFX", true),
            new PlayerSoundSlot("Dash", "dashSFX", true),
            new PlayerSoundSlot("AirJump", "airJumpSFX", true),
            new PlayerSoundSlot("Death", "deathSFX", true),
            new PlayerSoundSlot("MetalSlide", "MetalSlideSFX", false),
            new PlayerSoundSlot("GrassSlide", "GrassSlideSFX", false),
        };
    }
}
