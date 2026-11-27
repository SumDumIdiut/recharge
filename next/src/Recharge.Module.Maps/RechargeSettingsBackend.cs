using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Recharge.ModApi;
using Steamworks;
using TMPro;
using UnityEngine;
using UnityEngine.Audio;
using UnityEngine.InputSystem;
using UnityEngine.Localization.Settings;
using UnityEngine.UI;
using Object = UnityEngine.Object;

namespace Recharge.Module.Maps
{
    /// <summary>
    /// Bridge between the Recharge settings panel and the game's real backend.
    /// The game's SettingsScript keeps all of its UI controls and mixers in private
    /// [SerializeField] fields, so we sync those controls and then call its public
    /// handlers; every value is also written to the same PlayerPrefs key and saved
    /// explicitly. Keybinds are the exception: they live in Keybinds.txt and are
    /// saved through InputSystem.actions.SaveBindingOverridesAsJson().
    /// </summary>
    internal static class RechargeSettingsBackend
    {
        private static SettingsScript _settings;

        internal static SettingsScript Settings
        {
            get
            {
                if (_settings == null) _settings = Object.FindFirstObjectByType<SettingsScript>(FindObjectsInactive.Include);
                return _settings;
            }
        }

        private static T Field<T>(string name) => Settings != null ? Reflect.TryGetField<T>(Settings, name) : default(T);

        private static void Save() => PlayerPrefs.Save();

        private static int Clamp(int value, int count)
        {
            if (count <= 0) return 0;
            return value < 0 ? 0 : (value >= count ? count - 1 : value);
        }

        private static float ClampFloat(float value, float min, float max) =>
            value < min ? min : (value > max ? max : value);

        private static List<string> DropdownOptions(string fieldName, string[] fallback)
        {
            var dropdown = Field<TMP_Dropdown>(fieldName);
            if (dropdown != null && dropdown.options != null && dropdown.options.Count > 0)
            {
                var result = new List<string>(dropdown.options.Count);
                foreach (var option in dropdown.options)
                    result.Add(option != null && !string.IsNullOrEmpty(option.text) ? option.text : "?");
                return result;
            }
            return new List<string>(fallback);
        }

        internal static List<string> FullscreenOptions() =>
            DropdownOptions("fullscreenDropdown", new[] { "Fullscreen", "Windowed" });

        internal static List<string> FpsOptions() =>
            DropdownOptions("FPS", new[] { "30", "60", "120", "144", "240" });

        internal static List<string> LanguageOptions() =>
            DropdownOptions("languageDropdown", new[] { "English" });

        // A dropdown value setter invokes onValueChanged; game scenes wire the handlers
        // in the inspector (persistent listeners). Only invoke the handler ourselves
        // when there is no such listener, so we neither skip nor apply twice.
        private static void SyncDropdown(TMP_Dropdown dropdown, int index, Action<SettingsScript> handler)
        {
            if (dropdown == null) return;
            bool persistent = dropdown.onValueChanged.GetPersistentEventCount() > 0;
            if (dropdown.value != index) dropdown.value = index;
            if (!persistent && Settings != null) handler(Settings);
        }

        private static void SyncToggle(Toggle toggle, bool value, Action<SettingsScript> handler)
        {
            if (toggle == null) return;
            bool persistent = toggle.onValueChanged.GetPersistentEventCount() > 0;
            if (toggle.isOn != value) toggle.isOn = value;
            if (!persistent && Settings != null) handler(Settings);
        }

        private static void SyncSlider(Slider slider, float value, Action<SettingsScript> handler)
        {
            if (slider == null) return;
            bool persistent = slider.onValueChanged.GetPersistentEventCount() > 0;
            if (!Mathf.Approximately(slider.value, value)) slider.value = value;
            if (!persistent && Settings != null) handler(Settings);
        }

        // ---------------- Game ----------------

        internal static int ReadFullscreenIndex(IList<string> options)
        {
            int stored = PlayerPrefs.GetInt("Fullscreen", Screen.fullScreen ? 1 : 0);
            return Clamp(stored == 1 ? 0 : 1, options.Count);
        }

