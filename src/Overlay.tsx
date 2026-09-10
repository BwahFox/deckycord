import { ButtonItem, DialogButton, Focusable, GamepadButton, GamepadEvent, Navigation, PanelSection, PanelSectionRow, TextField, useQuickAccessVisible } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaChevronLeft, FaCog, FaComments, FaDesktop, FaDiscord, FaHashtag, FaHeadphones, FaMicrophone, FaMicrophoneSlash, FaPaperPlane, FaPhone, FaPhoneSlash, FaVolumeUp, FaExternalLinkAlt, FaUserFriends, FaUserPlus } from "react-icons/fa";
import { api, Friend, FriendRequest, Status, VoiceUser } from "./api";
import { Avatar, Badge, VoiceUserList, globalCss } from "./components";
import { bus } from "./bus";
import { useChat, HOME } from "./useChat";
import { ensureQamCss, setQamExpanded } from "./qam";
import { AudioSection, IncomingCallsSection, MaintenanceSection } from "./panel";

/** Steam's Friends-tab palette (measured on the HTPC), so the overlay reads as part of Steam. */
const steam = {
  bg: "#0e141b",
  text: "#dfe3e6",
  dim: "rgb(122,122,122)",
  dim2: "rgb(139,146,154)",
  white: "#fff",
  line: "rgba(255,255,255,0.08)",
  hover: "rgba(255,255,255,0.06)",
  selected: "rgba(255,255,255,0.10)",
  input: "rgba(255,255,255,0.05)",
  green: "#8fc8a0",
  red: "#e35252",
  accent: "#1a9fff",
};

const TABS = ["dms", "friends", "servers", "voice", "settings"] as const;
type Tab = (typeof TABS)[number];
const TAB_ICON: Record<Tab, React.ReactNode> = { dms: <FaComments size={22} />, friends: <FaUserFriends size={22} />, servers: <FaDiscord size={22} />, voice: <FaHeadphones size={22} />, settings: <FaCog size={22} /> };
const TAB_TITLE: Record<Tab, string> = { dms: "Direct Messages", friends: "Friends", servers: "Servers", voice: "Voice", settings: "Settings" };
const STATUS_COLOR: Record<string, string> = { online: "#57f287", idle: "#faa61a", dnd: "#ed4245", offline: "#5d6166" };
const STATUS_ORDER: Record<string, number> = { online: 0, idle: 1, dnd: 2, offline: 3 };

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "10px 14px 4px", fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "rgb(139,146,154)" }}>{children}</div>;
}

function Hint({ label }: { label: string }) {
  return <span style={{ background: "#fff", color: "#000", borderRadius: "5px 5px 8px 8px", fontSize: 10, fontWeight: 800, padding: "3px 6px", lineHeight: 1 }}>{label}</span>;
}

function fmtDay(ts: string | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toUpperCase();
}
function fmtTime(ts: string | null): string {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

/** A Steam-Friends-styled focusable row. */
function SRow({ children, onActivate, onSecondary, selected, tall, onOKActionDescription, onSecondaryActionDescription, innerRef }: {
  children: React.ReactNode; onActivate?: () => void; onSecondary?: () => void; selected?: boolean; tall?: boolean;
  onOKActionDescription?: React.ReactNode; onSecondaryActionDescription?: React.ReactNode; innerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <Focusable
      ref={innerRef as any}
      onActivate={onActivate}
      onSecondaryButton={onSecondary}
      onOKActionDescription={onOKActionDescription}
      onSecondaryActionDescription={onSecondaryActionDescription}
      focusClassName="deckycord-focus"
      className={selected ? "deckycord-selected" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: tall ? "4px 14px" : "2px 14px", minHeight: tall ? 44 : 39, background: selected ? steam.selected : "transparent", color: steam.text, fontSize: 16, boxSizing: "border-box" }}
    >
      {children}
    </Focusable>
  );
}

