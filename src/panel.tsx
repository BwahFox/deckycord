import { ButtonItem, PanelSection, PanelSectionRow, Field, ToggleField, DropdownItem, SliderField } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaDiscord, FaPhone } from "react-icons/fa";
import { Agc, api, Status } from "./api";
import { bus } from "./bus";
import { openOverlay } from "./qam";

export function useStatus(intervalMs: number): [Status | null, () => Promise<void>] {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = async () => {
    try {
      const st = await api.status();
      bus.selfId = st.user?.id ?? bus.selfId;
      setStatus(st);
    } catch (e) {
      setStatus({ running: false, cdp: false, loggedIn: false, user: null, voice: null, error: String(e) });
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    const off = bus.on((ev) => {
      if (ev.type === "status" || ev.type === "voice" || ev.type === "login" || ev.type === "logout" || ev.type === "rtc" || ev.type === "call") refresh();
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  return [status, refresh];
}

export function LoginSection() {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const q = await api.loginQr();
        if (alive) setQr(q);
      } catch {
        if (alive) setQr(null);
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return (
    <PanelSection title="Log in to Discord">
      <PanelSectionRow>
        <div style={{ fontSize: 12, opacity: 0.8, padding: "4px 0" }}>
          Open Discord on your phone, go to Settings, tap the QR scanner, and scan this code.
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ display: "flex", justifyContent: "center", padding: 8 }}>
          {qr ? (
            <img src={qr} style={{ width: 220, height: 220, borderRadius: 8, background: "#fff" }} />
          ) : (
            <div style={{ opacity: 0.7 }}>Waiting for the login page…</div>
          )}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

export function shortName(n: string): string {
  return n.replace(/^alsa_(input|output)\./, "").replace(/^bluez_(input|output)\./, "BT ").slice(0, 40);
}

export function balanceText(b: number): string {
  if (b <= -100) return "Voice chat only (game muted)";
  if (b >= 100) return "Game only (voice muted)";
  if (b === 0) return "Voice and game at full volume";
  return b < 0 ? `Game at ${100 + b}%` : `Voice chat at ${100 - b}%`;
}

export function AudioSection() {
  const [src, setSrc] = useState<{ sources: string[]; default: string | null } | null>(null);
  const [sink, setSink] = useState<{ sinks: string[]; default: string | null } | null>(null);
  const [balance, setBalance] = useState(0);
  const [agc, setAgc] = useState<Agc | null>(null);
  const [agcBusy, setAgcBusy] = useState(false);
  const load = async () => {
    try {
      const [a, b] = await Promise.all([api.audioSources(), api.audioSinks()]);
      setSrc(a);
      setSink(b);
    } catch {}
  };
  useEffect(() => {
    api.getBalance().then((b) => setBalance(b.balance)).catch(() => {});
    api.getAgc().then(setAgc).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  return (
    <PanelSection title="Audio">
      <PanelSectionRow>
        <DropdownItem
          label="Microphone"
          rgOptions={(src?.sources ?? []).map((s) => ({ data: s, label: shortName(s) }))}
          selectedOption={src?.default ?? undefined}
          strDefaultLabel={src && src.sources.length === 0 ? "No mic detected" : "Select…"}
          onChange={async (o) => { await api.setMic(o.data); load(); }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label="Output"
          rgOptions={(sink?.sinks ?? []).map((s) => ({ data: s, label: shortName(s) }))}
          selectedOption={sink?.default ?? undefined}
          strDefaultLabel="Select…"
          onChange={async (o) => { await api.setSink(o.data); load(); }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label="Voice / game mix"
          description={balanceText(balance)}
          value={balance}
          min={-100}
          max={100}
          step={10}
          resetValue={0}
          notchCount={3}
          notchTicksVisible={true}
          notchLabels={[
            { notchIndex: 0, label: "Voice", value: -100 },
            { notchIndex: 1, label: "Mix", value: 0 },
            { notchIndex: 2, label: "Game", value: 100 },
          ]}
          onChange={(v) => { setBalance(v); api.setBalance(v).catch(() => {}); }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Let Discord adjust mic volume"
          description={
            agcBusy ? "Restarting Discord…"
            : agc && agc.applied !== null && agc.applied !== agc.agc ? "Takes effect after Discord restarts (Maintenance → Restart Discord backend)"
            : "Off: Steam's mic slider is the only control. Changing this restarts Discord and drops your voice call."
          }
          checked={agc?.agc ?? false}
          disabled={agcBusy || !agc}
          onChange={async (v) => {
            setAgc((a) => (a ? { ...a, agc: v } : a));
            setAgcBusy(true);
            try { setAgc(await api.setAgc(v)); } catch {}
            setAgcBusy(false);
          }}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}

/** Answer a ringing DM call and open its chat. */
export async function answerCall(channelId: string) {
  try {
    await api.acceptCall(channelId);
  } catch (e) {
    toaster.toast({ title: "Could not answer call", body: String(e) });
    return;
  }
  openOverlay(channelId);
}

export function IncomingCallsSection({ status, refresh }: { status: Status; refresh: () => Promise<void> }) {
  const calls = status.calls ?? [];
  if (!calls.length) return null;
  return (
    <PanelSection title="Incoming call">
      {calls.map((c) => (
        <div key={c.channelId}>
          <PanelSectionRow>
            <Field label={c.name} description={c.group ? (c.users.length ? `In call: ${c.users.join(", ")}` : "Group call") : "is calling you"} icon={<FaPhone />} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => answerCall(c.channelId)}>
              Answer
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={async () => { await api.declineCall(c.channelId).catch(() => {}); refresh(); }}>
              Decline
            </ButtonItem>
          </PanelSectionRow>
        </div>
      ))}
    </PanelSection>
  );
}

/** Recovery controls: cheapest first. Reconnect keeps voice; restarting Vesktop drops it. */
export function MaintenanceSection({ refresh }: { refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(label);
    try {
      const msg = await fn();
      toaster.toast({ title: label, body: msg, logo: <FaDiscord size={28} />, duration: 5000 });
    } catch (e) {
      toaster.toast({ title: `${label} failed`, body: String(e), duration: 6000 });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return (
    <PanelSection title="Maintenance">
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!busy} description="Re-attach to Discord; keeps your voice call" onClick={() => run("Reconnect to Discord", async () => { const r = await api.reconnect(); if (!r.ok) throw new Error(r.error ?? "unknown"); const missing = Object.entries(r.stores ?? {}).filter(([, ok]) => !ok).map(([k]) => k); return missing.length ? `Reconnected; missing stores: ${missing.join(", ")}` : "Reconnected"; })}>
          {busy === "Reconnect to Discord" ? "Reconnecting…" : "Reconnect to Discord"}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!busy} description="Stop any screen share and capture" onClick={() => run("Stop sharing", async () => { await api.stopShare(); return "Capture stopped"; })}>
          Stop sharing
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!busy} description="Stop Vesktop and capture entirely until you resume; frees all CPU for the game" onClick={() => run("Suspend Discord", async () => { await api.suspend(); return "Discord stopped; press Resume when you want it back"; })}>
          {busy === "Suspend Discord" ? "Suspending…" : "Suspend Discord"}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!busy} description="Relaunch the hidden Vesktop; drops your voice call" onClick={() => run("Restart Discord backend", async () => { await api.restartBackend(); return "Vesktop restarting"; })}>
          {busy === "Restart Discord backend" ? "Restarting…" : "Restart Discord backend"}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!busy} description="Reload the plugin's frontend and backend" onClick={() => run("Reload Deckycord", async () => { const loader = (window as any).DeckyPluginLoader; if (!loader?.importPlugin) throw new Error("Decky reload API not available"); setTimeout(() => loader.importPlugin("Deckycord", "0.0.1"), 300); return "Reloading…"; })}>
          Reload Deckycord
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