        internal static void ApplyFullscreen(int index, IList<string> options)
        {
            index = Clamp(index, options.Count);
            bool fullscreen = index == 0;
            int width = Screen.currentResolution.width;
            int height = Screen.currentResolution.height;
            // Mirror the game: drop to windowed first, then optionally go fullscreen.
            Screen.SetResolution((int)(width / 1.5f), (int)(height / 1.5f), false);
            if (fullscreen) Screen.SetResolution(width, height, true);
            PlayerPrefs.SetInt("Fullscreen", fullscreen ? 1 : 0);

            var dropdown = Field<TMP_Dropdown>("fullscreenDropdown");
            if (dropdown != null) SyncDropdown(dropdown, index, s => s.onFullscreenModeChanged());
            else Settings?.onFullscreenModeChanged();
            Save();
        }

        internal static int ReadFpsIndex(IList<string> options) =>
            Clamp(PlayerPrefs.HasKey("FPS") ? PlayerPrefs.GetInt("FPS") : 1, options.Count);

        internal static void ApplyFps(int index, IList<string> options)
        {
            index = Clamp(index, options.Count);
            PlayerPrefs.SetInt("FPS", index);
            string text = options[index];
            Application.targetFrameRate = int.TryParse(text, out int fps) ? fps : -1;

            var dropdown = Field<TMP_Dropdown>("FPS");
            if (dropdown != null) SyncDropdown(dropdown, index, s => s.onFPSChanged());
            Save();
        }

        internal static bool ReadVsync() =>
            PlayerPrefs.HasKey("Vsync") ? PlayerPrefs.GetInt("Vsync") == 1 : QualitySettings.vSyncCount > 0;

        internal static void ApplyVsync(bool on)
        {
            PlayerPrefs.SetInt("Vsync", on ? 1 : 0);
            QualitySettings.vSyncCount = on ? 1 : 0;

            var toggle = Field<Toggle>("VsyncMode");
            if (toggle != null) SyncToggle(toggle, on, s => s.onVsyncChanged());
            var fpsDropdown = Field<TMP_Dropdown>("FPS");
            if (fpsDropdown != null) fpsDropdown.gameObject.SetActive(!on);
            Save();
        }

        internal static int ReadLanguageIndex(IList<string> options) =>
            Clamp(PlayerPrefs.GetInt("Language", 0), options.Count);

        internal static void ApplyLanguage(int index, IList<string> options)
        {
            index = Clamp(index, options.Count);
            PlayerPrefs.SetInt("Language", index);
            try
            {
                var locales = LocalizationSettings.AvailableLocales != null
                    ? LocalizationSettings.AvailableLocales.Locales : null;
                if (locales != null && index < locales.Count)
                    LocalizationSettings.SelectedLocale = locales[index];
            }
            catch (Exception ex) { Debug.LogWarning("[RechargeSettings] locale apply: " + ex.Message); }

            var dropdown = Field<TMP_Dropdown>("languageDropdown");
            if (dropdown != null)
            {
                // The game's own handler writes the key and switches locale again; keep
                // it authoritative whenever it is wired up.
                bool persistent = dropdown.onValueChanged.GetPersistentEventCount() > 0;
                if (dropdown.value != index) dropdown.value = index;
                if (!persistent && Settings != null) Settings.onLanguageChanged();
            }
            Save();
        }

        // ---------------- Audio ----------------

        internal static float ReadSfxVolume() => ClampFloat(PlayerPrefs.GetFloat("SFXvolume", 1f), 0f, 1f);
        internal static float ReadMusicVolume() => ClampFloat(PlayerPrefs.GetFloat("MusicVolume", 1f), 0f, 1f);

        private static void SetMixerVolume(AudioMixer mixer, float value)
        {
            if (mixer == null) return;
            // Log10(0) is -infinity; clamp to inaudible instead.
            mixer.SetFloat("Volume", Mathf.Log10(Mathf.Max(value, 0.0001f)) * 20f);
        }