export function Overlay({ status, refresh }: { status: Status; refresh: () => Promise<void> }) {
  const c = useChat();
  const {
    guilds, dms, guildId, channels, channelId, channelName, messages, loadingMsgs, voice, setVoice, dmCall,
    draft, setDraft, error, hasMore, bottomRef, loadOlder, send, selectGuild, openText,
    shareBusy, toggleShare, callBusy, startCall, joinVoice,
  } = c;
  const [tab, setTab] = useState<Tab>(() => (TABS as readonly string[]).includes(bus.pendingTab ?? "") ? (bus.pendingTab as Tab) : "dms");
  // Friends tab data
  const [requests, setRequests] = useState<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>({ incoming: [], outgoing: [] });
  const [friends, setFriends] = useState<Friend[]>([]);
  const [addName, setAddName] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const loadFriends = async () => {
    try {
      const [r, f] = await Promise.all([api.friendRequests(), api.friends()]);
      setRequests(r);
      setFriends([...f].sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || a.name.localeCompare(b.name)));
    } catch {}
  };
  useEffect(() => {
    if (tab === "friends") loadFriends();
  }, [tab]);
  useEffect(() => bus.on((ev) => {
    if (ev.type === "friends" || ev.type === "friend_request") loadFriends();
    else if (ev.type === "open_tab" && (TABS as readonly string[]).includes(ev.tab)) { bus.pendingTab = null; setTab(ev.tab as Tab); }
  }), []);
  useEffect(() => { bus.pendingTab = null; }, []);
  const acceptFriend = async (u: FriendRequest) => { try { await api.acceptFriend(u.id); } catch {} loadFriends(); };
  const declineFriend = async (u: FriendRequest) => { try { await api.declineFriend(u.id); } catch {} loadFriends(); };
  const sendFriendRequest = async () => {
    const name = addName.trim();
    if (!name || addBusy) return;
    setAddBusy(true);
    try {
      const r = await api.sendFriendRequest(name);
      setAddMsg(r.ok ? `Friend request sent to ${name}` : `Could not send: ${r.error ?? "unknown error"}`);
      if (r.ok) setAddName("");
    } catch (e) {
      setAddMsg(String(e));
    } finally {
      setAddBusy(false);
      loadFriends();
    }
  };
  const messageFriend = async (f: Friend) => {
    try {
      const cid = await api.openDm(f.id);
      if (cid) { selectGuild(HOME); openText(cid, f.name); }
    } catch {}
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const focusablesIn = (root: HTMLElement | null): HTMLElement[] =>
    root ? Array.from(root.querySelectorAll<HTMLElement>('[tabindex="0"], button, input')).filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled) : [];
  const visible = useQuickAccessVisible();

  // Widen the Quick Access menu while our tab is the one showing; give it back otherwise.
  useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (doc) ensureQamCss(doc);
    const tick = () => {
      const el = rootRef.current;
      const on = visible && !!el && el.getBoundingClientRect().width > 0;
      setQamExpanded(on);
    };
    tick();
    const t = setInterval(tick, 400);
    return () => {
      clearInterval(t);
      setQamExpanded(false);
    };
  }, [visible]);

  // Opening a DM / channel from a notification lands on the matching tab.
  useEffect(() => {
    if (!channelId) return;
    setTab(guildId === HOME ? "dms" : "servers");
  }, [channelId, guildId]);

  const cycleTab = (dir: 1 | -1) => {
    const i = TABS.indexOf(tab);
    setTab(TABS[(i + dir + TABS.length) % TABS.length]);
    setTimeout(() => listRef.current?.querySelector<HTMLElement>('[tabindex="0"], button, input')?.focus(), 50);
  };
  const onButtonDown = (evt: GamepadEvent) => {
    const b = evt.detail.button;
    if (evt.detail.is_repeat) return;
    if (b === GamepadButton.BUMPER_LEFT) { cycleTab(-1); evt.stopPropagation(); }
    else if (b === GamepadButton.BUMPER_RIGHT) { cycleTab(1); evt.stopPropagation(); }
    else if (b === GamepadButton.TRIGGER_LEFT) {
      // Top of the conversation: the Call button when there is one, else the header itself.
      const target = focusablesIn(headerRef.current)[0] ?? focusablesIn(chatRef.current)[0];
      if (target) { target.focus(); evt.stopPropagation(); }
    } else if (b === GamepadButton.TRIGGER_RIGHT) {
      // Newest message, else the last control (the send button).
      const els = focusablesIn(chatRef.current);
      const msgs = els.filter((el) => typeof el.className === "string" && el.className.includes("deckycord-msg"));
      const target = msgs.length ? msgs[msgs.length - 1] : els[els.length - 1];
      if (target) { target.focus(); evt.stopPropagation(); }
    }
  };

  /** Streams need the full page; the overlay just hands over. */
  const watchOnPage = (u: VoiceUser) => {
    bus.pendingWatch = { ownerId: u.id, name: u.name };
    Navigation.Navigate("/deckycord");
    Navigation.CloseSideMenus();
  };

  const v = voice;
  const currentGuild = guilds.find((g) => g.id === guildId);
  const headerSub = channelId ? (guildId === HOME ? (dmCall?.active ? "Call in progress" : "Direct message") : currentGuild?.name ?? "Server") : "";

  return (
    <Focusable
      ref={rootRef as any}
      flow-children="row"
      onButtonDown={onButtonDown}
      actionDescriptionMap={{ [GamepadButton.BUMPER_LEFT]: "Prev tab", [GamepadButton.BUMPER_RIGHT]: "Next tab", [GamepadButton.TRIGGER_LEFT]: guildId === HOME && channelId ? "Call" : "Top", [GamepadButton.TRIGGER_RIGHT]: "Newest" }}
      style={{ display: "flex", position: "absolute", top: 56, left: 0, right: 0, bottom: 0, color: steam.text, fontSize: 16, overflow: "hidden", boxSizing: "border-box" }}
    >
      <style>{globalCss}</style>

      {/* Left pane: tab strip + list, like Steam's friends list */}
      <Focusable flow-children="column" style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${steam.line}`, minHeight: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: steam.white, padding: "0 16px 6px", lineHeight: "22px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{TAB_TITLE[tab]}</div>
        <Focusable flow-children="row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px 8px" }}>
          <Hint label="L1" />
          {TABS.map((t) => (
            <Focusable key={t} focusClassName="deckycord-focus" onActivate={() => setTab(t)} onOKActionDescription={TAB_TITLE[t]} style={{ color: t === tab ? steam.white : steam.dim2, padding: 4, borderRadius: 4, display: "flex" }}>
              {TAB_ICON[t]}
            </Focusable>
          ))}
          <Hint label="R1" />
        </Focusable>

        <Focusable ref={listRef as any} flow-children="column" className="deckycord-scroll" style={{ flex: 1, minHeight: 0, paddingBottom: 8 }}>
          {tab === "dms" && dms.map((d) => (
            <SRow key={d.id} onActivate={() => { selectGuild(HOME); openText(d.id, d.name); }} selected={channelId === d.id} onOKActionDescription="Open">
              <Avatar url={d.icon} name={d.name} size={36} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: d.unread ? steam.white : steam.text, fontWeight: d.unread ? 700 : 400 }}>{d.name}</span>
              {d.call && <FaPhone style={{ color: steam.green, marginLeft: "auto", flexShrink: 0 }} />}
              <Badge n={d.mentions} />
            </SRow>
          ))}
          {tab === "dms" && dms.length === 0 && <div style={{ padding: "8px 16px", color: steam.dim }}>No conversations yet.</div>}

          {tab === "friends" && (
            <>
              {requests.incoming.length > 0 && <SectionTitle>Incoming requests · {requests.incoming.length}</SectionTitle>}
              {requests.incoming.map((u) => (
                <SRow key={u.id} tall onActivate={() => acceptFriend(u)} onSecondary={() => declineFriend(u)} onOKActionDescription="Accept" onSecondaryActionDescription="Decline">
                  <Avatar url={u.avatar} name={u.name} size={36} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ color: steam.white, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</div>
                    <div style={{ color: steam.dim, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>@{u.username} · A accept · X decline</div>
                  </div>
                </SRow>
              ))}
              {requests.outgoing.length > 0 && <SectionTitle>Sent · {requests.outgoing.length}</SectionTitle>}
              {requests.outgoing.map((u) => (
                <SRow key={u.id} tall onSecondary={() => declineFriend(u)} onActivate={() => {}} onOKActionDescription="Pending" onSecondaryActionDescription="Cancel request">
                  <Avatar url={u.avatar} name={u.name} size={36} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</div>
                    <div style={{ color: steam.dim, fontSize: 13 }}>Pending · X to cancel</div>
                  </div>
                </SRow>
              ))}
              <SectionTitle>Add friend</SectionTitle>
              <Focusable flow-children="row" style={{ display: "flex", gap: 6, alignItems: "center", padding: "0 14px 4px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TextField value={addName} onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendFriendRequest(); } }} style={{ width: "100%" }} description={undefined} />
                </div>
                <DialogButton style={{ minWidth: 0, width: 48, padding: "10px 0" }} disabled={!addName.trim() || addBusy} onClick={sendFriendRequest} onOKActionDescription="Send request">
                  <FaUserPlus />
                </DialogButton>
              </Focusable>
              {addMsg && <div style={{ padding: "0 14px 6px", color: addMsg.startsWith("Could") ? steam.red : steam.green, fontSize: 13 }}>{addMsg}</div>}
              <SectionTitle>Friends · {friends.length}</SectionTitle>
              {friends.map((f) => (
                <SRow key={f.id} onActivate={() => messageFriend(f)} onOKActionDescription="Message">
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <Avatar url={f.avatar} name={f.name} size={36} />
                    <span style={{ position: "absolute", right: -1, bottom: -1, width: 12, height: 12, borderRadius: "50%", background: STATUS_COLOR[f.status] ?? STATUS_COLOR.offline, border: `2px solid ${steam.bg}` }} />
                  </div>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: f.status === "offline" ? steam.dim : steam.text }}>{f.name}</span>
                </SRow>
              ))}
            </>
          )}

          {tab === "servers" && guildId === HOME && guilds.map((g) => (
            <SRow key={g.id} onActivate={() => selectGuild(g.id)} onOKActionDescription="Open">
              {g.icon ? <img src={g.icon} style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0 }} /> : <Avatar url={null} name={g.name} size={36} />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
            </SRow>
          ))}
          {tab === "servers" && guildId !== HOME && (
            <>
              <SRow onActivate={() => selectGuild(HOME)} onOKActionDescription="All servers">
                <FaChevronLeft style={{ color: steam.dim2, flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: steam.white, fontWeight: 700 }}>{currentGuild?.name ?? "Server"}</span>
              </SRow>
              {channels?.voice.map((vc) => (
                <div key={vc.id}>
                  <SRow onActivate={() => joinVoice(vc.id)} onSecondary={() => openText(vc.id, vc.name)} selected={v?.channelId === vc.id || channelId === vc.id} onOKActionDescription={v?.channelId === vc.id ? "Leave voice" : "Join voice"} onSecondaryActionDescription="Text chat">
                    <FaVolumeUp style={{ color: steam.dim2, flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{vc.name}</span>
                    {vc.users.length > 0 && <span style={{ marginLeft: "auto", fontSize: 13, color: steam.dim }}>{vc.users.length}</span>}
                  </SRow>
                  <div style={{ padding: "0 14px 0 26px" }}>
                    <VoiceUserList users={vc.users} compact plain onWatch={v?.channelId === vc.id ? watchOnPage : undefined} watchingId={v?.watching?.ownerId} />
                  </div>
                </div>
              ))}
              {channels?.text.map((tc) => (
                <SRow key={tc.id} onActivate={() => openText(tc.id, "#" + tc.name)} selected={channelId === tc.id} onOKActionDescription="Open">
                  <FaHashtag style={{ color: steam.dim2, flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tc.unread ? steam.white : steam.text, fontWeight: tc.unread ? 700 : 400 }}>{tc.name}</span>
                  <Badge n={tc.mentions} />
                </SRow>
              ))}
              {!channels && <div style={{ padding: "8px 16px", color: steam.dim }}>Loading…</div>}
            </>
          )}

          {tab === "voice" && (
            <div style={{ padding: "0 4px" }}>
              <IncomingCallsSection status={status} refresh={refresh} />
              {v && v.channelId ? (
                <>
                  <div style={{ padding: "4px 12px 0", color: steam.green, fontWeight: 700 }}>
                    {(v.isCall ? (v.ringing ? "Calling…" : "Call connected") : "Voice connected") + (v.streaming ? " · Live" : v.video ? " · Camera" : "")}
                  </div>
                  <div style={{ padding: "0 12px 8px", color: steam.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {v.guildName ? `${v.channelName} / ${v.guildName}` : v.channelName}
                  </div>
                  <Focusable flow-children="row" style={{ display: "flex", gap: 6, padding: "0 12px" }}>
                    <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1, background: v.mute ? steam.red : undefined }} onClick={() => api.toggleMute().then(setVoice)} onOKActionDescription={v.mute ? "Unmute" : "Mute"}>
                      {v.mute ? <FaMicrophoneSlash /> : <FaMicrophone />}
                    </DialogButton>
                    <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1, background: v.deaf ? steam.red : undefined }} onClick={() => api.toggleDeaf().then(setVoice)} onOKActionDescription={v.deaf ? "Undeafen" : "Deafen"}>
                      <FaHeadphones />
                    </DialogButton>
                    <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1, background: v.video || v.streaming ? steam.green : undefined }} disabled={shareBusy} onClick={toggleShare} onOKActionDescription={v.video || v.streaming ? "Stop sharing" : shareBusy ? "Starting…" : "Share screen"}>
                      <FaDesktop />
                    </DialogButton>
                    <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1 }} onClick={() => api.leaveVoice().then(() => setTimeout(() => api.voice().then(setVoice), 500))} onOKActionDescription={v.isCall ? "Hang up" : "Disconnect"}>
                      <FaPhoneSlash />
                    </DialogButton>
                  </Focusable>
                  <div style={{ padding: "8px 12px" }}>
                    <VoiceUserList users={v.users.filter((u) => u.id !== bus.selfId)} compact plain onWatch={watchOnPage} watchingId={v.watching?.ownerId} />
                  </div>
                </>
              ) : (
                <div style={{ padding: "4px 12px", color: steam.dim }}>Not in voice. Join a voice channel from a server, or call a friend from a direct message.</div>
              )}
            </div>
          )}

          {tab === "settings" && (
            <>
              <PanelSection title={status.user ? `Signed in as ${status.user.name}` : "Discord"}>
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={() => { Navigation.Navigate("/deckycord"); Navigation.CloseSideMenus(); }} description="Full-screen chat with stream viewing">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><FaExternalLinkAlt /> Open full page</span>
                  </ButtonItem>
                </PanelSectionRow>
              </PanelSection>
              <AudioSection />
              <MaintenanceSection refresh={refresh} />
            </>
          )}
        </Focusable>
      </Focusable>

      {/* Right pane: the conversation */}
      <Focusable ref={chatRef as any} flow-children="column" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {channelId ? (
          <>
            <Focusable ref={headerRef as any} flow-children="row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 16px 10px" }}>
              {guildId === HOME ? <Avatar url={dms.find((d) => d.id === channelId)?.icon ?? null} name={channelName} size={40} /> : <div style={{ width: 40, height: 40, borderRadius: 8, background: steam.input, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><FaHashtag /></div>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: steam.white, fontSize: 18, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{channelName.replace(/^#/, "")}</div>
                <div style={{ color: steam.dim, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{error ?? headerSub}</div>
              </div>
              {guildId === HOME && v?.channelId !== channelId && (
                <DialogButton style={{ minWidth: 0, width: 48, padding: "6px 0", flexShrink: 0, background: dmCall?.active ? steam.green : undefined }} disabled={callBusy} onClick={startCall} onOKActionDescription={callBusy ? "Calling…" : dmCall?.active ? "Join call" : "Start call"}>
                  <FaPhone />
                </DialogButton>
              )}
            </Focusable>
            {dmCall?.active && (
              <div style={{ margin: "0 16px 6px", padding: "6px 10px", background: "rgba(143,200,160,0.10)", borderRadius: 3, color: steam.green, fontSize: 14 }}>
                {dmCall.inCall ? (dmCall.ringing ? "Calling…" : "In this call") : "Call in progress"}
                <VoiceUserList users={dmCall.users} compact plain onWatch={dmCall.inCall ? watchOnPage : undefined} />
              </div>
            )}
            <Focusable flow-children="column" className="deckycord-scroll" style={{ flex: 1, minHeight: 0, padding: "0 16px" }}>
              {loadingMsgs && <div style={{ padding: 16, color: steam.dim }}>Loading…</div>}
              {!loadingMsgs && messages.length > 0 && (
                <div style={{ padding: "4px 0", color: steam.dim, fontSize: 12, textAlign: "center" }}>{hasMore ? "Move up past the first message for older history" : "Beginning of conversation"}</div>
              )}
              {!loadingMsgs && messages.length === 0 && <div style={{ padding: 16, color: steam.dim, textAlign: "center" }}>No messages yet.</div>}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = !prev || (m.timestamp && prev.timestamp && new Date(m.timestamp).toDateString() !== new Date(prev.timestamp).toDateString());
                const grouped = !newDay && prev && prev.author?.id === m.author?.id && m.timestamp && prev.timestamp && new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() < 5 * 60 * 1000;
                const mine = !!bus.selfId && m.author?.id === bus.selfId;
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 10px", color: steam.dim2, fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>
                        <div style={{ flex: 1, height: 1, background: steam.line }} />
                        {fmtDay(m.timestamp)}
                        <div style={{ flex: 1, height: 1, background: steam.line }} />
                      </div>
                    )}
                    <Focusable
                      className="deckycord-msg"
                      focusClassName="deckycord-focus"
                      onActivate={() => {}}
                      onGamepadFocus={i === 0 ? () => loadOlder() : undefined}
                      onOKActionDescription={m.author?.name ?? ""}
                      style={{ display: "flex", gap: 10, padding: grouped ? "1px 6px" : "6px 6px 1px", marginTop: grouped ? 0 : 4, borderRadius: 3 }}
                    >
                      {grouped ? <div style={{ width: 32, flexShrink: 0 }} /> : <Avatar url={m.author?.avatar ?? null} name={m.author?.name ?? "?"} size={32} />}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {!grouped && (
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <span style={{ color: mine ? steam.accent : steam.white, fontSize: 15 }}>{m.author?.name ?? "Unknown"}</span>
                            <span style={{ fontSize: 12, color: steam.dim }}>{fmtTime(m.timestamp)}</span>
                          </div>
                        )}
                        {m.content && <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.35, fontSize: 15, color: steam.text }}>{m.content}</div>}
                        {m.attachments.map((a) =>
                          a.type && a.type.startsWith("image/") ? (
                            <img key={a.url} src={a.url} style={{ maxWidth: 300, maxHeight: 220, borderRadius: 4, marginTop: 4, display: "block" }} />
                          ) : (
                            <div key={a.url} style={{ color: steam.accent, fontSize: 13 }}>📎 {a.name}</div>
                          )
                        )}
                        {m.stickers.length > 0 && <div style={{ color: steam.dim, fontSize: 13 }}>Sticker: {m.stickers.join(", ")}</div>}
                        {m.embeds > 0 && !m.content && <div style={{ color: steam.dim, fontSize: 13 }}>[embed]</div>}
                      </div>
                    </Focusable>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </Focusable>
            <Focusable flow-children="row" style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 16px 4px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextField
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  style={{ width: "100%" }}
                  description={undefined}
                />
              </div>
              <DialogButton style={{ minWidth: 0, width: 52, padding: "10px 0" }} onClick={send} disabled={!draft.trim()} onOKActionDescription="Send">
                <FaPaperPlane />
              </DialogButton>
            </Focusable>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: steam.dim, textAlign: "center", padding: 24 }}>
            {tab === "voice" || tab === "settings" ? "" : tab === "friends" ? "Select a friend to message them" : "Pick a conversation on the left"}
          </div>
        )}
      </Focusable>
    </Focusable>
  );
}
