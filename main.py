import asyncio
import base64
import json
import os
import pwd
import re
import subprocess
from typing import Any, Optional

import decky
from aiohttp import web

from cdp import CDPClient, CDPError

PLUGIN_DIR = decky.DECKY_PLUGIN_DIR
PY_DIR = os.path.join(PLUGIN_DIR, "py_modules")
BRIDGE_JS = open(os.path.join(PY_DIR, "bridge.js")).read()
CDP_PORT = 9222
# Watched streams are mirrored as MJPEG on this local port for Steam's UI to display.
FRAME_PORT = 13370

# Re-install the bridge after every navigation (login reloads the page).
ON_NEW_DOC = """
(() => {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    try {
      const r = (%s);
      if (r === "installed" || r === "present" || tries > 240) clearInterval(t);
    } catch (e) { if (tries > 240) clearInterval(t); }
  }, 500);
})();
""" % BRIDGE_JS


def _user() -> str:
    return getattr(decky, "DECKY_USER", None) or os.environ.get("DECKY_USER") or "deck"


def _user_env() -> dict:
    name = _user()
    try:
        uid = pwd.getpwnam(name).pw_uid
    except KeyError:
        uid = os.getuid()
    env = dict(os.environ)
    # PyInstaller (Decky Loader) points LD_LIBRARY_PATH at its bundled libs, which breaks system binaries.
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    env.pop("LD_LIBRARY_PATH", None)
    if orig:
        env["LD_LIBRARY_PATH"] = orig
    env["XDG_RUNTIME_DIR"] = f"/run/user/{uid}"
    env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{uid}/bus"
    env["HOME"] = pwd.getpwuid(uid).pw_dir
    return env


def _as_user(cmd: list[str]) -> list[str]:
    """Run a command as the desktop user even if the plugin runs as root."""
    if os.geteuid() == 0:
        return ["runuser", "-u", _user(), "--"] + cmd
    return cmd