        /// <summary>The game writes both volume keys/mixers in one handler, so always pass both values.</summary>
        internal static void ApplyVolumes(float sfx, float music)
        {
            sfx = ClampFloat(sfx, 0f, 1f);
            music = ClampFloat(music, 0f, 1f);
            PlayerPrefs.SetFloat("SFXvolume", sfx);
            PlayerPrefs.SetFloat("MusicVolume", music);

            var effects = Field<Slider>("effectsSlider");
            var songs = Field<Slider>("musicSlider");
            if (effects != null && songs != null)
            {
                // updateLevels() reads both sliders and writes both mixers/keys.
                bool persistent = effects.onValueChanged.GetPersistentEventCount() > 0 ||
                                  songs.onValueChanged.GetPersistentEventCount() > 0;
                if (!Mathf.Approximately(effects.value, sfx)) effects.value = sfx;
                if (!Mathf.Approximately(songs.value, music)) songs.value = music;
                if (!persistent) Settings?.updateLevels();
            }

            SetMixerVolume(Field<AudioMixer>("effectsMixer"), sfx);
            SetMixerVolume(Field<AudioMixer>("musicMixer"), music);
            if (music <= 0.01f && SteamManager.Initialized)
            {
                SteamUserStats.SetAchievement("ACH_MUSIC_OFF");
                SteamUserStats.StoreStats();
            }
            Save();
        }

        // ---------------- Gameplay ----------------

        internal static bool ReadInputVis() => PlayerPrefs.GetInt("InputVis", 0) == 1;

        internal static void ApplyInputVis(bool on)
        {
            PlayerPrefs.SetInt("InputVis", on ? 1 : 0);
            var widget = Field<GameObject>("inputVisObject");
            if (widget != null) widget.SetActive(on);
            var toggle = Field<Toggle>("inputVis");
            if (toggle != null) SyncToggle(toggle, on, s => s.onInputVisChanged());
            Save();
        }

        internal static float ReadCloneSliderValue() =>
            ClampFloat(PlayerPrefs.GetFloat("CloneFadeArea", cloneShaderScript.cloneFadeScalar) * 3f, 0f, 3f);

        internal static void ApplyCloneRadius(float sliderValue)
        {
            float scalar = ClampFloat(sliderValue / 3f, 0f, 1f);
            PlayerPrefs.SetFloat("CloneFadeArea", scalar);
            cloneShaderScript.cloneFadeScalar = scalar;
            var slider = Field<Slider>("cloneFadeArea");
            if (slider != null) SyncSlider(slider, sliderValue, s => s.updateCloneHideArea());
            Save();
        }

        // ---------------- Controls ----------------

        private static readonly FieldInfo ActionField = Reflect.FieldOf<KeybindSetterItemScript>("action");
        private static readonly FieldInfo PartField = Reflect.FieldOf<KeybindSetterItemScript>("compositeActionPart");

        internal sealed class KeybindRow
        {
            internal string Label;
            internal InputAction Action;
            // Keyboard binding: index 0, or the composite part for Move rows.
            internal int BindingIndex;
            // Gamepad binding: index 1 for simple actions; the separate stick
            // binding for a composite Move action (-1 when there is none).
            internal int GamepadIndex;
            // The chat key is a PlayerPrefs key owned by MpInGameChatHud, not an InputAction.
            internal bool IsChat;
        }

