import { ButtonItem, PanelSection, PanelSectionRow, Navigation, staticClasses } from "@decky/ui";
import { addEventListener, removeEventListener, definePlugin, routerHook, toaster } from "@decky/api";
import { FaDiscord, FaPhone, FaDesktop } from "react-icons/fa";
import { api, DcEvent } from "./api";
import { ChatPage } from "./ChatPage";
import { bus } from "./bus";
import { useStatus, LoginSection, answerCall } from "./panel";
import { Overlay } from "./Overlay";
import { openOverlay } from "./qam";

function QuickPanel() {
  const [status, refresh] = useStatus(5000);

  if (!status) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div>Connecting…</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (status.suspended) {
    return (
      <PanelSection title="Discord suspended">
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Vesktop and capture are stopped so the game has the whole CPU. Notifications and voice are off.</div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => { await api.resume(); refresh(); }}>
            Resume Discord
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (!status.running || !status.cdp) {
    return (
      <PanelSection title="Discord backend">
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {status.running ? "Vesktop is starting up…" : "Vesktop is not running."}
            {status.error ? ` (${status.error})` : ""}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => { await api.startBackend(); refresh(); }}>
            Start Discord
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (!status.loggedIn) {
    return (
      <>
        <LoginSection />
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={async () => { await api.restartBackend(); refresh(); }}>
              Restart Discord backend
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      </>
    );
  }

  return <Overlay status={status} refresh={refresh} />;
}

export default definePlugin(() => {
  routerHook.addRoute("/deckycord", ChatPage, { exact: true });
  // Debug hook: lets CDP scripts drive the UI (e.g. set pendingWatch) from SharedJSContext.
  (window as any).__deckycordBus = bus;

  const listener = addEventListener<[ev: DcEvent]>("dc_event", (ev) => {
    bus.emit(ev);
    if (ev.type === "message" && ev.notify && bus.currentChannel !== ev.channelId) {
      toaster.toast({
        title: ev.where ? `${ev.author} in ${ev.where}` : ev.author,
        body: ev.content || "New message",
        logo: ev.avatar ? <img src={ev.avatar} style={{ width: 40, height: 40, borderRadius: "50%" }} /> : <FaDiscord size={32} />,
        duration: 6000,
        onClick: () => openOverlay(ev.channelId),
      });
    } else if (ev.type === "call" && ev.ringing) {
      toaster.toast({
        title: ev.group ? `Incoming group call · ${ev.name}` : `${ev.name} is calling`,
        body: "Click to answer",
        logo: ev.icon ? <img src={ev.icon} style={{ width: 40, height: 40, borderRadius: "50%" }} /> : <FaPhone size={28} />,
        duration: 20000,
        onClick: () => answerCall(ev.channelId),
      });
    } else if (ev.type === "stream" && ev.live) {
      toaster.toast({
        title: `${ev.name} went live`,
        body: "Click to watch",
        logo: ev.avatar ? <img src={ev.avatar} style={{ width: 40, height: 40, borderRadius: "50%" }} /> : <FaDesktop size={28} />,
        duration: 8000,
        onClick: () => {
          bus.pendingWatch = { ownerId: ev.ownerId, name: ev.name };
          Navigation.Navigate("/deckycord");
          Navigation.CloseSideMenus();
        },
      });
    } else if (ev.type === "friend_request") {
      toaster.toast({
        title: `${ev.name} sent you a friend request`,
        body: ev.username !== ev.name ? `@${ev.username} · Click to respond` : "Click to respond",
        logo: ev.avatar ? <img src={ev.avatar} style={{ width: 40, height: 40, borderRadius: "50%" }} /> : <FaDiscord size={32} />,
        duration: 10000,
        onClick: () => openOverlay(undefined, "friends"),
      });
    } else if (ev.type === "share_paused") {
      toaster.toast({ title: "Stream paused", body: `${ev.name || "A game"} is launching; the stream restarts in 20 s`, logo: <FaDesktop size={28} />, duration: 6000 });
    } else if (ev.type === "share_resumed") {
      toaster.toast({ title: ev.ok ? "Stream restarted" : "Stream did not restart", body: ev.ok ? "Viewers need to open it again" : ev.error ?? "unknown error", logo: <FaDesktop size={28} />, duration: 6000 });
    } else if (ev.type === "voice_member") {
      const parts: string[] = [];
      if (ev.joined.length) parts.push(`${ev.joined.join(", ")} joined`);
      if (ev.left.length) parts.push(`${ev.left.join(", ")} left`);
      toaster.toast({ title: "Voice channel", body: parts.join(" · "), logo: <FaDiscord size={32} />, duration: 4000 });
    }
  });

  // Pause the stream while a game launches (see main.py game_launched).
  const sc = (window as any).SteamClient;
  let lifetime: { unregister: () => void } | null = null;
  try {
    lifetime = sc?.GameSessions?.RegisterForAppLifetimeNotifications?.((n: { unAppID: number; bRunning: boolean }) => {
      if (!n?.bRunning) return;
      let name = "";
      try {
        name = (window as any).appStore?.GetAppOverviewByAppID?.(n.unAppID)?.display_name ?? "";
      } catch {}
      api.gameLaunched(n.unAppID, name).catch(() => {});
    }) ?? null;
  } catch (e) {
    console.warn("deckycord: app lifetime hook unavailable", e);
  }

  return {
    name: "Deckycord",
    titleView: <div className={staticClasses.Title}>Deckycord</div>,
    content: <QuickPanel />,
    icon: <FaDiscord />,
    onDismount() {
      removeEventListener("dc_event", listener);
      routerHook.removeRoute("/deckycord");
      lifetime?.unregister();
    },
  };
});
