import { Focusable, PanelSectionRow } from "@decky/ui";
import { CSSProperties, ReactNode, RefObject } from "react";
import { FaMicrophoneSlash, FaHeadphones } from "react-icons/fa";
import { VoiceUser } from "./api";

export const colors = {
  bg: "#1e1f22",
  panel: "#2b2d31",
  panelAlt: "#313338",
  text: "#dbdee1",
  muted: "#949ba4",
  accent: "#5865f2",
  green: "#23a559",
  red: "#f23f43",
  focus: "#ffffff",
};

export function Avatar({ url, name, size = 32, ring }: { url: string | null; name: string; size?: number; ring?: boolean }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    background: colors.accent,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: size * 0.45,
    fontWeight: 600,
    color: "#fff",
    overflow: "hidden",
    boxShadow: ring ? `0 0 0 3px ${colors.green}` : undefined,
    transition: "box-shadow 80ms",
  };
  return (
    <div style={style}>
      {url ? <img src={url} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

/** A focusable row with a Discord-like look. Steam draws its own focus ring around Focusable. */
export function Row({
  children,
  onActivate,
  onSecondary,
  selected,
  style,
  actionDescriptionMap,
  onOKActionDescription,
  onSecondaryActionDescription,
  innerRef,
}: {
  children: ReactNode;
  innerRef?: RefObject<HTMLDivElement | null>;
  onActivate?: () => void;
  onSecondary?: () => void;
  selected?: boolean;
  style?: CSSProperties;
  actionDescriptionMap?: any;
  onOKActionDescription?: ReactNode;
  onSecondaryActionDescription?: ReactNode;
}) {
  return (
    <Focusable
      ref={innerRef as any}
      onActivate={onActivate}
      onSecondaryButton={onSecondary}
      onOKActionDescription={onOKActionDescription}
      onSecondaryActionDescription={onSecondaryActionDescription}
      actionDescriptionMap={actionDescriptionMap}
      focusClassName="deckycord-focus"
      className={selected ? "deckycord-selected" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        margin: "2px 6px",
        borderRadius: 6,
        background: selected ? "rgba(255,255,255,0.10)" : "transparent",
        color: selected ? "#fff" : colors.text,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </Focusable>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "12px 12px 4px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: colors.muted }}>
      {children}
    </div>
  );
}

export function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span style={{ marginLeft: "auto", background: colors.red, color: "#fff", borderRadius: 10, padding: "0 6px", fontSize: 11, fontWeight: 700, minWidth: 16, textAlign: "center" }}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function LivePill({ small, label = "LIVE", color = colors.red }: { small?: boolean; label?: string; color?: string }) {
  return (
    <span style={{ marginLeft: "auto", background: color, color: "#fff", borderRadius: 4, padding: small ? "0 4px" : "1px 5px", fontSize: small ? 9 : 10, fontWeight: 800, letterSpacing: 0.5, flexShrink: 0 }}>
      {label}
    </span>
  );
}

/**
 * Members of a voice channel. Streaming members become focusable rows when `onWatch` is given, so
 * a controller can pick a stream to watch.
 */
export function VoiceUserList({ users, compact, onWatch, watchingId, plain }: { users: VoiceUser[]; compact?: boolean; onWatch?: (u: VoiceUser) => void; watchingId?: string | null; plain?: boolean }) {
  if (!users.length) return null;
  const rows = users.map((u) => {
    const inner = (
      <>
        <Avatar url={u.avatar} name={u.name} size={compact ? 22 : 24} ring={u.speaking} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: u.speaking ? "#fff" : undefined }}>{u.name}</span>
        {u.streaming && <LivePill small={compact} />}
        {u.video && <LivePill small={compact} label="CAM" color={colors.accent} />}
        {u.mute && <FaMicrophoneSlash style={{ color: colors.red, marginLeft: u.streaming || u.video ? 4 : "auto", flexShrink: 0 }} />}
        {u.deaf && <FaHeadphones style={{ color: colors.red, marginLeft: u.mute || u.streaming || u.video ? 4 : "auto", flexShrink: 0 }} />}
      </>
    );
    const style: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: compact ? "3px 0" : "4px 0 4px 28px", fontSize: compact ? 13 : 14, color: colors.text };
    if ((u.streaming || u.video) && onWatch) {
      const watching = watchingId === u.id;
      return (
        <Focusable key={u.id} focusClassName="deckycord-focus" onActivate={() => onWatch(u)} onOKActionDescription={watching ? "Stop watching" : u.streaming ? "Watch stream" : "Watch camera"} style={{ ...style, borderRadius: 4, background: watching ? "rgba(242,63,67,0.18)" : undefined }}>
          {inner}
        </Focusable>
      );
    }
    return <div key={u.id} style={style}>{inner}</div>;
  });
  return compact && !plain ? <PanelSectionRow><div>{rows}</div></PanelSectionRow> : <div>{rows}</div>;
}

export const globalCss = `
.deckycord-focus { outline: 2px solid ${colors.focus}; outline-offset: -2px; background: rgba(255,255,255,0.14) !important; }
.deckycord-scroll { overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
.deckycord-scroll::-webkit-scrollbar { display: none; }
`;