        private static bool BindingHasGroup(InputBinding binding, string group)
        {
            if (string.IsNullOrEmpty(binding.groups)) return false;
            foreach (var part in binding.groups.Split(';'))
                if (string.Equals(part.Trim(), group, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static int FindGamepadBinding(InputAction action, bool composite)
        {
            if (action == null) return -1;
            if (!composite) return action.bindings.Count > 1 ? 1 : -1;

            // A 2DVector composite owns its keyboard parts at index 1..4; the
            // controller binding is a separate gamepad stick, not part index 1.
            for (int i = 0; i < action.bindings.Count; i++)
            {
                var binding = action.bindings[i];
                if (binding.isComposite || binding.isPartOfComposite) continue;
                if (BindingHasGroup(binding, "Gamepad")) return i;
            }
            for (int i = 0; i < action.bindings.Count; i++)
            {
                var path = action.bindings[i].path ?? "";
                if (path.IndexOf("Gamepad", StringComparison.OrdinalIgnoreCase) >= 0) return i;
            }
            return -1;
        }

        private static string LabelFor(string actionName, int part, bool composite)
        {
            if (composite && actionName == "Move")
            {
                switch (part)
                {
                    case 1: return "Move Up";
                    case 2: return "Move Down";
                    case 3: return "Move Left";
                    case 4: return "Move Right";
                }
            }
            switch (actionName)
            {
                case "Jump": return "Jump";
                case "Jump2": return "Jump 2";
                case "Dash": return "Dash";
                case "Dash2": return "Dash 2";
                case "SwapCurrencyDisplay": return "Swap HUD mode";
                case "QuickReset": return "Quick Restart";
                default: return actionName + (composite ? " " + part : "");
            }
        }

        /// <summary>Fallback for a composite Move row whose serialized compositeActionPart is
        /// missing/zero: recover the 1-based keyboard part from the visible row label.</summary>
        private static int MovePartFromLabel(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return 0;
            if (label.Equals("Move Up", StringComparison.OrdinalIgnoreCase) || label.Equals("Up", StringComparison.OrdinalIgnoreCase)) return 1;
            if (label.Equals("Move Down", StringComparison.OrdinalIgnoreCase) || label.Equals("Down", StringComparison.OrdinalIgnoreCase)) return 2;
            if (label.Equals("Move Left", StringComparison.OrdinalIgnoreCase) || label.Equals("Left", StringComparison.OrdinalIgnoreCase)) return 3;
            if (label.Equals("Move Right", StringComparison.OrdinalIgnoreCase) || label.Equals("Right", StringComparison.OrdinalIgnoreCase)) return 4;
            return 0;
        }

        internal static List<KeybindRow> GetKeybindRows()
        {
            var rows = new List<KeybindRow>();
            var items = Object.FindObjectsByType<KeybindSetterItemScript>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            foreach (var item in items)
            {
                if (item == null) continue;
                var reference = ActionField != null ? ActionField.GetValue(item) as InputActionReference : null;
                var action = reference != null ? reference.action : null;
                if (action == null) continue;
                string name = action.name;
                if (name != "Move" && name != "Jump" && name != "Jump2" && name != "Dash" &&
                    name != "Dash2" && name != "SwapCurrencyDisplay" && name != "QuickReset") continue;

                bool composite = action.bindings.Count > 0 && action.bindings[0].isComposite;
                int part = PartField != null ? (int)PartField.GetValue(item) : 0;

                var title = item.transform.Find("Title")?.GetComponent<TMP_Text>();
                string label = title != null && !string.IsNullOrWhiteSpace(title.text)
                    ? title.text.Trim() : LabelFor(name, part, composite);

                // Keyboard display must read the composite part (Move Up/Down/Left/Right),
                // never bindings[0] (the composite itself); simple actions use index 0.
                int bindingIndex = composite ? part : 0;
                if (composite && (bindingIndex < 1 || bindingIndex >= action.bindings.Count))
                    bindingIndex = MovePartFromLabel(label);
                if (bindingIndex < 0 || bindingIndex >= action.bindings.Count || (composite && bindingIndex == 0)) continue;
                int gamepadIndex = FindGamepadBinding(action, composite);

                bool duplicate = false;
                foreach (var existing in rows)
                    if (existing.Action == action && existing.BindingIndex == bindingIndex) { duplicate = true; break; }
                if (duplicate) continue;
                rows.Add(new KeybindRow
                {
                    Label = label, Action = action,
                    BindingIndex = bindingIndex, GamepadIndex = gamepadIndex
                });
            }

            // Stable order matching the vanilla Controls column.
            var order = new[]
            {
                "Move Up", "Move Down", "Move Left", "Move Right", "Jump", "Jump 2",
                "Dash", "Dash 2", "Swap HUD mode", "Quick Restart", "Up", "Down", "Left", "Right"
            };
            rows.Sort((a, b) =>
            {
                int ai = Array.IndexOf(order, a.Label), bi = Array.IndexOf(order, b.Label);
                if (ai < 0) ai = order.Length;
                if (bi < 0) bi = order.Length;
                return ai != bi ? ai.CompareTo(bi) : string.CompareOrdinal(a.Label, b.Label);
            });
            // The chat key lives on the Controls tab alongside the InputAction rows.
            rows.Insert(0, new KeybindRow { Label = "Chat key", IsChat = true });
            return rows;
        }

        internal static string ChatKeyDisplay()
        {
            string name = ChatKeyName();
            return string.IsNullOrWhiteSpace(name) ? "NONE" : name.ToUpperInvariant();
        }

        /// <summary>Both columns show plain key text from the correct binding's
        /// ToDisplayString() (W/A/S/D/R, ...). The controller column must NOT use
        /// ButtonToGlyphDict: its glyph chars are missing from the panel's TMP font
        /// and draw as empty squares. Anything unset/missing renders as the literal
        /// "NONE", never an empty box.</summary>
        internal static string BindingDisplay(KeybindRow row, bool gamepad = false)
        {
            if (row == null) return "NONE";
            if (row.IsChat) return gamepad ? "NONE" : ChatKeyDisplay();

            int index = gamepad ? row.GamepadIndex : row.BindingIndex;
            if (row.Action == null || index < 0 || index >= row.Action.bindings.Count) return "NONE";
            string display = row.Action.bindings[index].ToDisplayString();
            if (string.IsNullOrWhiteSpace(display)) return "NONE";
            return display.ToUpperInvariant();
        }

        /// <summary>Mirrors KeybindSetterItemScript.setNewKeyboardBind(): targets index 0,
        /// or the composite part for Move rows, and only accepts keyboard/mouse input.</summary>
        internal static bool BeginKeyboardRebind(KeybindRow row, Action onFinished) =>
            BeginRebind(row, false, onFinished);

        /// <summary>Mirrors KeybindSetterItemScript.setNewControllerBind(): targets binding
        /// index 1 (the gamepad stick for composites) and only accepts gamepad input.</summary>
        internal static bool BeginControllerRebind(KeybindRow row, Action onFinished) =>
            BeginRebind(row, true, onFinished);

        private static bool BeginRebind(KeybindRow row, bool gamepad, Action onFinished)
        {
            if (row == null || row.Action == null || row.IsChat) return false;
            int target = gamepad ? row.GamepadIndex : row.BindingIndex;
            if (target < 0 || target >= row.Action.bindings.Count) return false;

            var map = row.Action.actionMap;
            if (map != null) map.Disable();
            var operation = row.Action.PerformInteractiveRebinding()
                .WithBindingGroup(gamepad ? "Gamepad" : "Keyboard&Mouse")
                .WithTargetBinding(target)
                .OnComplete(op =>
                {
                    try { op.Dispose(); } catch (Exception) { }
                    if (map != null) map.Enable();
                    SaveKeybinds();
                    if (onFinished != null) onFinished();
                })
                .OnCancel(op =>
                {
                    try { op.Dispose(); } catch (Exception) { }
                    if (map != null) map.Enable();
                    if (onFinished != null) onFinished();
                })
                .Start();
            return operation != null;
        }

        private static void SaveKeybinds()
        {
            try
            {
                PlayerPrefs.Save();
                if (Singleton<PlayerinputBugWorkaround>.Instance != null)
                    Singleton<PlayerinputBugWorkaround>.Instance.refreshPlayerInput();
                string contents = UnityEngine.InputSystem.InputSystem.actions.SaveBindingOverridesAsJson();
                string dir = Application.persistentDataPath;
                string temp = dir + "/tempKeybinds.txt";
                string final = dir + "/Keybinds.txt";
                File.WriteAllText(temp, contents);
                if (File.Exists(final)) File.Delete(final);
                File.Move(temp, final);
            }
            catch (Exception ex) { Debug.LogWarning("[RechargeSettings] keybind save: " + ex); }
        }

        // ---------------- Recharge chat keybind (MpInGameChatHud lives in the Net module) ----------------

        private const string ChatKeyPrefsKey = "MpChatKeyBind";
        private static Type _chatHudType;
        private static bool _chatTypeSearched;

        private static Type ChatHudType()
        {
            if (!_chatTypeSearched)
            {
                _chatTypeSearched = true;
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    var type = assembly.GetType("MpInGameChatHud", false);
                    if (type != null) { _chatHudType = type; break; }
                }
            }
            return _chatHudType;
        }

        internal static string ChatKeyName()
        {
            var type = ChatHudType();
            if (type != null)
            {
                var property = type.GetProperty("ChatKeyName", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (property != null) return property.GetValue(null, null) as string;
            }
            return PlayerPrefs.GetString(ChatKeyPrefsKey, "Enter");
        }

        internal static bool IsChatRebinding()
        {
            var type = ChatHudType();
            var property = type != null
                ? type.GetProperty("IsRebinding", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                : null;
            return property != null && property.GetValue(null, null) is bool value && value;
        }

        internal static void BeginChatRebind()
        {
            var type = ChatHudType();
            var method = type != null
                ? type.GetMethod("BeginRebind", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                : null;
            if (method != null) method.Invoke(null, null);
        }
    }
}
