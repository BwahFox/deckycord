import { DialogButton, Focusable, TextField, Navigation, GamepadButton, GamepadEvent } from "@decky/ui";
import { useRef } from "react";
import { FaHashtag, FaVolumeUp, FaMicrophone, FaMicrophoneSlash, FaHeadphones, FaPhone, FaPhoneSlash, FaHome, FaPaperPlane, FaDesktop, FaExpand, FaCompress, FaTimes } from "react-icons/fa";
import { api } from "./api";
import { Avatar, Badge, Row, SectionLabel, VoiceUserList, colors, globalCss } from "./components";
import { bus } from "./bus";
import { useChat, HOME } from "./useChat";


function fmtTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? t : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
}

export function ChatPage() {
  const c = useChat();
  const {
    guilds, dms, guildId, channels, channelId, channelName, messages, loadingMsgs,
    voice, setVoice, calls, dmCall, watching, setWatching, theater, setTheater, viewerRef,
    draft, setDraft, error, hasMore, bottomRef, loadOlder, send, selectGuild, openText,
    shareBusy, toggleShare, callBusy, startCall, answerCall, declineCall, stopWatching, onWatchUser, joinVoice,
  } = c;
  const voiceBarRef = useRef<HTMLDivElement>(null);
  const firstVoiceRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const chanRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  /** Bumpers move focus between panes (rail / channels / content). L2 jumps to the content
   *  header (the Call button in a DM); R2 jumps to the bottom of the current pane. */
  const headerRef = useRef<HTMLDivElement>(null);
  const focusablesIn = (root: HTMLElement | null): HTMLElement[] =>
    root ? Array.from(root.querySelectorAll<HTMLElement>('[tabindex="0"], button, input')).filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled) : [];
  const isSelected = (el: HTMLElement) => typeof el.className === "string" && el.className.includes("deckycord-selected");
  const onButtonDown = (evt: GamepadEvent) => {
    const b = evt.detail.button;
    const isPane = b === GamepadButton.BUMPER_LEFT || b === GamepadButton.BUMPER_RIGHT;
    const isJump = b === GamepadButton.TRIGGER_LEFT || b === GamepadButton.TRIGGER_RIGHT;
    if (!isPane && !isJump) return;
    if (evt.detail.is_repeat) return;
    try {
      const panes = [railRef.current, chanRef.current, mainRef.current];
      // Plugin code runs in Steam's shared JS context; the page lives in another window, so ask
      // the elements' own document for the focused element.
      const doc = (evt.target as HTMLElement | null)?.ownerDocument ?? panes.find(Boolean)?.ownerDocument ?? document;
      const active = doc.activeElement as HTMLElement | null;
      let idx = panes.findIndex((p) => !!p && !!active && p.contains(active));
      let target: HTMLElement | undefined;
      if (isPane) {
        const dir = b === GamepadButton.BUMPER_RIGHT ? 1 : -1;
        let next = idx < 0 ? 0 : idx + dir;
        while (next >= 0 && next < panes.length && !focusablesIn(panes[next]).length) next += dir;
        if (next < 0 || next >= panes.length) return;
        const els = focusablesIn(panes[next]);
        target = els.find(isSelected) ?? els[0];
      } else if (b === GamepadButton.TRIGGER_LEFT) {
        target = focusablesIn(headerRef.current)[0] ?? focusablesIn(panes[idx < 0 ? 0 : idx])[0];
      } else {
        // Bottom: the newest message when there is one, else the pane's last control.
        const pane = panes[idx < 0 ? 2 : idx];
        const els = focusablesIn(pane);
        const msgs = els.filter((el) => typeof el.className === "string" && el.className.includes("deckycord-msg"));
        target = msgs.length ? msgs[msgs.length - 1] : els[els.length - 1];
      }
      if (!target) return;
      target.focus();
      evt.stopPropagation();
    } catch {
      /* focus juggling is best-effort */
    }
  };

  /** Triangle / Y: jump to the voice controls, or to the first voice channel when not connected. */
  const jumpToVoice = () => {
    const target = voice?.channelId ? voiceBarRef.current : firstVoiceRef.current ?? voiceBarRef.current;
    if (!target) return;
    const el = target.querySelector<HTMLElement>("button, [tabindex]") ?? target;
    el.focus();
  };

  const colStyle = (w: string | number, bg: string) => ({
    width: w,
    flexShrink: 0,
    background: bg,
    height: "100%",
    display: "flex",
    flexDirection: "column" as const,
  });

  return (
    <Focusable
      flow-children="row"
      onOptionsButton={jumpToVoice}
      onOptionsActionDescription="Voice"
      onButtonDown={onButtonDown}
      actionDescriptionMap={{ [GamepadButton.BUMPER_LEFT]: "Prev pane", [GamepadButton.BUMPER_RIGHT]: "Next pane", [GamepadButton.TRIGGER_LEFT]: guildId === HOME && channelId ? "Call" : "Top", [GamepadButton.TRIGGER_RIGHT]: "Bottom" }}
      style={{ marginTop: 40, height: "calc(100vh - 40px - 58px)", overflow: "hidden", display: "flex", background: colors.bg, color: colors.text, fontFamily: "inherit" }}
    >
      <style>{globalCss}</style>

      {/* Server rail */}
      {!theater && <Focusable ref={railRef} flow-children="column" className="deckycord-scroll" style={{ ...colStyle(96, colors.bg), paddingTop: 8 }}>
        <Row onActivate={() => selectGuild(HOME)} selected={guildId === HOME} style={{ justifyContent: "center", padding: 6 }} onOKActionDescription="Direct Messages">
          <div style={{ width: 44, height: 44, borderRadius: guildId === HOME ? 14 : 22, background: guildId === HOME ? colors.accent : colors.panel, display: "flex", alignItems: "center", justifyContent: "center", transition: "border-radius 120ms" }}>
            <FaHome size={20} />
          </div>
        </Row>
        <div style={{ height: 1, background: "#3f4147", margin: "4px 24px" }} />
        {guilds.map((g) => (
          <Row key={g.id} onActivate={() => selectGuild(g.id)} selected={guildId === g.id} style={{ justifyContent: "center", padding: 6 }} onOKActionDescription={g.name}>
            {g.icon ? (
              <img src={g.icon} style={{ width: 44, height: 44, borderRadius: guildId === g.id ? 14 : 22, transition: "border-radius 120ms" }} />
            ) : (
              <div style={{ width: 44, height: 44, borderRadius: 22, background: colors.panel, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>
                {g.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3)}
              </div>
            )}
          </Row>
        ))}
      </Focusable>}

      {/* Channel list */}
      {!theater && <Focusable ref={chanRef} flow-children="column" style={colStyle(260, colors.panel)}>
        <div style={{ padding: "12px 14px", fontWeight: 700, fontSize: 15, borderBottom: "1px solid #1f2023", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {guildId === HOME ? "Direct Messages" : guilds.find((g) => g.id === guildId)?.name ?? "Server"}
        </div>
        <Focusable flow-children="column" className="deckycord-scroll" style={{ flex: 1, paddingBottom: 8 }}>
          {guildId === HOME &&
            dms.map((d) => (
              <Row key={d.id} onActivate={() => openText(d.id, d.name)} selected={channelId === d.id} onOKActionDescription="Open">
                <Avatar url={d.icon} name={d.name} size={30} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: d.unread ? 700 : 400, color: d.unread ? "#fff" : undefined }}>{d.name}</span>
                {d.call && <FaPhone style={{ color: colors.green, marginLeft: "auto", flexShrink: 0 }} />}
                <Badge n={d.mentions} />
              </Row>
            ))}
          {guildId !== HOME && channels && (
            <>
              {channels.voice.length > 0 && <SectionLabel>Voice</SectionLabel>}
              {channels.voice.map((vc, vi) => (
                <div key={vc.id}>
                  <Row
                    innerRef={vi === 0 ? firstVoiceRef : undefined}
                    onActivate={() => joinVoice(vc.id)}
                    onSecondary={() => openText(vc.id, "🔊 " + vc.name)}
                    selected={voice?.channelId === vc.id || channelId === vc.id}
                    onOKActionDescription={voice?.channelId === vc.id ? "Leave voice" : "Join voice"}
                    onSecondaryActionDescription="Voice chat text"
                  >
                    <FaVolumeUp style={{ color: colors.muted, flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{vc.name}</span>
                    {vc.users.length > 0 && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.muted }}>{vc.users.length}</span>}
                  </Row>
                  <VoiceUserList users={vc.users} onWatch={voice?.channelId === vc.id ? onWatchUser : undefined} watchingId={watching?.ownerId} />
                </div>
              ))}
              {channels.text.length > 0 && <SectionLabel>Text</SectionLabel>}
              {channels.text.map((tc) => (
                <Row key={tc.id} onActivate={() => openText(tc.id, "#" + tc.name)} selected={channelId === tc.id} onOKActionDescription="Open">
                  <FaHashtag style={{ color: colors.muted, flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: tc.unread ? 700 : 400, color: tc.unread ? "#fff" : undefined }}>{tc.name}</span>
                  <Badge n={tc.mentions} />
                </Row>
              ))}
            </>
          )}
        </Focusable>

        {/* Voice status footer */}
        <div style={{ background: "#232428", padding: 8, borderTop: "1px solid #1f2023" }}>
          {voice?.channelId ? (
            <>
              <div style={{ fontSize: 12, color: colors.green, fontWeight: 700 }}>
                {(voice.isCall ? (voice.ringing ? "Calling…" : "Call Connected") : "Voice Connected") + (voice.streaming ? " · Live" : voice.video ? " · Camera share" : "")}
              </div>
              <div style={{ fontSize: 12, color: colors.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {voice.guildName ? `${voice.channelName} / ${voice.guildName}` : voice.channelName}
              </div>
              <Focusable ref={voiceBarRef} flow-children="row" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1, background: voice.mute ? colors.red : undefined }} onClick={() => api.toggleMute().then(setVoice)} onOKActionDescription={voice.mute ? "Unmute" : "Mute"}>
                  {voice.mute ? <FaMicrophoneSlash /> : <FaMicrophone />}
                </DialogButton>
                <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1, background: voice.deaf ? colors.red : undefined }} onClick={() => api.toggleDeaf().then(setVoice)} onOKActionDescription={voice.deaf ? "Undeafen" : "Deafen"}>
                  <FaHeadphones />
                </DialogButton>
                <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1, background: voice.video || voice.streaming ? colors.green : undefined }} disabled={shareBusy} onClick={toggleShare} onOKActionDescription={voice.video || voice.streaming ? "Stop sharing" : shareBusy ? "Starting…" : "Share screen"}>
                  <FaDesktop />
                </DialogButton>
                <DialogButton style={{ minWidth: 0, padding: "8px 0", flex: 1 }} onClick={() => { setWatching(null); setTheater(false); api.leaveVoice().then(() => setTimeout(() => api.voice().then(setVoice), 500)); }} onOKActionDescription={voice.isCall ? "Hang up" : "Disconnect"}>
                  <FaPhoneSlash />
                </DialogButton>
              </Focusable>
              {/* Who is here; streaming members are selectable to watch, from anywhere in the page. */}
              <div className="deckycord-scroll" style={{ maxHeight: 160, marginTop: 4 }}>
                <VoiceUserList users={voice.users.filter((u) => u.id !== bus.selfId)} compact plain onWatch={onWatchUser} watchingId={watching?.ownerId} />
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: colors.muted }}>Not in voice</div>
          )}
        </div>
      </Focusable>}

      {/* Stream viewer */}
      {watching && (
        <Focusable ref={(el) => { (viewerRef as any).current = el; (mainRef as any).current = el; }} flow-children="column" style={{ ...colStyle("auto", "#000"), flex: 1, minWidth: 0 }}>
          <Focusable flow-children="row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: colors.panelAlt, borderBottom: "1px solid #26272b" }}>
            <span style={{ background: watching.camera ? colors.accent : colors.red, color: "#fff", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontWeight: 800 }}>{watching.camera ? "CAM" : "LIVE"}</span>
            <span style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{watching.name}</span>
            <DialogButton style={{ minWidth: 0, width: 48, padding: "6px 0", flexShrink: 0 }} onClick={() => setTheater((t) => !t)} onOKActionDescription={theater ? "Show sidebars" : "Fullscreen"}>
              {theater ? <FaCompress /> : <FaExpand />}
            </DialogButton>
            <DialogButton style={{ minWidth: 0, width: 48, padding: "6px 0", flexShrink: 0 }} onClick={stopWatching} onOKActionDescription="Stop watching">
              <FaTimes />
            </DialogButton>
          </Focusable>
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}>
            {watching.url ? (
              <img
                src={watching.url}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                onError={() => {
                  // A stalled first part shows as a broken image; reconnect with a fresh URL.
                  setTimeout(() => setWatching((w) => (w && w.url ? { ...w, url: w.url.replace(/\?t=\d+/, `?t=${Date.now()}`) } : w)), 1500);
                }}
              />
            ) : (
              <div style={{ color: watching.error ? colors.red : colors.muted, padding: 24, textAlign: "center" }}>{watching.error ?? "Connecting to stream…"}</div>
            )}
          </div>
        </Focusable>
      )}

      {/* Messages */}
      {!watching && <Focusable ref={mainRef} flow-children="column" style={{ ...colStyle("auto", colors.panelAlt), flex: 1, minWidth: 0 }}>
        <Focusable ref={headerRef} flow-children="row" style={{ padding: "8px 16px", fontWeight: 700, fontSize: 15, borderBottom: "1px solid #26272b", display: "flex", alignItems: "center", gap: 8, minHeight: 40 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{channelName || "Select a channel"}</span>
          {error && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.red, fontWeight: 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 400 }}>{error}</span>}
          {guildId === HOME && channelId && voice?.channelId !== channelId && (
            <DialogButton style={{ minWidth: 0, width: 48, padding: "6px 0", marginLeft: error ? 8 : "auto", flexShrink: 0 }} disabled={callBusy} onClick={startCall} onOKActionDescription={callBusy ? "Calling…" : dmCall?.active ? "Join call" : "Start call"}>
              <FaPhone />
            </DialogButton>
          )}
        </Focusable>
        {dmCall && dmCall.active && (
          <Focusable flow-children="column" style={{ padding: "8px 16px", background: "rgba(35,165,89,0.10)", borderBottom: "1px solid #26272b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, color: colors.green }}>
              <FaPhone />
              {dmCall.inCall ? (dmCall.ringing ? "Calling…" : "In this call") : "Call in progress"}
              {!dmCall.inCall && (
                <DialogButton style={{ minWidth: 0, width: 110, padding: "6px 0", marginLeft: "auto", background: colors.green }} disabled={callBusy} onClick={startCall} onOKActionDescription="Join call">
                  Join call
                </DialogButton>
              )}
            </div>
            <VoiceUserList users={dmCall.users} onWatch={dmCall.inCall ? onWatchUser : undefined} />
          </Focusable>
        )}
        {calls.map((c) => (
          <Focusable key={c.channelId} flow-children="row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", background: "rgba(35,165,89,0.18)", borderBottom: "1px solid #26272b" }}>
            <Avatar url={c.icon} name={c.name} size={30} ring />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.group ? `Group call · ${c.name}` : `${c.name} is calling`}</div>
              {c.users.length > 0 && <div style={{ fontSize: 12, color: colors.muted }}>In call: {c.users.join(", ")}</div>}
            </div>
            <DialogButton style={{ minWidth: 0, width: 96, padding: "6px 0", background: colors.green, flexShrink: 0 }} onClick={() => answerCall(c.channelId)} onOKActionDescription="Answer">
              Answer
            </DialogButton>
            <DialogButton style={{ minWidth: 0, width: 96, padding: "6px 0", background: colors.red, flexShrink: 0 }} onClick={() => declineCall(c.channelId)} onOKActionDescription="Decline">
              Decline
            </DialogButton>
          </Focusable>
        ))}
        <Focusable flow-children="column" className="deckycord-scroll" style={{ flex: 1, padding: "8px 0" }}>
          {loadingMsgs && <div style={{ padding: 16, color: colors.muted }}>Loading…</div>}
          {!loadingMsgs && channelId && messages.length > 0 && (
            <div style={{ padding: "4px 16px", color: colors.muted, fontSize: 12 }}>{hasMore ? "Move up past the first message to load older history" : "Beginning of conversation"}</div>
          )}
          {!loadingMsgs && channelId && messages.length === 0 && <div style={{ padding: 16, color: colors.muted }}>No messages yet.</div>}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.author?.id === m.author?.id && m.timestamp && prev.timestamp && new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() < 5 * 60 * 1000;
            return (
              <Focusable
                key={m.id}
                className="deckycord-msg"
                focusClassName="deckycord-focus"
                onActivate={() => {}}
                onGamepadFocus={i === 0 ? () => loadOlder() : undefined}
                onOKActionDescription={m.author?.name ?? ""}
                style={{ display: "flex", gap: 12, padding: grouped ? "1px 16px" : "8px 16px 1px", marginTop: grouped ? 0 : 6, borderRadius: 4 }}
              >
                {grouped ? <div style={{ width: 36, flexShrink: 0 }} /> : <Avatar url={m.author?.avatar ?? null} name={m.author?.name ?? "?"} size={36} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  {!grouped && (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontWeight: 600, color: "#fff" }}>{m.author?.name ?? "Unknown"}</span>
                      <span style={{ fontSize: 11, color: colors.muted }}>{fmtTime(m.timestamp)}</span>
                    </div>
                  )}
                  {m.content && <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.35 }}>{m.content}</div>}
                  {m.attachments.map((a) =>
                    a.type && a.type.startsWith("image/") ? (
                      <img key={a.url} src={a.url} style={{ maxWidth: 320, maxHeight: 240, borderRadius: 6, marginTop: 4, display: "block" }} />
                    ) : (
                      <div key={a.url} style={{ color: colors.accent, fontSize: 13 }}>📎 {a.name}</div>
                    )
                  )}
                  {m.stickers.length > 0 && <div style={{ color: colors.muted, fontSize: 13 }}>Sticker: {m.stickers.join(", ")}</div>}
                  {m.embeds > 0 && !m.content && <div style={{ color: colors.muted, fontSize: 13 }}>[embed]</div>}
                </div>
              </Focusable>
            );
          })}
          <div ref={bottomRef} />
        </Focusable>
        {channelId && (
          <Focusable flow-children="row" style={{ display: "flex", gap: 8, padding: "8px 12px 12px", alignItems: "center", background: colors.panelAlt }}>
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
            <DialogButton style={{ minWidth: 0, width: 56, padding: "10px 0" }} onClick={send} disabled={!draft.trim()} onOKActionDescription="Send">
              <FaPaperPlane />
            </DialogButton>
          </Focusable>
        )}
      </Focusable>}
    </Focusable>
  );
}

export function goHome() {
  Navigation.NavigateBack();
}
