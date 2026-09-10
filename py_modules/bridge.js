// Injected into the Vesktop page. Exposes window.__dc, a small JSON-only API over Discord's
// internal Flux stores (found through Vencord's webpack helpers). Everything returns plain data.
(() => {
  const VERSION = 1;
  // Always reinstall so plugin updates take effect on the live page.
  const V = window.Vencord;
  if (!V || !V.Webpack || !V.Webpack.Common) return "no-vencord";
  const W = V.Webpack;
  const C = W.Common;
  const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
  const findStore = (n) => { try { return W.findStore(n); } catch (e) { return null; } };
  const byProps = (...p) => { try { return W.findByProps(...p); } catch (e) { return null; } };

  // Resolve stores lazily and cache only successful lookups: resolving at install time can freeze
  // a failed lookup if the bridge is installed while Discord is still loading (before login).
  // Vencord's findStore(name) is broken on some Vesktop builds ("Reflect.get called on non-object"),
  // so each store also has a method to find it by (findByProps), and finally a scan by getName().
  const storeNames = {
    Channel: ["ChannelStore", "getSortedPrivateChannels"], Guild: ["GuildStore", "getGuild"],
    Message: ["MessageStore", "getMessages"], User: ["UserStore", "getCurrentUser"],
    Voice: ["VoiceStateStore", "getVoiceStatesForChannel"], SelChan: ["SelectedChannelStore", "getVoiceChannelId"],
    GuildChan: ["GuildChannelStore", "getChannels", "getVocalChannelIds"], Media: ["MediaEngineStore", "isSelfMute", "getMediaEngine"],
    ReadState: ["ReadStateStore", "hasUnread", "getMentionCount"], RTC: ["RTCConnectionStore", "getRTCConnectionId", "getHostname"],
    GuildMember: ["GuildMemberStore", "getNick"], Presence: ["PresenceStore", "getStatus", "getState"],
    Relationship: ["RelationshipStore", "getFriendIDs"], SortedGuild: ["SortedGuildStore", "getFlattenedGuildIds"],
    PrivSort: ["PrivateChannelSortStore", "getPrivateChannelIds"], Speaking: ["SpeakingStore", "isSpeaking"],
    Streaming: ["ApplicationStreamingStore", "getAllActiveStreams"], Call: ["CallStore", "getCalls", "isCallActive"],
    StreamRTC: ["StreamRTCConnectionStore", "getAllActiveStreamKeys"],
  };
  const storeCache = {};
  function resolveStore(name, props) {
    let st = C[name] !== undefined ? C[name] : null;
    if (!st) st = findStore(name);
    if (!st && props.length) st = safe(() => W.findByProps(...props));
    if (!st) st = safe(() => W.find((m) => m && typeof m.getName === "function" && safe(() => m.getName()) === name));
    return st || null;
  }
  const S = {};
  for (const [k, [name, ...props]] of Object.entries(storeNames)) {
    Object.defineProperty(S, k, { get: () => {
      if (storeCache[k]) return storeCache[k];
      const st = resolveStore(name, props);
      if (st) storeCache[k] = st;
      return st;
    } });
  }
  const lazy = (fn) => new Proxy({}, { get: (_, prop) => { const m = fn(); const v = m ? m[prop] : undefined; return typeof v === "function" ? v.bind(m) : v; } });
  const MediaActions = lazy(() => byProps("toggleSelfMute", "toggleSelfDeaf"));
  const MsgActions = lazy(() => C.MessageActions);
  const ChanActions = lazy(() => byProps("selectVoiceChannel", "disconnect") || C.ChannelActionCreators);
  const AckActions = lazy(() => byProps("ack", "ackGuild") || byProps("ack", "ackCategory"));
  // call(channelId, video, ring, userId?, cb?) joins the DM's voice and rings the recipients;
  // stopRinging(channelId, [userIds]) is what Discord's own "Decline" does.
  const CallActions = lazy(() => byProps("call", "ring", "stopRinging"));
  // Discord's watch/stop-watching actions only exist under mangled export names; find them by code.
  const byCode = (...c) => { try { return W.findByCode(...c); } catch (e) { return null; } };
  const watchStreamFn = () => byCode('"STREAM_WATCH"');
  const closeStreamFn = () => byCode('"STREAM_CLOSE"');
  const RtcLayout = lazy(() => byProps("selectParticipant", "popoutParticipant"));
  // Friend requests: acceptFriendRequest({userId, context}), cancelFriendRequest({userId, context}),
  // removeRelationship(userId, context) (also declines an incoming request), sendRequest({discordTag, context}).
  const RelActions = lazy(() => byProps("sendRequest", "acceptFriendRequest", "removeRelationship"));
  const relCtx = { location: "Friends" };
  const Dispatcher = C.FluxDispatcher;

  const str = (x) => (x == null ? null : String(x));

  function userInfo(u, guildId) {
    if (!u) return null;
    let nick = null;
    if (guildId) nick = safe(() => S.GuildMember.getNick(guildId, u.id)) || safe(() => S.GuildMember.getMember(guildId, u.id)?.nick) || null;
    return {
      id: u.id,
      name: nick || u.globalName || u.username,
      username: u.username,
      avatar: safe(() => u.getAvatarURL(guildId || null, 64, false)) || null,
      bot: !!u.bot,
    };
  }

  function currentUser() { return safe(() => S.User.getCurrentUser()); }

  function channelDisplayName(ch) {
    if (!ch) return "?";
    if (ch.name) return ch.name;
    const rec = (ch.recipients || []).map((id) => S.User.getUser(id)).filter(Boolean);
    if (rec.length) return rec.map((u) => u.globalName || u.username).join(", ");
    const raw = ch.rawRecipients || [];
    if (raw.length) return raw.map((u) => u.global_name || u.username).join(", ");
    return "Direct Message";
  }

  function channelIcon(ch) {
    if (!ch) return null;
    if (ch.type === 1) {
      const u = S.User.getUser((ch.recipients || [])[0]);
      return safe(() => u.getAvatarURL(null, 64, false));
    }
    if (ch.icon) return `https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.png?size=64`;
    return null;
  }

  // "Application streams" are every stream Discord knows about; "active" ones are only those we
  // have joined as a viewer, so use the former to see who is live.
  function streamsIn(channelId) {
    const known = (safe(() => S.Streaming.getAllApplicationStreamsForChannel(channelId), []) || []).filter(Boolean);
    const seen = new Set(known.map((st) => st.ownerId));
    // Voice states are the ground truth when the streaming store lags behind.
    const ch = S.Channel.getChannel(channelId);
    const states = safe(() => S.Voice.getVoiceStatesForChannel(channelId), {}) || {};
    for (const vs of Object.values(states)) {
      if (vs.selfStream && !seen.has(vs.userId)) known.push({ streamType: ch && ch.guild_id ? "guild" : "call", ownerId: vs.userId, guildId: ch ? ch.guild_id || null : null, channelId });
    }
    return known;
  }
  function streamKey(st) {
    return st.guildId ? `guild:${st.guildId}:${st.channelId}:${st.ownerId}` : `call:${st.channelId}:${st.ownerId}`;
  }
  function voiceUsersIn(channelId, guildId) {
    const states = safe(() => S.Voice.getVoiceStatesForChannel(channelId), {}) || {};
    const live = new Set(streamsIn(channelId).map((st) => st.ownerId));
    return Object.values(states).map((vs) => {
      const u = S.User.getUser(vs.userId);
      return {
        ...userInfo(u, guildId || null),
        mute: !!(vs.mute || vs.selfMute),
        deaf: !!(vs.deaf || vs.selfDeaf),
        speaking: !!safe(() => S.Speaking.isSpeaking(vs.userId), false),
        video: !!vs.selfVideo,
        streaming: live.has(vs.userId),
      };
    });
  }
  // What we are watching: a camera we focused, or someone else's stream (from the RTC store).
  let watchTarget = null; // { kind: "stream" | "camera", id, name, channelId }
  function watchingStream() {
    if (watchTarget && watchTarget.kind === "camera") {
      return { key: `camera:${watchTarget.channelId}:${watchTarget.id}`, ownerId: watchTarget.id, name: watchTarget.name, frames: true, camera: true };
    }
    const me = currentUser();
    const keys = safe(() => S.StreamRTC.getAllActiveStreamKeys(), []) || [];
    for (const k of keys) {
      const ownerId = k.split(":").pop();
      if (me && ownerId === me.id) continue;
      const u = S.User.getUser(ownerId);
      return { key: k, ownerId, name: u ? u.globalName || u.username : ownerId, frames: watchKey === k };
    }
    return null;
  }

  function voiceState() {
    const cid = safe(() => S.SelChan.getVoiceChannelId());
    const ch = cid ? S.Channel.getChannel(cid) : null;
    const guild = ch && ch.guild_id ? S.Guild.getGuild(ch.guild_id) : null;
    return {
      channelId: cid || null,
      channelName: ch ? channelDisplayName(ch) : null,
      guildId: ch ? ch.guild_id || null : null,
      guildName: guild ? guild.name : null,
      mute: !!safe(() => S.Media.isSelfMute(), false),
      deaf: !!safe(() => S.Media.isSelfDeaf(), false),
      video: !!safe(() => S.Media.isVideoEnabled(), false),
      streaming: !!safe(() => S.Streaming.getCurrentUserActiveStream(), null),
      rtcState: safe(() => S.RTC.getState(), null),
      users: cid ? voiceUsersIn(cid, ch ? ch.guild_id : null) : [],
      // DM/group calls: no guild; `ringing` lists who we are still calling.
      isCall: !!ch && !ch.guild_id,
      ringing: ch && !ch.guild_id ? (safe(() => S.Call.getCall(cid)?.ringing, []) || []).length : 0,
      watching: watchingStream(),
    };
  }

  // ---- Frame capture: the backend pulls JPEG frames of the watched stream's <video> ----
  // Pull (not push) so a slow consumer never builds up a queue of stale frames.
  let frameCanvas = null;
  let watchKey = null; // stream key we asked to watch
  function localTrackIds() {
    const ids = new Set();
    for (const pc of window.__dcPCs || []) {
      try { for (const s of pc.getSenders()) if (s.track) ids.add(s.track.id); } catch (e) { /* ignore */ }
    }
    return ids;
  }
  function pickVideo() {
    // Largest playing remote video on the page; skip our own screen-share/camera previews.
    const local = localTrackIds();
    let best = null;
    for (const v of document.querySelectorAll("video")) {
      if (!v.srcObject || v.readyState < 2 || !v.videoWidth) continue;
      const track = v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
      if (!track || track.readyState !== "live") continue;
      if (local.has(track.id) || /screen|window|camera|deckycord|loopback|virtual|monitor/i.test(track.label || "")) continue;
      if (!best || v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight) best = v;
    }
    return best;
  }
  // Discord does not auto-play a stream in the call view; it shows a paused preview with a
  // "Watch Stream" button (and shows it again if it decides the view lost focus). Click it.
  function clickWatchButton() {
    const b = [...document.querySelectorAll('button, [role="button"]')].find((e) => /^watch stream$/i.test((e.textContent || "").trim()));
    if (!b) return false;
    b.click();
    return true;
  }
  function grabFrame(opts) {
    opts = opts || {};
    const v = pickVideo();
    if (!v) { clickWatchButton(); return null; }
    const maxW = opts.maxWidth || 1280;
    const quality = opts.quality || 0.6;
    frameCanvas = frameCanvas || document.createElement("canvas");
    const ctx = frameCanvas.getContext("2d", { alpha: false });
    const scale = Math.min(1, maxW / v.videoWidth);
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    if (frameCanvas.width !== w || frameCanvas.height !== h) { frameCanvas.width = w; frameCanvas.height = h; }
    ctx.drawImage(v, 0, 0, w, h);
    const url = frameCanvas.toDataURL("image/jpeg", quality);
    return url.slice(url.indexOf(",") + 1);
  }

  // Calls ringing us in DMs/group DMs that we have not joined.
  function incomingCalls() {
    const me = currentUser();
    if (!me) return [];
    const cur = safe(() => S.SelChan.getVoiceChannelId());
    const calls = safe(() => S.Call.getCalls(), []) || [];
    return calls.filter((c) => c && !c.unavailable && (c.ringing || []).includes(me.id) && c.channelId !== cur).map((c) => {
      const ch = S.Channel.getChannel(c.channelId);
      if (!ch || (ch.type !== 1 && ch.type !== 3)) return null;
      return {
        channelId: c.channelId,
        name: channelDisplayName(ch),
        icon: channelIcon(ch),
        group: ch.type === 3,
        users: voiceUsersIn(c.channelId, null).map((u) => u.name),
      };
    }).filter(Boolean);
  }

  const api = {
    v: VERSION,
    state() {
      const me = currentUser();
      const onLogin = location.pathname.startsWith("/login") || location.pathname.startsWith("/register");
      return {
        loggedIn: !!me && !onLogin,
        path: location.pathname,
        user: userInfo(me, null),
        voice: voiceState(),
        calls: incomingCalls(),
      };
    },
    stores() {
      const out = {};
      for (const k of Object.keys(storeNames)) out[k] = !!S[k];
      return out;
    },
    qrRect() {
      const el = document.querySelector('[class*="qrCode"] img, [class*="qrCode"] canvas, [class*="qrCode"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    dms() {
      let ids = safe(() => S.PrivSort.getPrivateChannelIds(), null);
      if (!ids || !ids.length) ids = (safe(() => S.Channel.getSortedPrivateChannels(), []) || []).map((ch) => ch.id);
      return ids.map((id) => S.Channel.getChannel(id)).filter(Boolean).map((ch) => ({
        id: ch.id,
        type: ch.type,
        name: channelDisplayName(ch),
        icon: channelIcon(ch),
        unread: !!safe(() => S.ReadState.hasUnread(ch.id), false),
        mentions: safe(() => S.ReadState.getMentionCount(ch.id), 0) || 0,
        lastMessageId: str(ch.lastMessageId),
        call: !!safe(() => S.Call.isCallActive(ch.id), false) || Object.keys(safe(() => S.Voice.getVoiceStatesForChannel(ch.id), {}) || {}).length > 0,
      }));
    },
    // Ongoing call in a DM / group DM: who is in it and whether we are.
    dmCall(channelId) {
      const users = voiceUsersIn(channelId, null);
      const cur = safe(() => S.SelChan.getVoiceChannelId());
      return {
        active: !!safe(() => S.Call.isCallActive(channelId), false) || users.length > 0,
        inCall: cur === channelId,
        ringing: (safe(() => S.Call.getCall(channelId)?.ringing, []) || []).length,
        users,
      };
    },
    guilds() {
      const ids = safe(() => S.SortedGuild.getFlattenedGuildIds(), null) || safe(() => S.Guild.getGuildIds(), []);
      // Guild.getIconURL's signature has changed across client builds; build the CDN URL ourselves.
      const iconUrl = (g) => (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${g.icon.startsWith("a_") ? "gif" : "webp"}?size=64` : null);
      return ids.map((id) => S.Guild.getGuild(id)).filter(Boolean).map((g) => ({
        id: g.id,
        name: g.name,
        icon: iconUrl(g) || safe(() => g.getIconURL(64, false)) || null,
      }));
    },
    channels(guildId) {
      const all = safe(() => S.GuildChan.getChannels(guildId), {}) || {};
      const map = (list) => (list || []).map((e) => e.channel).filter(Boolean);
      const catName = (ch) => (ch.parent_id ? safe(() => S.Channel.getChannel(ch.parent_id)?.name) : null);
      const text = map(all.SELECTABLE).map((ch) => ({
        id: ch.id,
        name: ch.name,
        category: catName(ch),
        unread: !!safe(() => S.ReadState.hasUnread(ch.id), false),
        mentions: safe(() => S.ReadState.getMentionCount(ch.id), 0) || 0,
      }));
      const voice = map(all.VOCAL).map((ch) => ({
        id: ch.id,
        name: ch.name,
        category: catName(ch),
        users: voiceUsersIn(ch.id, guildId),
      }));
      return { text, voice };
    },
    channelInfo(channelId) {
      const ch = S.Channel.getChannel(channelId);
      if (!ch) return null;
      return { id: ch.id, name: channelDisplayName(ch), guildId: ch.guild_id || null, type: ch.type };
    },
    async messages(channelId, limit) {
      limit = limit || 50;
      let coll = S.Message.getMessages(channelId);
      let arr = coll ? coll.toArray() : [];
      if (arr.length < limit && (!coll || coll.hasMoreBefore !== false || !coll.ready)) {
        try { await MsgActions.fetchMessages({ channelId, limit }); } catch (e) { /* ignore */ }
        coll = S.Message.getMessages(channelId);
        arr = coll ? coll.toArray() : [];
      }
      const ch = S.Channel.getChannel(channelId);
      const gid = ch ? ch.guild_id || null : null;
      return arr.slice(-limit).map((m) => ({
        id: m.id,
        author: userInfo(m.author, gid),
        content: m.content || "",
        timestamp: m.timestamp ? (m.timestamp.toISOString ? m.timestamp.toISOString() : String(m.timestamp)) : null,
        attachments: (m.attachments || []).map((a) => ({ url: a.url, name: a.filename, type: a.content_type || null })),
        embeds: (m.embeds || []).length,
        type: m.type,
        stickers: (m.stickerItems || m.sticker_items || []).map((s) => s.name),
      }));
    },
    async older(channelId, beforeId, limit) {
      limit = limit || 50;
      try { await MsgActions.fetchMessages({ channelId, before: beforeId, limit }); } catch (e) { /* ignore */ }
      const coll = S.Message.getMessages(channelId);
      const arr = coll ? coll.toArray() : [];
      return { messages: await api.messages(channelId, arr.length || limit), hasMore: coll ? coll.hasMoreBefore !== false : false };
    },
    async send(channelId, text) {
      // signature: sendMessage(channelId, message, waitForChannelReady = true, options = {nonce?...})
      const r = await MsgActions.sendMessage(channelId, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, true, {});
      return r && r.ok !== undefined ? !!r.ok : true;
    },
    ack(channelId) {
      try { if (AckActions.ack) AckActions.ack(channelId); return true; } catch (e) { return false; }
    },
    joinVoice(channelId) { ChanActions.selectVoiceChannel(channelId); return true; },
    leaveVoice() { ChanActions.selectVoiceChannel(null); return true; },
    // ---- Watching streams ----
    streams(channelId) {
      const cid = channelId || safe(() => S.SelChan.getVoiceChannelId());
      if (!cid) return [];
      const me = currentUser();
      const ch = S.Channel.getChannel(cid);
      return streamsIn(cid).filter((st) => !me || st.ownerId !== me.id).map((st) => ({
        key: streamKey(st),
        ownerId: st.ownerId,
        owner: userInfo(S.User.getUser(st.ownerId), ch ? ch.guild_id : null),
        channelId: st.channelId,
        guildId: st.guildId || null,
        viewers: (safe(() => S.Streaming.getViewerIds(streamKey(st)), []) || []).length,
      }));
    },
    async watchStream(ownerId, opts) {
      opts = opts || {};
      const cid = safe(() => S.SelChan.getVoiceChannelId());
      if (!cid) return { ok: false, error: "not in a voice channel" };
      const st = safe(() => S.Streaming.getAnyStreamForUser(ownerId)) || streamsIn(cid).find((x) => x.ownerId === ownerId);
      if (!st || st.channelId !== cid) {
        // No stream: maybe a camera. Focus that participant so their video is the big tile.
        const vs = Object.values(safe(() => S.Voice.getVoiceStatesForChannel(cid), {}) || {}).find((x) => x.userId === ownerId);
        if (!vs || !vs.selfVideo) return { ok: false, error: "that user is not streaming or on camera here" };
        const ch = S.Channel.getChannel(cid);
        const u = S.User.getUser(ownerId);
        try { C.NavigationRouter.transitionTo(`/channels/${ch && ch.guild_id ? ch.guild_id : "@me"}/${cid}`); } catch (e) { /* ignore */ }
        const cur = watchingStream();
        if (cur && !cur.camera) { const close = closeStreamFn(); if (close) safe(() => close(cur.key, false)); }
        try { RtcLayout.selectParticipant(cid, ownerId); } catch (e) { /* ignore */ }
        watchTarget = { kind: "camera", id: ownerId, name: u ? u.globalName || u.username : ownerId, channelId: cid };
        watchKey = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && !pickVideo()) { clickWatchButton(); await new Promise((r) => setTimeout(r, 400)); }
        const v = pickVideo();
        return { ok: !!v, camera: true, error: v ? undefined : "camera video did not appear", width: v ? v.videoWidth : 0, height: v ? v.videoHeight : 0 };
      }
      const watch = watchStreamFn();
      if (!watch) return { ok: false, error: "watch action not found" };
      const key = streamKey(st);
      const cur = watchingStream();
      // Show the call view in Vesktop so the stream's <video> element exists to capture from.
      try { C.NavigationRouter.transitionTo(`/channels/${st.guildId || "@me"}/${st.channelId}`); } catch (e) { /* ignore */ }
      if (!cur || cur.key !== key) {
        if (cur) { const close = closeStreamFn(); if (close) safe(() => close(cur.key, false)); }
        watch(st, { forceFocus: true });
      }
      try { RtcLayout.selectParticipant(st.channelId, key); } catch (e) { /* ignore */ }
      watchKey = key;
      watchTarget = { kind: "stream", id: ownerId, name: "", channelId: st.channelId };
      // Wait for the first playable video element, pressing "Watch Stream" whenever it shows.
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !pickVideo()) { clickWatchButton(); await new Promise((r) => setTimeout(r, 400)); }
      const v = pickVideo();
      return { ok: !!v, error: v ? undefined : "stream video did not appear", width: v ? v.videoWidth : 0, height: v ? v.videoHeight : 0, key: streamKey(st) };
    },
    stopWatching() {
      watchKey = null;
      const w = watchingStream();
      if (w && w.camera) { safe(() => RtcLayout.selectParticipant(w.key.split(":")[1], null)); }
      else if (w) { const close = closeStreamFn(); if (close) safe(() => close(w.key, false)); }
      watchTarget = null;
      return true;
    },
    grabFrame(opts) { return grabFrame(opts); },
    // ---- DM calls ----
    incomingCalls() { return incomingCalls(); },
    startCall(channelId) {
      const ch = S.Channel.getChannel(channelId);
      if (!ch || (ch.type !== 1 && ch.type !== 3)) return { ok: false, error: "not a DM channel" };
      CallActions.call(channelId, false, true);
      return { ok: true, voice: voiceState() };
    },
    acceptCall(channelId) {
      ChanActions.selectVoiceChannel(channelId);
      return { ok: true, voice: voiceState() };
    },
    async declineCall(channelId) {
      const me = currentUser();
      try { await CallActions.stopRinging(channelId, me ? [me.id] : []); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
    },
    toggleMute() { MediaActions.toggleSelfMute(); return voiceState(); },
    toggleDeaf() { MediaActions.toggleSelfDeaf(); return voiceState(); },
    setMute(b) { MediaActions.setSelfMute(!!b); return voiceState(); },
    voice() { return voiceState(); },
    videoEnabled() { return !!safe(() => S.Media.isVideoEnabled(), false); },
    async startShare() {
      // Wait for the virtual camera to show up, select it, and turn video on.
      const isVirtual = (d) => /deckycord|obs virtual|loopback|dummy/i.test(d.name || "");
      const real = (d) => d && d.id && d.id !== "default" && !/no video devices/i.test(d.name || "");
      const pick = (devs) => devs.find(isVirtual) || devs.find(real) || null;
      let dev = null;
      for (let i = 0; i < 30 && !dev; i++) {
        // The store's list is cached; ask the media engine for a live enumeration too.
        let live = [];
        try { const r = S.Media.getMediaEngine().getVideoInputDevices(); live = Object.values((r && r.then ? await r : r) || {}); } catch (e) { live = []; }
        if (!live.length) {
          try {
            const bl = await navigator.mediaDevices.enumerateDevices();
            live = bl.filter((x) => x.kind === "videoinput").map((x) => ({ id: x.deviceId, name: x.label }));
          } catch (e) { /* ignore */ }
        }
        dev = pick(live.filter(real)) || pick(Object.values(safe(() => S.Media.getVideoDevices(), {}) || {}).filter(real));
        if (!dev) await new Promise((r) => setTimeout(r, 500));
      }
      if (!dev) return { ok: false, error: "virtual camera not visible to Discord" };
      MediaActions.setVideoDevice(dev.id);
      MediaActions.setVideoEnabled(true);
      return { ok: true, device: dev.name };
    },
    stopShare() { MediaActions.setVideoEnabled(false); return true; },

    // ---- Go Live via Vesktop's screen share picker (driven through the DOM) ----
    // Discord's voice panel action row is [camera, screen share, activities, soundboard]; only the
    // soundboard button carries an aria-label, so locate the row through it.
    _panelButtons() {
      const sb = document.querySelector('button[aria-label="Open Soundboard"]');
      if (!sb) return [];
      let row = sb.parentElement;
      while (row && row.querySelectorAll("button").length < 3) row = row.parentElement;
      return row ? [...row.querySelectorAll("button")] : [];
    },
    _screenShareButton() {
      const labeled = document.querySelector('button[aria-label="Share Your Screen"], button[aria-label="Stop Streaming"]');
      if (labeled) return labeled;
      const btns = api._panelButtons();
      return btns.length >= 2 ? btns[1] : null;
    },
    async goLive(opts) {
      opts = opts || {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150); } return null; };
      const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
      const textOf = (e) => (e.textContent || "").trim();
      const findText = (root, sel, re) => [...root.querySelectorAll(sel)].find((e) => re.test(textOf(e)));
      const dismissOthers = () => {
        for (const d of dialogs()) {
          if (/Screen Share Picker/i.test(textOf(d))) continue;
          // Only ever press explicit close / "no" buttons: never anything that could accept an offer.
          const close = d.querySelector('[aria-label="Close"]') || findText(d, "button", /^(Don't Switch|Dismiss|Close|Not now|No thanks|Skip|Don't show again)$/i);
          if (close) close.click();
        }
      };
      if (!opts.pickerOnly) {
        if (safe(() => S.Streaming.getCurrentUserActiveStream())) return { ok: true, already: true };
        if (!safe(() => S.SelChan.getVoiceChannelId())) return { ok: false, error: "not in a voice channel" };
      }
      dismissOthers();
      await sleep(300);
      let picker = dialogs().find((d) => /Screen Share Picker/i.test(textOf(d)));
      if (!picker && !opts.pickerOnly) {
        const btn = api._screenShareButton();
        if (!btn) return { ok: false, error: "Share Your Screen button not found" };
        btn.click();
      }
      picker = picker || await waitFor(() => dialogs().find((d) => /Screen Share Picker/i.test(textOf(d))), 8000);
      if (!picker) return { ok: false, error: "picker did not open" };
      // Page 1: choose the viewer window if present, else the entire screen.
      const labels = await waitFor(() => { const l = [...picker.querySelectorAll(".vcd-screen-picker-screen-label, label")]; return l.length ? l : null; }, 5000);
      if (!labels) return { ok: false, error: "no sources listed" };
      const want = opts.source || "viewer";
      const names = labels.map(textOf);
      let pick = null;
      if (want === "viewer") pick = labels.find((l) => /gst|viewer|deckycord/i.test(textOf(l)));
      if (!pick) pick = labels.find((l) => /entire screen/i.test(textOf(l))) || labels[0];
      pick.click();
      await sleep(400);
      // Page 2: quality + audio.
      const clickRadio = (re) => {
        const l = [...picker.querySelectorAll("label")].find((x) => re.test(textOf(x)));
        if (!l) return false;
        const i = l.querySelector("input");
        if (i && !i.checked) { l.click(); if (!i.checked) i.click(); }
        return true;
      };
      const res = String(opts.resolution || 1080), fps = String(opts.fps || 60);
      await waitFor(() => findText(picker, "label", new RegExp("^" + res + "$")), 3000);
      clickRadio(new RegExp("^" + res + "$"));
      clickRadio(new RegExp("^" + fps + "$"));
      clickRadio(/prefer smoothness/i);
      let audio = "none";
      if (opts.audio !== false) {
        const dd = [...picker.querySelectorAll('[role="button"]')].find((e) => /^(None|Entire System)$/i.test(textOf(e)) || /audio/i.test(e.getAttribute("aria-label") || ""));
        if (dd) {
          dd.click();
          const opt = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find((o) => /entire system/i.test(textOf(o))), 2500);
          if (opt) { opt.click(); audio = "system"; } else { dd.click(); }
          await sleep(300);
        }
      }
      const go = findText(picker, "button", /^go live$/i);
      if (!go) return { ok: false, error: "Go Live button not found", names };
      go.click();
      if (opts.pickerOnly) return { ok: true, picked: textOf(pick), names, audio };
      const live = await waitFor(() => safe(() => S.Streaming.getCurrentUserActiveStream()), 15000);
      const settings = safe(() => findStore("ApplicationStreamingSettingsStore").getState(), null);
      return { ok: !!live, error: live ? undefined : "stream did not start", picked: textOf(pick), names, audio, settings };
    },
    async stopGoLive() {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const active = () => safe(() => S.Streaming.getCurrentUserActiveStream());
      if (!active()) return true;
      const labeled = [...document.querySelectorAll("button[aria-label]")].find((b) => /stop (streaming|sharing)|end stream/i.test(b.getAttribute("aria-label") || ""));
      const btn = labeled || api._screenShareButton();
      if (btn) btn.click();
      for (let i = 0; i < 20 && active(); i++) {
        // A confirmation or menu may appear; take any "Stop Streaming" entry.
        const item = [...document.querySelectorAll('button, [role="menuitem"]')].find((e) => /stop streaming|stop sharing/i.test((e.textContent || "").trim()));
        if (item) item.click();
        await sleep(250);
      }
      return !active();
    },
    setBitrate(start, min, max) { window.__dcBitrate = { start, min, max }; return window.__dcBitrate; },
    async rtcStats() {
      // Requires the RTCPeerConnection hook below to have caught the stream's connection.
      const pcs = (window.__dcPCs || []).filter((pc) => pc.connectionState !== "closed");
      const out = [];
      for (const pc of pcs) {
        try {
          const rep = await pc.getStats();
          const rows = [];
          rep.forEach((r) => {
            if (r.type === "outbound-rtp" && r.kind === "video") rows.push({ type: r.type, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, encoded: r.framesEncoded, bytes: r.bytesSent, target: r.targetBitrate, limit: r.qualityLimitationReason, limitDur: r.qualityLimitationDurations, codec: r.codecId, resChanges: r.qualityLimitationResolutionChanges, encMs: r.totalEncodeTime, encoder: r.encoderImplementation, pli: r.pliCount, nack: r.nackCount });
            if (r.type === "candidate-pair" && r.state === "succeeded") rows.push({ type: r.type, rtt: r.currentRoundTripTime, availOut: r.availableOutgoingBitrate, lost: r.packetsLost });
            if (r.type === "remote-inbound-rtp" && r.kind === "video") rows.push({ type: r.type, lossFrac: r.fractionLost, lost: r.packetsLost, jitter: r.jitter, rtt: r.roundTripTime });
            if (r.type === "codec" ) rows.push({ type: r.type, id: r.id, mime: r.mimeType });
          });
          out.push({ state: pc.connectionState, rows });
        } catch (e) { out.push({ error: String(e) }); }
      }
      return out;
    },
    cancelPicker() {
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        if (/Screen Share Picker/i.test(d.textContent || "")) { const c = [...d.querySelectorAll("button")].find((b) => /^cancel$/i.test((b.textContent || "").trim())) || d.querySelector('[aria-label="Close"]'); if (c) c.click(); }
      }
      return true;
    },
    friends() {
      const ids = safe(() => S.Relationship.getFriendIDs(), []) || [];
      return ids.map((id) => {
        const u = S.User.getUser(id);
        return u ? { ...userInfo(u, null), status: safe(() => S.Presence.getStatus(id), "offline") } : null;
      }).filter(Boolean);
    },
    // Pending relationships: type 3 = incoming request, 4 = outgoing. `since` is when it arrived.
    friendRequests() {
      const rels = safe(() => S.Relationship.getMutableRelationships(), null) || {};
      const entries = rels instanceof Map ? [...rels.entries()] : Object.entries(rels);
      const incoming = [], outgoing = [];
      for (const [id, t] of entries) {
        const type = t && typeof t === "object" ? t.type : t;
        if (type !== 3 && type !== 4) continue;
        const u = S.User.getUser(id);
        if (!u) continue;
        (type === 3 ? incoming : outgoing).push({ ...userInfo(u, null), since: str(safe(() => S.Relationship.getSince(id))) });
      }
      return { incoming, outgoing };
    },
    async acceptFriend(userId) {
      await RelActions.acceptFriendRequest({ userId, context: relCtx });
      return true;
    },
    // Declines an incoming request or cancels an outgoing one.
    async declineFriend(userId) {
      const type = safe(() => S.Relationship.getRelationshipType(userId));
      if (type === 4 && RelActions.cancelFriendRequest) await RelActions.cancelFriendRequest({ userId, context: relCtx });
      else await RelActions.removeRelationship(userId, relCtx);
      return true;
    },
    async sendFriendRequest(username) {
      const tag = String(username || "").trim().replace(/^@/, "");
      if (!tag) return { ok: false, error: "empty username" };
      try {
        await RelActions.sendRequest({ discordTag: tag, context: relCtx });
        return { ok: true };
      } catch (e) {
        const msg = (e && (e.body && (e.body.message || (e.body.errors && JSON.stringify(e.body.errors))) || e.message)) || String(e);
        return { ok: false, error: msg };
      }
    },
    async openDM(userId) {
      const existing = safe(() => S.Channel.getDMFromUserId(userId));
      if (existing) return existing;
      const mod = byProps("openPrivateChannel");
      if (mod) { const cid = await mod.openPrivateChannel(userId); return cid; }
      return null;
    },
  };

  // Push events to the backend through the CDP binding (if installed).
  const emit = (ev) => { try { if (window.__dcEvent) window.__dcEvent(JSON.stringify(ev)); } catch (e) { /* ignore */ } };
  // Decide whether an incoming message deserves a Steam notification (DM, or a mention, and not muted).
  function describeIncoming(p) {
    const m = p.message;
    if (!m) return null;
    if (m.type === 3) return null; // "started a call" system message; the call event covers it
    const me = currentUser();
    const authorId = m.author && m.author.id;
    if (me && authorId === me.id) return null;
    const ch = S.Channel.getChannel(p.channelId);
    const isDM = !!ch && (ch.type === 1 || ch.type === 3);
    const mentionsMe = !!me && (
      (m.mentions || []).some((u) => (u && (u.id || u)) === me.id) ||
      !!(m.mention_everyone || m.mentionEveryone)
    );
    const guildId = ch ? ch.guild_id || null : null;
    const muted = !!safe(() => guildId && C.UserGuildSettingsStore.isGuildOrCategoryOrChannelMuted(guildId, p.channelId), false)
      || !!safe(() => C.UserGuildSettingsStore.isChannelMuted(guildId, p.channelId), false);
    const guild = guildId ? S.Guild.getGuild(guildId) : null;
    const author = m.author ? (m.author.global_name || m.author.globalName || m.author.username) : "Someone";
    let content = m.content || "";
    if (!content && (m.attachments || []).length) content = "[attachment]";
    if (!content && (m.sticker_items || m.stickerItems || []).length) content = "[sticker]";
    if (!content && (m.embeds || []).length) content = "[embed]";
    return {
      type: "message",
      channelId: p.channelId,
      id: m.id,
      authorId,
      author,
      avatar: safe(() => S.User.getUser(authorId)?.getAvatarURL(null, 64, false)) || null,
      where: isDM ? (ch.type === 3 ? channelDisplayName(ch) : null) : `#${ch ? ch.name : "?"}${guild ? " \u00b7 " + guild.name : ""}`,
      content: content.slice(0, 160),
      notify: !muted && (isDM || mentionsMe),
      dm: isDM,
    };
  }

  function userStreaming(ownerId, channelId) {
    if (safe(() => S.Streaming.getAnyStreamForUser(ownerId))) return true;
    const states = safe(() => S.Voice.getVoiceStatesForChannel(channelId), {}) || {};
    return Object.values(states).some((vs) => vs.userId === ownerId && vs.selfStream);
  }
  // Someone (not us) in our voice channel started/stopped a stream. STREAM_DELETE also fires when
  // our own viewer session is torn down (e.g. re-watching), so "stopped" is checked against the
  // owner's actual state.
  function describeStream(p, live) {
    const key = p && p.streamKey;
    if (!key) return null;
    const parts = key.split(":");
    const ownerId = parts[parts.length - 1];
    const channelId = parts[parts.length - 2];
    const me = currentUser();
    if (me && ownerId === me.id) return null;
    if (channelId !== safe(() => S.SelChan.getVoiceChannelId())) return null;
    if (!live && userStreaming(ownerId, channelId)) return null;
    const u = S.User.getUser(ownerId);
    return { type: "stream", live, ownerId, channelId, name: u ? u.globalName || u.username : "Someone", avatar: safe(() => u.getAvatarURL(null, 64, false)) || null };
  }

  let lastVoiceMembers = null;
  function diffVoiceMembers() {
    const cid = safe(() => S.SelChan.getVoiceChannelId());
    if (!cid) { lastVoiceMembers = null; return null; }
    const me = currentUser();
    const now = voiceUsersIn(cid, safe(() => S.Channel.getChannel(cid)?.guild_id));
    const ids = new Set(now.map((u) => u.id));
    const out = { type: "voice_member", joined: [], left: [] };
    if (lastVoiceMembers && lastVoiceMembers.cid === cid) {
      for (const u of now) if (!lastVoiceMembers.ids.has(u.id) && (!me || u.id !== me.id)) out.joined.push(u.name);
      for (const [id, name] of lastVoiceMembers.names) if (!ids.has(id) && (!me || id !== me.id)) out.left.push(name);
    }
    lastVoiceMembers = { cid, ids, names: new Map(now.map((u) => [u.id, u.name])) };
    return out.joined.length || out.left.length ? out : null;
  }

  // Announce a ringing call once per channel; CALL_UPDATE fires repeatedly while it rings.
  const announcedCalls = new Set();
  function onCallChange() {
    emit({ type: "voice" });
    const calls = incomingCalls();
    const live = new Set(calls.map((c) => c.channelId));
    for (const c of calls) {
      if (announcedCalls.has(c.channelId)) continue;
      announcedCalls.add(c.channelId);
      emit({ type: "call", ringing: true, ...c });
    }
    for (const id of [...announcedCalls]) {
      if (!live.has(id)) { announcedCalls.delete(id); emit({ type: "call", ringing: false, channelId: id }); }
    }
  }

  const subs = {
    MESSAGE_CREATE: (p) => { const d = describeIncoming(p); if (d) emit(d); },
    CALL_CREATE: onCallChange,
    CALL_UPDATE: onCallChange,
    CALL_DELETE: onCallChange,
    MESSAGE_ACK: (p) => emit({ type: "ack", channelId: p.channelId }),
    VOICE_STATE_UPDATES: () => { emit({ type: "voice" }); const d = diffVoiceMembers(); if (d) emit(d); if (announcedCalls.size) onCallChange(); },
    SPEAKING: (p) => emit({ type: "speaking", userId: p.userId, speaking: !!(p.speakingFlags & 1) }),
    RTC_CONNECTION_STATE: (p) => emit({ type: "rtc", state: p.state }),
    AUDIO_TOGGLE_SELF_MUTE: () => emit({ type: "voice" }),
    AUDIO_TOGGLE_SELF_DEAF: () => emit({ type: "voice" }),
    MEDIA_ENGINE_SET_VIDEO_ENABLED: () => emit({ type: "voice" }),
    STREAM_CREATE: (p) => { emit({ type: "voice" }); const d = describeStream(p, true); if (d) emit(d); },
    STREAM_DELETE: (p) => {
      emit({ type: "voice" });
      const d = describeStream(p, false);
      if (d) emit(d);
      if (watchKey && p && p.streamKey === watchKey && !userStreaming(watchKey.split(":").pop(), watchKey.split(":").slice(-2)[0])) { watchKey = null; emit({ type: "frames", state: "no-video" }); }
    },
    RELATIONSHIP_ADD: (p) => {
      const r = p && p.relationship;
      emit({ type: "friends" });
      if (r && r.type === 3) { const u = S.User.getUser(r.id) || r.user; if (u) emit({ type: "friend_request", ...userInfo(u, null) }); }
    },
    RELATIONSHIP_UPDATE: () => emit({ type: "friends" }),
    RELATIONSHIP_REMOVE: () => emit({ type: "friends" }),
    CONNECTION_OPEN: () => emit({ type: "login" }),
    LOGOUT: () => emit({ type: "logout" }),
  };
  if (Dispatcher) {
    if (window.__dcSubs) for (const [k, f] of Object.entries(window.__dcSubs)) safe(() => Dispatcher.unsubscribe(k, f));
    for (const [k, f] of Object.entries(subs)) safe(() => Dispatcher.subscribe(k, f));
    window.__dcSubs = subs;
  }
  // Catch peer connections as Discord creates them, and nudge WebRTC's bandwidth estimator:
  // by default it starts around 300 kbps and ramps slowly, which makes screen shares start as a
  // 320x180 smear. x-google-* fmtp params set the encoder's start/min/max bitrate (kbps).
  // Floor low enough that a bandwidth dip (e.g. a game switch) degrades gracefully instead of
  // the estimator fighting an impossible minimum.
  window.__dcBitrate = window.__dcBitrate || { start: 3500, min: 1000, max: 8000 };
  const mungeSdp = (sdp) => {
    try {
      const b = window.__dcBitrate;
      const lines = sdp.split("\r\n");
      const videoPts = new Set();
      let inVideo = false;
      for (const l of lines) {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        if (inVideo) { const m = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)/i.exec(l); if (m) videoPts.add(m[1]); }
      }
      if (!videoPts.size) return sdp;
      const out = [];
      inVideo = false;
      const seenFmtp = new Set();
      for (let l of lines) {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        if (inVideo) {
          if (l.startsWith("b=AS:")) continue; // drop bandwidth caps
          const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
          if (m && videoPts.has(m[1])) {
            seenFmtp.add(m[1]);
            let params = m[2].replace(/;?x-google-(start|min|max)-bitrate=\d+/g, "");
            l = `a=fmtp:${m[1]} ${params};x-google-start-bitrate=${b.start};x-google-min-bitrate=${b.min};x-google-max-bitrate=${b.max}`;
          }
        }
        out.push(l);
      }
      // Codecs without an fmtp line get one.
      const res = [];
      inVideo = false;
      for (const l of out) {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        res.push(l);
        const m = inVideo && /^a=rtpmap:(\d+) /.exec(l);
        if (m && videoPts.has(m[1]) && !seenFmtp.has(m[1])) res.push(`a=fmtp:${m[1]} x-google-start-bitrate=${b.start};x-google-min-bitrate=${b.min};x-google-max-bitrate=${b.max}`);
      }
      return res.join("\r\n");
    } catch (e) { return sdp; }
  };
  const HOOK_VERSION = 4;
  if (window.__dcPCHook !== HOOK_VERSION && window.RTCPeerConnection) {
    window.__dcPCs = window.__dcPCs || [];
    const proto = RTCPeerConnection.prototype;
    window.__dcPCOrig = window.__dcPCOrig || {};
    for (const name of ["setLocalDescription", "setRemoteDescription"]) {
      // Always wrap the pristine original so re-installs don't stack wrappers.
      const orig = window.__dcPCOrig[name] || (window.__dcPCOrig[name] = proto[name]);
      proto[name] = function (desc, ...rest) {
        if (!window.__dcPCs.includes(this)) window.__dcPCs.push(this);
        if (desc && typeof desc.sdp === "string" && window.__dcBitrate) {
          desc = { type: desc.type, sdp: mungeSdp(desc.sdp) };
        }
        const pc = this;
        const p = orig.call(this, desc, ...rest);
        // "balanced": under a bandwidth dip trade resolution and frame rate together. Holding
        // 720p ("maintain-resolution") turned every dip into a 1 fps slideshow for viewers.
        if (name === "setRemoteDescription") Promise.resolve(p).then(() => {
          for (const s of pc.getSenders()) {
            if (!s.track || s.track.kind !== "video") continue;
            try { const prm = s.getParameters(); if (prm.degradationPreference !== "balanced") { prm.degradationPreference = "balanced"; s.setParameters(prm).catch(() => {}); } } catch (e) { /* ignore */ }
          }
        }).catch(() => {});
        return p;
      };
    }
    window.__dcPCHook = HOOK_VERSION;
  }
  window.__dc = api;
  return "installed";
})()
