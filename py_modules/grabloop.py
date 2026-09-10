#!/usr/bin/env python3
"""Robust kmsgrab loop for Deckycord (runs as root).

gamescope moves layers between DRM planes at will (libliftoff) and games are direct-scanned at their
own render size, so a single long-lived ffmpeg kmsgrab keeps dying with "framebuffer format/
dimensions changed". This loop:
  * picks the plane to grab on every (re)start from DRM debugfs: the largest plane whose
    framebuffer is actually changing between two samples (a game flips buffers every frame;
    launch backgrounds and overlays sit still), so a game switch never leaves us on a stale plane;
  * watches the grabbed plane and restarts onto another one when ours goes static while a
    different plane is moving;
  * paces output to the requested fps (kmsgrab has been seen bursting on some buffers);
  * forwards only whole frames to stdout, dropping any partial frame a dying grabber leaves in
    the pipe, so the downstream rawvideo reader never loses frame alignment;
  * restarts quickly with a short backoff and logs plane changes once, not per frame.

usage: grabloop.py <width> <height> <fps> [card] [render] [pixfmt]
Output: raw frames of width x height on stdout; pixfmt yuv420p (default) or bgr0 (what an X11
ximagesink wants, so the display path needs no software conversion).
"""
import glob
import os
import re
import subprocess
import sys
import threading
import time

W, H, FPS = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
CARD = sys.argv[4] if len(sys.argv) > 4 else sorted(glob.glob("/dev/dri/card*"))[0]
RENDER = sys.argv[5] if len(sys.argv) > 5 else sorted(glob.glob("/dev/dri/renderD*"))[0]
PIXFMT = sys.argv[6] if len(sys.argv) > 6 else "yuv420p"
RGB = PIXFMT in ("bgr0", "rgb0", "bgra", "rgba")
FRAME = W * H * 4 if RGB else W * H * 3 // 2


def log(msg: str) -> None:
    sys.stderr.write(f"grabloop: {msg}\n")
    sys.stderr.flush()


def debugfs_state() -> str:
    """Find the debugfs state file for our card (index from the /dev/dri/cardN name)."""
    idx = re.sub(r"\D", "", os.path.basename(CARD)) or "0"
    for path in (f"/sys/kernel/debug/dri/{idx}/state", "/sys/kernel/debug/dri/0/state"):
        try:
            with open(path) as f:
                return f.read()
        except OSError:
            continue
    return ""


def read_planes() -> dict:
    """plane_id -> (fb_id, w, h, fmt, zpos, cover) for planes with a framebuffer on an active CRTC.
    cover is the on-screen area of the plane (after hardware scaling)."""
    state = debugfs_state()
    if not state:
        return {}
    active_crtcs = set()
    for m in re.finditer(r"^crtc\[(\d+)\]: (crtc-\d+)\n((?:\t.*\n)*)", state, re.M):
        if re.search(r"^\tactive=1", m.group(3), re.M):
            active_crtcs.add(m.group(2))
    planes = {}
    for m in re.finditer(r"^plane\[(\d+)\]: (plane-\d+)\n((?:\t.*\n)*)", state, re.M):
        pid, body = int(m.group(1)), m.group(3)
        crtc = re.search(r"^\tcrtc=(\S+)", body, re.M)
        fb = re.search(r"^\tfb=(\d+)", body, re.M)
        size = re.search(r"^\t\tsize=(\d+)x(\d+)", body, re.M)
        fmt = re.search(r"^\t\tformat=(\S+)", body, re.M)
        pos = re.search(r"^\tcrtc-pos=(\d+)x(\d+)\+", body, re.M)
        z = re.search(r"^\tnormalized-zpos=([0-9a-fA-F]+)", body, re.M)
        if not crtc or crtc.group(1) not in active_crtcs or not fb or fb.group(1) == "0" or not size:
            continue
        cover = int(pos.group(1)) * int(pos.group(2)) if pos else int(size.group(1)) * int(size.group(2))
        planes[pid] = (int(fb.group(1)), int(size.group(1)), int(size.group(2)), fmt.group(1) if fmt else "?", int(z.group(1), 16) if z else 0, cover)
    return planes


def moving_planes(a: dict, b: dict) -> set:
    return {pid for pid in a if pid in b and a[pid][0] != b[pid][0]}


def describe(pid: int, planes: dict) -> str:
    fb, w, h, fmt, z, _ = planes[pid]
    return f"plane {pid} fb {fb} {w}x{h} {fmt} z{z}"


def opaque(fmt: str) -> bool:
    """Games scan out opaque buffers (XR24/XB24/XR30...); UI/overlay layers carry alpha (AR24/AB24)."""
    return not fmt.startswith(("AR", "AB", "BA", "RA"))


def choose(pool: dict) -> int:
    """Among planes covering most of the screen: opaque before alpha, then topmost, then largest.
    A direct-scanned game sits on an overlay above Steam's composite, but an animating alpha UI
    layer above the game must not win either."""
    screen = max(v[5] for v in pool.values())
    full = {pid: v for pid, v in pool.items() if v[5] >= screen * 0.5}
    if full:
        return max(full, key=lambda p: (opaque(full[p][3]), full[p][4], full[p][5]))
    return max(pool, key=lambda p: pool[p][1] * pool[p][2])


