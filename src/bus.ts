import { DcEvent } from "./api";

/** Backend events plus a few UI-local ones. */
export type BusEvent = DcEvent | { type: "open_channel"; channelId: string } | { type: "open_tab"; tab: string };
type Handler = (ev: BusEvent) => void;

class Bus {
  private handlers = new Set<Handler>();
  currentChannel: string | null = null;
  selfId: string | null = null;
  /** Channel to open when the chat page next mounts (set by a notification click). */
  pendingChannel: string | null = null;
  /** Stream owner to start watching when the chat page next mounts (set from the panel/toast). */
  pendingWatch: { ownerId: string; name: string } | null = null;

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  /** Show a channel in whichever chat UI is (or gets) mounted. */
  openChannel(channelId: string) {
    this.pendingChannel = channelId;
    this.emit({ type: "open_channel", channelId });
  }
  /** Tab the overlay should show when it next renders (set together with an open_tab event). */
  pendingTab: string | null = null;
  openTab(tab: string) {
    this.pendingTab = tab;
    this.emit({ type: "open_tab", tab });
  }
  emit(ev: BusEvent) {
    for (const h of Array.from(this.handlers)) {
      try {
        h(ev);
      } catch (e) {
        console.error("deckycord bus handler", e);
      }
    }
  }
}

export const bus = new Bus();