async def _run(cmd: list[str], timeout: float = 30, as_root: bool = False) -> tuple[int, str]:
    """Run a command as the desktop user (default) or as root (only meaningful when the plugin
    itself runs as root via Decky's _root flag; otherwise falls back to passwordless sudo)."""
    if as_root:
        full = cmd if os.geteuid() == 0 else ["sudo", "-n"] + cmd
    else:
        full = _as_user(cmd)
    proc = await asyncio.create_subprocess_exec(
        *full, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=_user_env()
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timeout"
    return proc.returncode or 0, out.decode(errors="replace")


class Plugin:
    cdp: CDPClient
    loop: asyncio.AbstractEventLoop
    _lock: asyncio.Lock
    _watch: Optional[asyncio.Task] = None
    _last_status: Optional[str] = None
    _bridge_ok: bool = False
    _frame: bytes = b""
    _frame_seq: int = 0
    _frame_cond: asyncio.Condition
    _frame_runner: Optional[web.AppRunner] = None
    _pump: Optional[asyncio.Task] = None
    _pump_opts: dict = {}
    _mjpeg_clients: int = 0
    _share_args: dict = {}
    _resume: Optional[asyncio.Task] = None
    _suspended: bool = False
    _balance: int = 0
    _balance_watch: Optional[asyncio.Task] = None
    # Let Discord (Chromium's WebRTC) adjust the mic volume. Off by default: it tends to turn the
    # mic down until the speaker is inaudible, and Discord's own AGC toggle does not stop it.
    _agc: bool = False

    # ---------- lifecycle ----------
    async def _main(self):
        self.loop = asyncio.get_event_loop()
        self._lock = asyncio.Lock()
        self.cdp = CDPClient(CDP_PORT)
        self.cdp.on_event = self._on_cdp_event
        self._frame_cond = asyncio.Condition()
        decky.logger.info("deckycord starting (uid=%s user=%s)", os.geteuid(), _user())
        self._watch = self.loop.create_task(self._watchdog())
        cfg = self._load_settings()
        self._balance = max(-100, min(100, int(cfg.get("balance", 0))))
        self._agc = bool(cfg.get("agc", False))
        self._balance_watch = self.loop.create_task(self._balance_watcher())
        try:
            await self._start_frame_server()
        except Exception as e:
            decky.logger.warning("frame server: %s", e)

    async def _unload(self):
        self._stop_pump()
        if self._watch:
            self._watch.cancel()
        if self._balance_watch:
            self._balance_watch.cancel()
        await self.cdp.close()
        if self._frame_runner:
            await self._frame_runner.cleanup()
            self._frame_runner = None

    async def _uninstall(self):
        await _run(["bash", os.path.join(PY_DIR, "stop_vesktop.sh")])
        await self._viewer("stop")
        await self._capture("stop")

    # ---------- backend process management ----------
    async def _vesktop_active(self) -> bool:
        rc, _ = await _run(["systemctl", "--user", "is-active", "-q", "deckycord-vesktop"], timeout=10)
        return rc == 0

    def _vesktop_args(self) -> str:
        # WebRTC's analog gain control sets the PipeWire source volume behind the user's back;
        # this Chromium feature flag is the switch for that (Discord's own AGC setting is not).
        return "" if self._agc else "--disable-features=WebRtcAllowInputVolumeAdjustment"

    async def start_backend(self) -> dict:
        env_args = {"VESKTOP_ARGS": self._vesktop_args()}
        rc, out = await _run(["env", *[f"{k}={v}" for k, v in env_args.items()], "bash",
                              os.path.join(PY_DIR, "start_vesktop.sh")], timeout=60)
        decky.logger.info("start_vesktop rc=%s out=%s", rc, out.strip()[-300:])
        return {"rc": rc, "out": out}

    async def stop_backend(self) -> dict:
        await self.cdp.close()
        self._bridge_ok = False
        rc, out = await _run(["bash", os.path.join(PY_DIR, "stop_vesktop.sh")], timeout=30)
        return {"rc": rc, "out": out}

    async def restart_backend(self) -> dict:
        await self.stop_backend()
        await asyncio.sleep(1)
        return await self.start_backend()

    async def _watchdog(self):
        while True:
            if self._suspended:
                await asyncio.sleep(3)
                continue
            try:
                if not await self._vesktop_active():
                    decky.logger.info("vesktop not active, starting")
                    await self.start_backend()
                    await asyncio.sleep(8)
                await self._ensure()
                st = await self._call("state")
                key = json.dumps({"loggedIn": st.get("loggedIn"), "path": st.get("path")})
                if key != self._last_status:
                    self._last_status = key
                    await decky.emit("dc_event", {"type": "status", "state": st})
            except Exception as e:
                decky.logger.debug("watchdog: %s", e)
            await asyncio.sleep(5)

    # ---------- CDP / bridge ----------
    def _is_discord_page(self, t: dict) -> bool:
        return t.get("type") == "page" and "discord.com" in (t.get("url") or "")

    async def _handle_first_launch(self) -> bool:
        """Vesktop shows a one-time setup page before Discord loads; submit it with sane defaults."""
        try:
            targets = await self.cdp.targets()
        except Exception:
            return False
        page = next((t for t in targets if t.get("type") == "page" and "first-launch" in (t.get("url") or "")), None)
        if not page or any(self._is_discord_page(t) for t in targets):
            return False
        decky.logger.info("Vesktop first-launch page detected; submitting setup")
        tmp = CDPClient(CDP_PORT)
        try:
            await tmp.connect(lambda t: t.get("id") == page["id"])
            await tmp.eval(
                "for (const n of ['autoStart','minimizeToTray','richPresence']) { const e = document.querySelector('[name=' + n + ']'); if (e) e.checked = false; }"
                "const b = document.querySelector('button[name=submit], button#submit'); if (b) b.click(); 'submitted'",
                timeout=10,
            )
            return True
        except Exception as e:
            decky.logger.warning("first-launch submit failed: %s", e)
            return False
        finally:
            await tmp.close()

    async def _ensure(self):
        async with self._lock:
            if self.cdp.connected and self._bridge_ok:
                try:
                    if await self.cdp.eval("typeof __dc === 'object' ? __dc.v : 0", timeout=5):
                        return
                except CDPError:
                    pass
            self._bridge_ok = False
            if not self.cdp.connected:
                if await self._handle_first_launch():
                    await asyncio.sleep(8)
                page = await self.cdp.connect(self._is_discord_page)
                decky.logger.info("attached to %s", page.get("url"))
                await self.cdp.send("Runtime.enable")
                await self.cdp.send("Page.enable")
                await self.cdp.send("Runtime.addBinding", {"name": "__dcEvent"})
                await self.cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source": ON_NEW_DOC})
            res = await self.cdp.eval(BRIDGE_JS, timeout=10)
            decky.logger.info("bridge install: %s", res)
            self._bridge_ok = res in ("installed", "present")
            if not self._bridge_ok:
                raise CDPError(f"bridge not installed: {res}")

    async def _call(self, fn: str, *args: Any, timeout: float = 20) -> Any:
        expr = f"__dc.{fn}({', '.join(json.dumps(a) for a in args)})"
        for attempt in range(2):
            try:
                await self._ensure()
                return await self.cdp.eval(expr, timeout=timeout)
            except CDPError as e:
                decky.logger.warning("call %s failed (attempt %d): %s", fn, attempt, e)
                self._bridge_ok = False
                if "not connected" in str(e) or "closed" in str(e) or "no matching page" in str(e):
                    await self.cdp.close()
                if attempt == 1:
                    raise
                await asyncio.sleep(0.5)

    async def _on_cdp_event(self, method: str, params: dict):
        if method == "Runtime.bindingCalled" and params.get("name") == "__dcEvent":
            try:
                ev = json.loads(params.get("payload") or "{}")
            except json.JSONDecodeError:
                return
            await decky.emit("dc_event", ev)
        elif method == "Page.frameNavigated" and not params.get("frame", {}).get("parentId"):
            self._bridge_ok = False

    # ---------- MJPEG relay of the watched stream ----------
    async def _start_frame_server(self):
        app = web.Application()
        app.router.add_get("/stream.mjpg", self._serve_mjpeg)
        app.router.add_get("/frame.jpg", self._serve_frame)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", FRAME_PORT).start()
        self._frame_runner = runner
        decky.logger.info("frame server on 127.0.0.1:%d", FRAME_PORT)

    async def _serve_frame(self, request: web.Request) -> web.Response:
        if not self._frame:
            return web.Response(status=404, text="no frame")
        return web.Response(body=self._frame, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def _frame_pump(self):
        """Pull frames from the bridge while someone is viewing the MJPEG stream. Pulling means a
        slow viewer just lowers the frame rate instead of building up latency."""
        fps = float(self._pump_opts.get("fps", 15))
        opts = {"maxWidth": self._pump_opts.get("max_width", 1280), "quality": self._pump_opts.get("quality", 0.6)}
        misses = 0
        expr = f"__dc.grabFrame({json.dumps(opts)})"
        while True:
            if not self._mjpeg_clients:
                await asyncio.sleep(0.25)
                continue
            t0 = self.loop.time()
            try:
                if not (self.cdp.connected and self._bridge_ok):
                    await self._ensure()
                b64 = await self.cdp.eval(expr, timeout=5)
            except Exception as e:
                decky.logger.warning("grabFrame: %s", e)
                self._bridge_ok = False
                await asyncio.sleep(1)
                continue
            if b64:
                misses = 0
                async with self._frame_cond:
                    self._frame = base64.b64decode(b64)
                    self._frame_seq += 1
                    self._frame_cond.notify_all()
            else:
                misses += 1
                if misses > fps * 20:
                    decky.logger.info("no stream video for 20 s; stopping frame pump")
                    await decky.emit("dc_event", {"type": "frames", "state": "no-video"})
                    return
            await asyncio.sleep(max(0.0, 1.0 / fps - (self.loop.time() - t0)))

    def _start_pump(self, fps: int, max_width: int, quality: float):
        self._stop_pump()
        self._pump_opts = {"fps": fps, "max_width": max_width, "quality": quality}
        self._pump = self.loop.create_task(self._frame_pump())

    def _stop_pump(self):
        if self._pump:
            self._pump.cancel()
            self._pump = None

    async def _serve_mjpeg(self, request: web.Request) -> web.StreamResponse:
        boundary = "deckycordframe"
        resp = web.StreamResponse(headers={
            "Content-Type": f"multipart/x-mixed-replace; boundary={boundary}",
            "Cache-Control": "no-store",
            "Connection": "close",
        })
        await resp.prepare(request)
        seen = -1
        self._mjpeg_clients += 1
        try:
            while True:
                async with self._frame_cond:
                    try:
                        await asyncio.wait_for(self._frame_cond.wait_for(lambda: self._frame_seq != seen and bool(self._frame)), 10)
                    except asyncio.TimeoutError:
                        continue
                    seen = self._frame_seq
                    frame = self._frame
                await resp.write(f"--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n".encode() + frame + b"\r\n")
        except (ConnectionResetError, asyncio.CancelledError, Exception):
            pass
        finally:
            self._mjpeg_clients -= 1
        return resp

    async def stream_url(self) -> dict:
        return {"mjpeg": f"http://127.0.0.1:{FRAME_PORT}/stream.mjpg", "frame": f"http://127.0.0.1:{FRAME_PORT}/frame.jpg", "frames": self._frame_seq}

    async def streams(self, channel_id: Optional[str] = None) -> list:
        return await self._call("streams", channel_id)

    async def watch_stream(self, owner_id: str, fps: int = 15, max_width: int = 1280, quality: float = 0.6) -> dict:
        self._frame = b""
        res = await self._call("watchStream", owner_id, {}, timeout=30)
        if res and res.get("ok"):
            self._start_pump(fps, max_width, quality)
        return res

    async def stop_watching(self) -> bool:
        self._stop_pump()
        try:
            return await self._call("stopWatching")
        finally:
            self._frame = b""

    # ---------- suspend everything to give a game the whole CPU ----------
    async def suspend(self) -> dict:
        """Stop sharing, Vesktop and the hidden display; the watchdog stays out until resume()."""
        self._suspended = True
        if self._resume:
            self._resume.cancel()
            self._resume = None
        self._stop_pump()
        try:
            await self._stop_share()
        except Exception as e:
            decky.logger.warning("suspend: stop_share: %s", e)
        res = await self.stop_backend()
        decky.logger.info("suspended (rc=%s)", res.get("rc"))
        await decky.emit("dc_event", {"type": "status", "state": {"loggedIn": False, "suspended": True}})
        return {"ok": True}

    async def resume(self) -> dict:
        self._suspended = False
        res = await self.start_backend()
        decky.logger.info("resumed (rc=%s)", res.get("rc"))
        return {"ok": res.get("rc") == 0, "out": res.get("out", "")[-200:]}

    # ---------- API exposed to the frontend ----------
    async def reconnect(self) -> dict:
        """Drop the DevTools connection and re-attach/re-install the bridge without touching Vesktop."""
        await self.cdp.close()
        self._bridge_ok = False
        try:
            await self._ensure()
            return {"ok": True, "stores": await self._call("stores")}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def status(self) -> dict:
        running = await self._vesktop_active()
        cdp_up = await self.cdp.is_up()
        out = {"running": running, "cdp": cdp_up, "loggedIn": False, "user": None, "voice": None, "error": None, "suspended": self._suspended}
        if running and cdp_up:
            try:
                st = await self._call("state")
                out.update(st)
            except Exception as e:
                out["error"] = str(e)
        return out

    async def login_qr(self) -> Optional[str]:
        """Returns a data: URL of the login QR code, or null if not on the login page."""
        try:
            rect = await self._call("qrRect")
        except Exception as e:
            decky.logger.warning("login_qr: %s", e)
            return None
        if not rect or rect.get("width", 0) < 10:
            return None
        pad = 10
        clip = {"x": max(0, rect["x"] - pad), "y": max(0, rect["y"] - pad), "width": rect["width"] + 2 * pad, "height": rect["height"] + 2 * pad}
        data = await self.cdp.screenshot(clip)
        return "data:image/png;base64," + data

    async def screenshot(self) -> str:
        await self._ensure()
        return "data:image/png;base64," + await self.cdp.screenshot()

    async def dms(self) -> list:
        return await self._call("dms")

    async def guilds(self) -> list:
        return await self._call("guilds")

    async def channels(self, guild_id: str) -> dict:
        return await self._call("channels", guild_id)

    async def channel_info(self, channel_id: str) -> Optional[dict]:
        return await self._call("channelInfo", channel_id)

    async def messages(self, channel_id: str, limit: int = 50) -> list:
        return await self._call("messages", channel_id, limit, timeout=30)

    async def older(self, channel_id: str, before_id: str, limit: int = 50) -> dict:
        return await self._call("older", channel_id, before_id, limit, timeout=30)

    async def send(self, channel_id: str, text: str) -> bool:
        return await self._call("send", channel_id, text)

    async def ack(self, channel_id: str) -> bool:
        return await self._call("ack", channel_id)

    async def friends(self) -> list:
        return await self._call("friends")

    async def friend_requests(self) -> dict:
        return await self._call("friendRequests")

    async def accept_friend(self, user_id: str) -> bool:
        return await self._call("acceptFriend", user_id)

    async def decline_friend(self, user_id: str) -> bool:
        return await self._call("declineFriend", user_id)

    async def send_friend_request(self, username: str) -> dict:
        return await self._call("sendFriendRequest", username)

    async def open_dm(self, user_id: str) -> Optional[str]:
        return await self._call("openDM", user_id)

    async def voice(self) -> dict:
        return await self._call("voice")

    async def join_voice(self, channel_id: str) -> bool:
        return await self._call("joinVoice", channel_id)

    async def leave_voice(self) -> bool:
        return await self._call("leaveVoice")

    # ---------- DM calls ----------
    async def incoming_calls(self) -> list:
        return await self._call("incomingCalls")

    async def dm_call(self, channel_id: str) -> dict:
        return await self._call("dmCall", channel_id)

    async def start_call(self, channel_id: str) -> dict:
        return await self._call("startCall", channel_id)

    async def accept_call(self, channel_id: str) -> dict:
        return await self._call("acceptCall", channel_id)

    async def decline_call(self, channel_id: str) -> dict:
        return await self._call("declineCall", channel_id)

    async def toggle_mute(self) -> dict:
        return await self._call("toggleMute")

    async def toggle_deaf(self) -> dict:
        return await self._call("toggleDeaf")

    # ---------- screen sharing (kmsgrab -> v4l2loopback -> Discord camera) ----------
    async def _capture(self, action: str) -> tuple[int, str]:
        return await _run(["bash", os.path.join(PY_DIR, "capture.sh"), action], timeout=40, as_root=True)

    async def _viewer(self, action: str) -> tuple[int, str]:
        return await _run(["bash", os.path.join(PY_DIR, "viewer.sh"), action], timeout=20)

    async def share_status(self) -> dict:
        rc, out = await self._capture("status")
        capturing = out.strip() == "active"
        v = {}
        try:
            v = await self._call("voice")
        except Exception:
            pass
        return {"capturing": capturing, "video": bool(v.get("video")), "streaming": bool(v.get("streaming")), "sharing": capturing and (bool(v.get("video")) or bool(v.get("streaming")))}

    async def start_share(self, mode: str = "golive", resolution: int = 720, fps: int = 30) -> dict:
        """Start sharing the screen. mode: 'golive' (Discord stream, falls back to camera) or 'camera'."""
        self._share_args = {"mode": mode, "resolution": resolution, "fps": fps}
        # A manual start cancels a pending auto-resume; the auto-resume itself must not self-cancel.
        if self._resume and self._resume is not asyncio.current_task():
            self._resume.cancel()
            self._resume = None
        rc, out = await self._capture("start")
        decky.logger.info("capture start rc=%s %s", rc, out.strip()[-200:])
        if rc != 0:
            return {"ok": False, "error": out.strip()[-300:]}
        if mode == "golive":
            # Drive Vesktop's picker first, then map the viewer window so it ends up on top of
            # Vesktop's own window on the WM-less Xvfb display (last mapped window wins).
            try:
                res = await self._call("goLive", {"resolution": resolution, "fps": fps, "audio": True}, timeout=40)
            except Exception as e:
                res = {"ok": False, "error": str(e)}
            decky.logger.info("goLive: %s", res)
            if res and res.get("ok"):
                if "direct" in out:
                    decky.logger.info("capture draws straight to the hidden display; no viewer needed")
                else:
                    rc2, out2 = await self._viewer("start")
                    decky.logger.info("viewer start rc=%s %s", rc2, out2.strip()[-200:])
                return {"ok": True, "mode": "golive", "detail": res}
            try:
                await self._call("cancelPicker")
            except Exception:
                pass
            decky.logger.warning("Go Live failed (%s); falling back to camera mode", (res or {}).get("error"))
            if "direct" in out:
                await self._capture("stop")
                return {"ok": False, "error": (res or {}).get("error", "Go Live failed"), "mode": "golive"}
        try:
            res = await self._call("startShare", timeout=25)
        except Exception as e:
            await self._capture("stop")
            return {"ok": False, "error": str(e)}
        if not res or not res.get("ok"):
            await self._capture("stop")
            return {"ok": False, "error": (res or {}).get("error", "no video device")}
        return {"ok": True, "mode": "camera"}

    async def set_bitrate(self, start: int = 3500, min_kbps: int = 1000, max_kbps: int = 8000) -> dict:
        return await self._call("setBitrate", start, min_kbps, max_kbps)

    async def test_capture(self) -> dict:
        """Diagnostics: grab one frame from the display via kmsgrab+VAAPI (needs root)."""
        rc, out = await _run(["bash", os.path.join(PY_DIR, "capture.sh"), "test"], timeout=30, as_root=True)
        return {"rc": rc, "out": out.strip()[-600:]}

    async def rtc_stats(self) -> list:
        return await self._call("rtcStats", timeout=15)

    async def stop_share(self) -> dict:
        if self._resume:
            self._resume.cancel()
            self._resume = None
        return await self._stop_share()

    async def _stop_share(self) -> dict:
        for fn in ("stopGoLive", "stopShare"):
            try:
                await self._call(fn)
            except Exception as e:
                decky.logger.warning("%s: %s", fn, e)
        await self._viewer("stop")
        rc, out = await self._capture("stop")
        return {"ok": rc == 0}

    # ---------- pause the stream around game launches ----------
    # A launching game (shader compilation, asset loading) plus the capture chain plus Vesktop's
    # software encoder is more than a Deck can carry; the stream freezes and the game crawls.
    # Cheapest fix: end the stream when Steam starts a game, restart it 20 s later.
    async def game_launched(self, app_id: int = 0, name: str = "") -> dict:
        st = await self.share_status()
        if not st.get("sharing"):
            return {"paused": False}
        decky.logger.info("game %s (%s) launching; pausing stream", name, app_id)
        await self._stop_share()
        await decky.emit("dc_event", {"type": "share_paused", "name": name})
        if self._resume:
            self._resume.cancel()
        self._resume = self.loop.create_task(self._resume_after(name))
        return {"paused": True}

    async def _resume_after(self, name: str, delay: float = 20):
        """Restart the stream a fixed delay after a game launch (predictable beats CPU heuristics)."""
        try:
            await asyncio.sleep(delay)
            decky.logger.info("resuming stream %.0fs after %s launched", delay, name or "a game")
            res = await self.start_share(**(self._share_args or {}))
            await decky.emit("dc_event", {"type": "share_resumed", "ok": bool(res.get("ok")), "error": res.get("error"), "name": name})
        except asyncio.CancelledError:
            pass
        except Exception as e:
            decky.logger.warning("resume: %s", e)
            await decky.emit("dc_event", {"type": "share_resumed", "ok": False, "error": str(e), "name": name})
        finally:
            self._resume = None

    # ---------- audio devices (PipeWire via pactl) ----------
    async def audio_sources(self) -> dict:
        rc, out = await _run(["pactl", "list", "sources", "short"], timeout=10)
        sources = []
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2 and ".monitor" not in parts[1]:
                sources.append(parts[1])
        rc2, default = await _run(["pactl", "get-default-source"], timeout=10)
        return {"sources": sources, "default": default.strip() if rc2 == 0 else None}

    async def set_mic(self, name: str) -> bool:
        rc, out = await _run(["pactl", "set-default-source", name], timeout=10)
        rc2, cur = await _run(["pactl", "get-default-source"], timeout=10)
        decky.logger.info("set-default-source %s rc=%s -> %s", name, rc, cur.strip())
        return rc == 0 and cur.strip() == name

    async def audio_sinks(self) -> dict:
        rc, out = await _run(["pactl", "list", "sinks", "short"], timeout=10)
        sinks = [l.split("\t")[1] for l in out.splitlines() if "\t" in l]
        rc2, default = await _run(["pactl", "get-default-sink"], timeout=10)
        return {"sinks": sinks, "default": default.strip() if rc2 == 0 else None}

    async def set_sink(self, name: str) -> bool:
        rc, _ = await _run(["pactl", "set-default-sink", name], timeout=10)
        return rc == 0

    # ---------- voice / game audio balance (PS5-style mixer) ----------
    # -100 = voice chat only (games muted) ... 0 = both at 100% ... +100 = game only (voice muted).
    # Applied as per-stream volumes in PipeWire: Vesktop's playback stream is "voice", every other
    # playback stream (games, Steam UI) is "game". A `pactl subscribe` watcher re-applies the mix
    # whenever a new stream appears, so a game launched after the slider was moved is covered.
    _SETTINGS_FILE = "settings.json"

    def _settings_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, self._SETTINGS_FILE)

    def _load_settings(self) -> dict:
        try:
            with open(self._settings_path()) as f:
                return json.load(f)
        except Exception:
            pass
        # first version stored only the mix, in balance.json
        try:
            with open(os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "balance.json")) as f:
                return {"balance": json.load(f).get("balance", 0)}
        except Exception:
            return {}

    def _save_settings(self):
        try:
            os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
            with open(self._settings_path(), "w") as f:
                json.dump({"balance": self._balance, "agc": self._agc}, f)
        except Exception as e:
            decky.logger.warning("save settings: %s", e)

    @staticmethod
    def _balance_levels(pos: int) -> tuple[int, int]:
        """(voice %, game %) for a slider position."""
        pos = max(-100, min(100, int(pos)))
        return (100 - pos if pos > 0 else 100), (100 + pos if pos < 0 else 100)

    async def _playback_streams(self) -> list[tuple[str, bool]]:
        """[(sink-input id, is_voice)] for every PipeWire playback stream."""
        rc, out = await _run(["pactl", "list", "sink-inputs"], timeout=10)
        streams: list[tuple[str, bool]] = []
        cur: Optional[str] = None
        voice = False
        for line in out.splitlines():
            m = re.match(r"Sink Input #(\d+)", line)
            if m:
                if cur is not None:
                    streams.append((cur, voice))
                cur, voice = m.group(1), False
            elif cur is not None and ("dev.vencord.Vesktop" in line or 'application.name = "vesktop"' in line):
                voice = True
        if cur is not None:
            streams.append((cur, voice))
        return streams

    async def _apply_balance(self, only_id: Optional[str] = None):
        voice, game = self._balance_levels(self._balance)
        for sid, is_voice in await self._playback_streams():
            if only_id is not None and sid != only_id:
                continue
            level = voice if is_voice else game
            await _run(["pactl", "set-sink-input-volume", sid, f"{level}%"], timeout=10)

    async def _balance_watcher(self):
        """Re-apply the mix to playback streams as they appear (games start after the slider moved)."""
        while True:
            proc = None
            try:
                proc = await asyncio.create_subprocess_exec(
                    *_as_user(["pactl", "subscribe"]), stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, env=_user_env())
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break
                    text = line.decode(errors="replace")
                    # also at balance 0: PipeWire restores a stream's last per-app volume, so a
                    # game closed while muted would otherwise come back muted after a reset
                    if "'new' on sink-input" in text:
                        m = re.search(r"#(\d+)", text)
                        # a fresh stream registers its properties a moment after the event
                        await asyncio.sleep(0.3)
                        await self._apply_balance(m.group(1) if m else None)
            except asyncio.CancelledError:
                if proc:
                    proc.kill()
                raise
            except Exception as e:
                decky.logger.warning("balance watcher: %s", e)
            if proc and proc.returncode is None:
                proc.kill()
            await asyncio.sleep(5)

    async def get_balance(self) -> dict:
        voice, game = self._balance_levels(self._balance)
        return {"balance": self._balance, "voice": voice, "game": game}

    async def set_balance(self, balance: int) -> dict:
        self._balance = max(-100, min(100, int(balance)))
        self._save_settings()
        await self._apply_balance()
        return await self.get_balance()

    async def get_agc(self) -> dict:
        """Whether Discord may adjust the mic volume, and whether the running Vesktop matches."""
        rc, out = await _run(["pgrep", "-af", "vesktop.bin"], timeout=10)
        running = [l for l in out.splitlines() if "--type=" not in l]
        applied = None
        if running:
            applied = "WebRtcAllowInputVolumeAdjustment" not in running[0]
        return {"agc": self._agc, "applied": applied}

    async def set_agc(self, enabled: bool) -> dict:
        """Change the setting and relaunch Vesktop with the matching flag (drops voice)."""
        self._agc = bool(enabled)
        self._save_settings()
        await self.restart_backend()
        return await self.get_agc()

    async def logs(self, n: int = 60) -> str:
        rc, out = await _run(["journalctl", "--user", "-u", "deckycord-vesktop", "--no-pager", "-n", str(n)], timeout=10)
        return out
