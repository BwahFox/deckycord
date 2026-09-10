import { useCallback, useEffect, useRef, useState } from "react";
import { api, Channels, DM, DmCall, Guild, IncomingCall, Message, VoiceState, VoiceUser } from "./api";
import { bus } from "./bus";

export const HOME = "@me";

/**
 * All chat state and actions, shared by the full page (/deckycord) and the Quick Access overlay.
 * Only one of them is mounted at a time.
 */
export function useChat() {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [dms, setDms] = useState<DM[]>([]);
  const [guildId, setGuildId] = useState<string>(HOME);
  const [channels, setChannels] = useState<Channels | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelName, setChannelName] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const [calls, setCalls] = useState<IncomingCall[]>([]);
  /** Ongoing call in the open DM (participants, whether we're in it). */
  const [dmCall, setDmCall] = useState<DmCall | null>(null);
  /** Stream viewer: who we are watching, the MJPEG URL, and whether the sidebars are hidden. */
  const [watching, setWatching] = useState<{ ownerId: string; name: string; url: string | null; error: string | null; camera?: boolean } | null>(null);
  const [theater, setTheater] = useState(false);
  const watchBusy = useRef(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const loadingOlder = useRef(false);
  const loadedCount = useRef(0);
  const [hasMore, setHasMore] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadHome = useCallback(async () => {
    try {
      const [g, d, v, c] = await Promise.all([api.guilds(), api.dms(), api.voice(), api.incomingCalls()]);
      setGuilds(g);
      setDms(d);
      setVoice(v);
      setCalls(c);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadChannels = useCallback(async (gid: string) => {
    if (gid === HOME) {
      setChannels(null);
      return;
    }
    try {
      setChannels(await api.channels(gid));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadMessages = useCallback(async (cid: string, quiet = false) => {
    if (!quiet) setLoadingMsgs(true);
    try {
      const m = await api.messages(cid, quiet ? Math.max(50, loadedCount.current) : 50);
      loadedCount.current = m.length;
      setMessages(m);
      api.ack(cid).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    loadHome();
    const t = setInterval(loadHome, 30000);
    return () => clearInterval(t);
  }, [loadHome]);

  // Opened from a notification: jump straight to that channel (on mount, or while mounted).
  const openPending = useCallback(async () => {
    const pending = bus.pendingChannel;
    if (!pending) return;
    bus.pendingChannel = null;
    try {
      const info = await api.channelInfo(pending);
      if (!info) return;
      setGuildId(info.guildId ?? HOME);
      setChannelId(pending);
      setChannelName(info.guildId ? "#" + info.name : info.name);
    } catch {}
  }, []);
  useEffect(() => {
    openPending();
    return bus.on((ev) => { if (ev.type === "open_channel") openPending(); });
  }, [openPending]);

  useEffect(() => {
    loadChannels(guildId);
  }, [guildId, loadChannels]);

  // Opened from the panel/toast to watch a stream.
  useEffect(() => {
    const pending = bus.pendingWatch;
    if (!pending) return;
    bus.pendingWatch = null;
    startWatching(pending.ownerId, pending.name);
  }, []);

  const loadDmCall = useCallback(async (cid: string | null, gid: string) => {
    if (!cid || gid !== HOME) {
      setDmCall(null);
      return;
    }
    try {
      setDmCall(await api.dmCall(cid));
    } catch {
      setDmCall(null);
    }
  }, []);
  useEffect(() => {
    loadDmCall(channelId, guildId);
  }, [channelId, guildId, loadDmCall]);

  useEffect(() => {
    bus.currentChannel = channelId;
    setHasMore(true);
    if (channelId) loadMessages(channelId);
    else setMessages([]);
    return () => {
      bus.currentChannel = null;
    };
  }, [channelId, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  // Live updates pushed from the backend.
  useEffect(() => {
    return bus.on((ev) => {
      if (ev.type === "message") {
        if (ev.channelId === channelId) loadMessages(ev.channelId, true);
        else if (guildId === HOME) api.dms().then(setDms).catch(() => {});
        else loadChannels(guildId);
      } else if (ev.type === "voice" || ev.type === "rtc") {
        api.voice().then(setVoice).catch(() => {});
        if (guildId !== HOME) loadChannels(guildId);
        else { api.dms().then(setDms).catch(() => {}); loadDmCall(channelId, guildId); }
      } else if (ev.type === "call") {
        api.incomingCalls().then(setCalls).catch(() => {});
        api.voice().then(setVoice).catch(() => {});
        loadDmCall(channelId, guildId);
      } else if (ev.type === "stream" && !ev.live) {
        setWatching((w) => (w && w.ownerId === ev.ownerId ? { ...w, url: null, error: `${w.name} stopped streaming` } : w));
      } else if (ev.type === "frames") {
        setWatching((w) => (w ? { ...w, url: null, error: "Lost the stream video" } : w));
      } else if (ev.type === "speaking") {
        const mark = <T extends { id: string; speaking: boolean }>(u: T): T => (u.id === ev.userId ? { ...u, speaking: ev.speaking } : u);
        setVoice((v) => (v ? { ...v, users: v.users.map(mark) } : v));
        setChannels((c) => (c ? { ...c, voice: c.voice.map((vc) => ({ ...vc, users: vc.users.map(mark) })) } : c));
      } else if (ev.type === "ack") {
        if (guildId === HOME) api.dms().then(setDms).catch(() => {});
        else loadChannels(guildId);
      }
    });
  }, [channelId, guildId, loadMessages, loadChannels, loadDmCall]);

  const loadOlder = async () => {
    if (!channelId || !hasMore || loadingOlder.current || messages.length === 0) return;
    loadingOlder.current = true;
    try {
      const r = await api.older(channelId, messages[0].id, 50);
      if (r.messages.length <= messages.length) setHasMore(false);
      else setHasMore(r.hasMore);
      loadedCount.current = r.messages.length;
      setMessages(r.messages);
    } catch (e) {
      setError(String(e));
    } finally {
      loadingOlder.current = false;
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !channelId || sending.current) return;
    sending.current = true;
    try {
      await api.send(channelId, text);
      setDraft("");
      await loadMessages(channelId, true);
    } catch (e) {
      setError(String(e));
    } finally {
      sending.current = false;
    }
  };

  const selectGuild = (gid: string) => {
    setGuildId(gid);
    setChannelId(null);
    setChannelName("");
  };

  const openText = (id: string, name: string) => {
    setChannelId(id);
    setChannelName(name);
  };

  const [shareBusy, setShareBusy] = useState(false);
  const toggleShare = async () => {
    if (!voice || shareBusy) return;
    setShareBusy(true);
    try {
      const sharing = voice.video || voice.streaming;
      const r = sharing ? await api.stopShare() : await api.startShare("golive", 720, 30);
      if (!r.ok) setError("Share failed: " + ((r as any).error ?? "unknown"));
      setVoice(await api.voice());
    } catch (e) {
      setError(String(e));
    } finally {
      setShareBusy(false);
    }
  };

  const refreshVoiceSoon = () => setTimeout(() => api.voice().then(setVoice).catch(() => {}), 800);
  const [callBusy, setCallBusy] = useState(false);
  const startCall = async () => {
    if (!channelId || callBusy) return;
    setCallBusy(true);
    try {
      // Joining an ongoing call must not ring everyone again.
      const r = dmCall?.active ? await api.acceptCall(channelId) : await api.startCall(channelId);
      if (!r.ok) setError("Call failed: " + ((r as any).error ?? "unknown"));
      refreshVoiceSoon();
      setTimeout(() => loadDmCall(channelId, guildId), 800);
    } catch (e) {
      setError(String(e));
    } finally {
      setCallBusy(false);
    }
  };
  const answerCall = async (id: string) => {
    try {
      await api.acceptCall(id);
      setCalls((c) => c.filter((x) => x.channelId !== id));
      refreshVoiceSoon();
    } catch (e) {
      setError(String(e));
    }
  };
  const declineCall = async (id: string) => {
    setCalls((c) => c.filter((x) => x.channelId !== id));
    api.declineCall(id).catch(() => {});
  };

  const startWatching = async (ownerId: string, name: string) => {
    if (watchBusy.current) return;
    watchBusy.current = true;
    setWatching({ ownerId, name, url: null, error: null });
    try {
      const r = await api.watchStream(ownerId, 15, 1280, 0.6);
      if (!r.ok) {
        setWatching({ ownerId, name, url: null, error: r.error ?? "could not watch stream" });
      } else {
        const u = await api.streamUrl();
        setWatching({ ownerId, name, url: `${u.mjpeg}?t=${Date.now()}`, error: null, camera: !!r.camera });
        setTimeout(() => viewerRef.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus(), 200);
      }
      refreshVoiceSoon();
    } catch (e) {
      setWatching({ ownerId, name, url: null, error: String(e) });
    } finally {
      watchBusy.current = false;
    }
  };
  const stopWatching = async () => {
    setWatching(null);
    setTheater(false);
    try {
      await api.stopWatching();
    } catch (e) {
      setError(String(e));
    }
    refreshVoiceSoon();
  };
  const onWatchUser = (u: VoiceUser) => {
    if (watching?.ownerId === u.id) stopWatching();
    else startWatching(u.id, u.name);
  };

  const joinVoice = async (id: string) => {
    try {
      if (voice?.channelId === id) { await api.leaveVoice(); setWatching(null); setTheater(false); }
      else await api.joinVoice(id);
      setTimeout(() => api.voice().then(setVoice).catch(() => {}), 800);
    } catch (e) {
      setError(String(e));
    }
  };

  return {
    HOME,
    guilds, dms, guildId, channels, channelId, channelName, messages, loadingMsgs,
    voice, setVoice, calls, dmCall, watching, setWatching, theater, setTheater, viewerRef,
    draft, setDraft, error, setError, hasMore, bottomRef,
    loadHome, loadChannels, loadMessages, loadDmCall, loadOlder, send, selectGuild, openText,
    shareBusy, toggleShare, callBusy, startCall, answerCall, declineCall,
    startWatching, stopWatching, onWatchUser, joinVoice,
  };
}
