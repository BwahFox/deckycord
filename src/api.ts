import { callable } from "@decky/api";

export interface User {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  bot: boolean;
}
export interface VoiceUser extends User {
  mute: boolean;
  deaf: boolean;
  speaking: boolean;
  video: boolean;
  /** Has a Go Live stream running in this channel. */
  streaming: boolean;
}
export interface Watching {
  key: string;
  ownerId: string;
  name: string;
  frames: boolean;
  /** Watching a camera rather than a Go Live stream. */
  camera?: boolean;
}
export interface Stream {
  key: string;
  ownerId: string;
  owner: User | null;
  channelId: string;
  guildId: string | null;
  viewers: number;
}
export interface VoiceState {
  channelId: string | null;
  channelName: string | null;
  guildId: string | null;
  guildName: string | null;
  mute: boolean;
  deaf: boolean;
  video: boolean;
  streaming: boolean;
  rtcState: string | null;
  users: VoiceUser[];
  /** True when connected to a DM / group DM call rather than a server voice channel. */
  isCall: boolean;
  /** How many recipients are still being rung in our own outgoing call. */
  ringing: number;
  /** Someone else's stream we are currently watching. */
  watching: Watching | null;
}
export interface IncomingCall {
  channelId: string;
  name: string;
  icon: string | null;
  group: boolean;
  users: string[];
}
export interface Status {
  running: boolean;
  cdp: boolean;
  loggedIn: boolean;
  path?: string;
  user: User | null;
  voice: VoiceState | null;
  calls?: IncomingCall[];
  error: string | null;
  /** Suspended by the user: nothing runs until Resume. */
  suspended?: boolean;
}
export interface DM {
  id: string;
  type: number;
  name: string;
  icon: string | null;
  unread: boolean;
  mentions: number;
  lastMessageId: string | null;
  /** A call is ongoing in this DM. */
  call: boolean;
}
export interface DmCall {
  active: boolean;
  inCall: boolean;
  ringing: number;
  users: VoiceUser[];
}
export interface Guild {
  id: string;
  name: string;
  icon: string | null;
}
export interface TextChannel {
  id: string;
  name: string;
  category: string | null;
  unread: boolean;
  mentions: number;
}
export interface VoiceChannel {
  id: string;
  name: string;
  category: string | null;
  users: VoiceUser[];
}
export interface Channels {
  text: TextChannel[];
  voice: VoiceChannel[];
}
export interface Message {
  id: string;
  author: User | null;
  content: string;
  timestamp: string | null;
  attachments: { url: string; name: string; type: string | null }[];
  embeds: number;
  type: number;
  stickers: string[];
}
export interface Friend extends User {
  status: string;
}
export interface FriendRequest extends User {
  since: string | null;
}

