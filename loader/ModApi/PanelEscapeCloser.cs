using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    // Attached to every panel AddPanelRow creates, so Escape closes it the
    // same way clicking its own Back/Close button would - individual mods
    // don't need to wire that up themselves. Public so a mod with its own
    // hand-rolled panel (not built via AddPanelRow) can attach one too.
    public class PanelEscapeCloser : MonoBehaviour
    {
        public Button CloseButton;

        // A mod with its own nested navigation (a sub-page within the
        // panel) can set this to back out one level first instead of the
        // whole panel closing - return true to mean "handled, don't close".
        public System.Func<bool> ConsumeEscapeFirst;

        private void Update()
        {
            var kb = Keyboard.current;
            if (kb == null || !kb.escapeKey.wasPressedThisFrame) return;
            if (ConsumeEscapeFirst != null && ConsumeEscapeFirst()) return;
            if (CloseButton != null) CloseButton.onClick.Invoke();
        }
    }
}