def stop_proc(proc: subprocess.Popen, why: str) -> None:
    """SIGTERM, then SIGKILL: ffmpeg has been seen ignoring SIGTERM while grabbing."""
    log(f"stopping grabber: {why}")
    try:
        proc.terminate()
    except OSError:
        return
    for _ in range(10):
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    log("grabber ignored SIGTERM; killing")
    try:
        proc.kill()
    except OSError:
        pass


def pick_plane(hint: int = 0) -> tuple[int, str, dict]:
    """Return (plane_id, description, planes). Prefers planes whose framebuffer changed during a
    ~0.7 s watch (slow renderers included); `hint` is a plane the watchdog just saw moving."""
    first = read_planes()
    if not first:
        return 0, "debugfs unavailable", {}
    moving = set()
    prev = first
    for _ in range(6):
        time.sleep(0.12)
        cur = read_planes()
        moving |= moving_planes(prev, cur)
        prev = cur
        if hint and hint in moving:
            break
    live = prev
    if not live:
        return 0, "no live framebuffer", {}
    if hint and hint in live and (hint in moving or not moving):
        return hint, describe(hint, live) + " (hinted)", live
    pool = {pid: live[pid] for pid in moving if pid in live} or live
    pid = choose(pool)
    return pid, describe(pid, live) + (" (moving)" if pid in moving else " (static)"), live


# Plane the watchdog last saw moving while ours sat still; consumed by the next pick.
hint_plane = [0]


def watch_plane(plane_id: int, proc: subprocess.Popen) -> None:
    """Kill the grabber when our plane sits still for a few seconds while another plane is moving,
    or when our plane loses its framebuffer, so the main loop re-picks."""
    prev = read_planes()
    still = 0
    while proc.poll() is None:
        time.sleep(1.0)
        cur = read_planes()
        if not cur:
            continue
        if plane_id not in cur:
            stop_proc(proc, f"plane {plane_id} lost its framebuffer")
            return
        moving = moving_planes(prev, cur)
        still = 0 if plane_id in moving else still + 1
        others = moving - {plane_id}
        if still >= 3 and others:
            hint_plane[0] = choose({pid: cur[pid] for pid in others})
            stop_proc(proc, f"plane {plane_id} static for {still}s while {sorted(others)} moving; hint {hint_plane[0]}")
            return
        prev = cur


def grab_once(plane_id: int) -> tuple[int, float]:
    """Run one ffmpeg grabber until it exits; forward whole frames. Returns (rc, seconds run)."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-init_hw_device", f"vaapi=va:{RENDER}", "-device", CARD, "-f", "kmsgrab", "-framerate", str(FPS),
    ]
    if plane_id:
        cmd += ["-plane_id", str(plane_id)]
    cmd += [
        "-i", "-", "-filter_hw_device", "va",
        "-vf", (f"hwmap=derive_device=vaapi,scale_vaapi=w={W}:h={H}:format={PIXFMT}:force_original_aspect_ratio=decrease,"
                f"hwdownload,format={PIXFMT},pad={W}:{H}:(ow-iw)/2:(oh-ih)/2" if RGB else
                f"hwmap=derive_device=vaapi,scale_vaapi=w={W}:h={H}:format=nv12:force_original_aspect_ratio=decrease,"
                f"hwdownload,format=nv12,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"),
        "-f", "rawvideo", "-pix_fmt", PIXFMT, "-",
    ]
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    if plane_id:
        threading.Thread(target=watch_plane, args=(plane_id, proc), daemon=True).start()
    out = sys.stdout.buffer
    frames = 0
    skipped = 0
    min_gap = 0.8 / FPS
    last = 0.0
    # Read whole frames straight into a fixed buffer: no per-frame reallocation or shifting.
    frame = bytearray(FRAME)
    view = memoryview(frame)
    filled = 0
    try:
        while True:
            n = proc.stdout.readinto(view[filled:])
            if not n:
                break
            filled += n
            if filled < FRAME:
                continue
            filled = 0
            now = time.monotonic()
            if now - last >= min_gap:
                out.write(frame)
                out.flush()
                frames += 1
                last = now
            else:
                skipped += 1
    except BrokenPipeError:
        proc.kill()
        raise
    finally:
        err = proc.stderr.read().decode(errors="replace").strip()
        proc.wait()
    dropped = filled
    if dropped:
        log(f"dropped {dropped} bytes of a partial frame")
    if skipped:
        log(f"paced: skipped {skipped} frames that arrived faster than {FPS} fps")
    # Always log the exit; the last stderr line is the interesting one ("format changed" etc.).
    last = err.splitlines()[-1][:160] if err else "no stderr"
    log(f"ffmpeg exited rc={proc.returncode} after {frames} frames in {time.monotonic() - t0:.1f}s: {last}")
    return proc.returncode, time.monotonic() - t0


def main() -> None:
    last_desc = None
    while True:
        hint, hint_plane[0] = hint_plane[0], 0
        plane_id, desc, _ = pick_plane(hint)
        if desc != last_desc:
            log(f"grabbing {desc}")
            last_desc = desc
        if desc == "no live framebuffer":
            time.sleep(0.5)
            continue
        try:
            rc, ran = grab_once(plane_id)
        except BrokenPipeError:
            log("downstream closed; exiting")
            return
        # Quick retry on the usual "format changed" exits; back off if it keeps failing instantly.
        time.sleep(0.15 if ran > 2 else 0.6)


if __name__ == "__main__":
    main()