export const api = {
  status: callable<[], Status>("status"),
  loginQr: callable<[], string | null>("login_qr"),
  startBackend: callable<[], { rc: number; out: string }>("start_backend"),
  restartBackend: callable<[], { rc: number; out: string }>("restart_backend"),
  reconnect: callable<[], { ok: boolean; error?: string; stores?: Record<string, boolean> }>("reconnect"),
  suspend: callable<[], { ok: boolean }>("suspend"),
  resume: callable<[], { ok: boolean; out: string }>("resume"),
  dms: callable<[], DM[]>("dms"),
  guilds: callable<[], Guild[]>("guilds"),
  channels: callable<[guildId: string], Channels>("channels"),
  channelInfo: callable<[channelId: string], { id: string; name: string; guildId: string | null; type: number } | null>("channel_info"),
  messages: callable<[channelId: string, limit: number], Message[]>("messages"),
  older: callable<[channelId: string, beforeId: string, limit: number], { messages: Message[]; hasMore: boolean }>("older"),
  send: callable<[channelId: string, text: string], boolean>("send"),
  ack: callable<[channelId: string], boolean>("ack"),
  friends: callable<[], Friend[]>("friends"),
  openDm: callable<[userId: string], string | null>("open_dm"),
  friendRequests: callable<[], { incoming: FriendRequest[]; outgoing: FriendRequest[] }>("friend_requests"),
  acceptFriend: callable<[userId: string], boolean>("accept_friend"),
  declineFriend: callable<[userId: string], boolean>("decline_friend"),
  sendFriendRequest: callable<[username: string], { ok: boolean; error?: string }>("send_friend_request"),
  voice: callable<[], VoiceState>("voice"),
  joinVoice: callable<[channelId: string], boolean>("join_voice"),
  leaveVoice: callable<[], boolean>("leave_voice"),
  incomingCalls: callable<[], IncomingCall[]>("incoming_calls"),
  streams: callable<[channelId?: string | null], Stream[]>("streams"),
  watchStream: callable<[ownerId: string, fps?: number, maxWidth?: number, quality?: number], { ok: boolean; error?: string; width?: number; height?: number; camera?: boolean }>("watch_stream"),
  stopWatching: callable<[], boolean>("stop_watching"),
  streamUrl: callable<[], { mjpeg: string; frame: string; frames: number }>("stream_url"),
  dmCall: callable<[channelId: string], DmCall>("dm_call"),
  startCall: callable<[channelId: string], { ok: boolean; error?: string; voice?: VoiceState }>("start_call"),
  acceptCall: callable<[channelId: string], { ok: boolean; voice?: VoiceState }>("accept_call"),
  declineCall: callable<[channelId: string], { ok: boolean; error?: string }>("decline_call"),
  toggleMute: callable<[], VoiceState>("toggle_mute"),
  toggleDeaf: callable<[], VoiceState>("toggle_deaf"),
  shareStatus: callable<[], { capturing: boolean; video: boolean; streaming: boolean; sharing: boolean }>("share_status"),
  startShare: callable<[mode?: string, resolution?: number, fps?: number], { ok: boolean; mode?: string; error?: string }>("start_share"),
  stopShare: callable<[], { ok: boolean }>("stop_share"),
  gameLaunched: callable<[appId: number, name: string], { paused: boolean }>("game_launched"),
  audioSources: callable<[], { sources: string[]; default: string | null }>("audio_sources"),
  setMic: callable<[name: string], boolean>("set_mic"),
  audioSinks: callable<[], { sinks: string[]; default: string | null }>("audio_sinks"),
  setSink: callable<[name: string], boolean>("set_sink"),
  getBalance: callable<[], Balance>("get_balance"),
  setBalance: callable<[balance: number], Balance>("set_balance"),
  getAgc: callable<[], Agc>("get_agc"),
  setAgc: callable<[enabled: boolean], Agc>("set_agc"),
  logs: callable<[n: number], string>("logs"),
};

/** Voice/game mix: -100 = voice only, 0 = both full, +100 = game only. */
export interface Balance { balance: number; voice: number; game: number }

/** agc: Discord may adjust the mic volume; applied: what the running Vesktop was launched with. */
export interface Agc { agc: boolean; applied: boolean | null }

export type DcEvent =
  | { type: "status"; state: Status }
  | { type: "message"; channelId: string; id: string; authorId: string; author: string; avatar: string | null; where: string | null; content: string; notify: boolean; dm: boolean }
  | { type: "voice_member"; joined: string[]; left: string[] }
  | ({ type: "call"; ringing: true } & IncomingCall)
  | { type: "call"; ringing: false; channelId: string }
  | { type: "stream"; live: boolean; ownerId: string; channelId: string; name: string; avatar: string | null }
  | { type: "frames"; state: string }
  | { type: "share_paused"; name: string }
  | { type: "share_resumed"; ok: boolean; error?: string; name: string }
  | { type: "ack"; channelId: string }
  | { type: "voice" }
  | { type: "speaking"; userId: string; speaking: boolean }
  | { type: "rtc"; state: string }
  | { type: "friends" }
  | ({ type: "friend_request" } & User)
  | { type: "login" }
  | { type: "logout" };
