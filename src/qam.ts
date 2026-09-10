import { Navigation, QuickAccessTab, findModuleExport } from "@decky/ui";
import { bus } from "./bus";

/**
 * Steam's Quick Access menu is one fixed-size browser window that Steam crops to a narrow column,
 * except while its Friends tab is "expanded" to the two-pane friends-and-chat layout. That state
 * lives in Steam's friends store (`qamFriendsExpanded`) and any tab can flip it; the setter posts
 * "QamFriendsExpanded" / "QamFriendsHidden" to the main window, which widens the crop. Decky's tab
 * additionally caps its content at 300px (`.tab_undefined{max-width:300px}`), lifted by CSS below.
 */
let store: any = null;
let searched = false;
function qamStore(): any {
  if (!searched) {
    searched = true;
    try {
      store = findModuleExport((e: any) => {
        try {
          return !!e && typeof e === "object" && "qamFriendsExpanded" in e && typeof e.SetQAMFriendsChatExpanded === "function";
        } catch {
          return false;
        }
      });
    } catch (e) {
      console.warn("deckycord: friends store not found", e);
    }
  }
  return store;
}

let lastOn = false;
export function setQamExpanded(on: boolean) {
  const s = qamStore();
  if (!s) return;
  // Re-assert "on" every call (Steam's own Friends tab may have reset it); only send "off" once.
  if (!on && !lastOn) return;
  lastOn = on;
  try {
    s.SetQAMFriendsChatExpanded(on);
  } catch (e) {
    console.warn("deckycord: SetQAMFriendsChatExpanded", e);
  }
}

export function qamExpandSupported(): boolean {
  return !!qamStore();
}

const CSS_ID = "deckycord-qam";
/** Let Decky's tab grow to the Friends-tab width while the menu is expanded. */
export function ensureQamCss(doc: Document) {
  if (doc.getElementById(CSS_ID)) return;
  const st = doc.createElement("style");
  st.id = CSS_ID;
  st.textContent = `.QAMFriendExpanded .tab_undefined { max-width: unset !important; }`;
  (doc.head ?? doc.documentElement).appendChild(st);
}

/** Open the Quick Access menu straight to Deckycord, optionally on a channel. */
export function openOverlay(channelId?: string, tab?: string) {
  if (channelId) bus.openChannel(channelId);
  if (tab) bus.openTab(tab);
  try {
    (window as any).DeckyPluginLoader?.deckyState?.setActivePlugin?.("Deckycord");
  } catch {}
  Navigation.OpenQuickAccessMenu(QuickAccessTab.Decky);
}
