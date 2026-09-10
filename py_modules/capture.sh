#!/bin/bash
# Screen capture for Deckycord screensharing. Runs as root (needs CAP_SYS_ADMIN for kmsgrab).
# Reads the live DRM scanout buffer (works under gamescope without talking to it), scales it on the
# GPU via VAAPI and writes it to a v4l2loopback device, which Discord then sees as a camera.
#
# The grabber exits whenever gamescope changes the scanout format or size (games are direct-scanned
# at their own render size, and layers move between planes), so grabloop.py runs it in a restart
# loop that re-picks the plane and pipes whole raw frames into one long-lived writer that owns the
# v4l2 device. That way the camera never "unplugs" from Discord's point of view.
#   capture.sh start [width height fps]
#   capture.sh stop
#   capture.sh status
#   capture.sh loop <w> <h> <fps> <dev>    (internal)
UNIT=deckycord-capture

find_loopback() {
  for d in /sys/devices/virtual/video4linux/video*; do
    [ -e "$d" ] || continue
    echo "/dev/$(basename "$d")"; return 0
  done
  return 1
}

case "$1" in
  loop)
    W=$2; H=$3; FPS=$4; DEV=$5
    HERE="$(dirname "$(readlink -f "$0")")"
    CARD=$(ls /dev/dri/card* | head -1)
    RENDER=$(ls /dev/dri/renderD* | head -1)
    # grabloop.py re-picks the plane on every restart and forwards only whole frames.
    grab() { python3 "$HERE/grabloop.py" "$W" "$H" "$FPS" "$CARD" "$RENDER"; }
    grab | ffmpeg -hide_banner -loglevel error -nostdin \
      -f rawvideo -pix_fmt yuv420p -s "${W}x${H}" -r "$FPS" -i - -f v4l2 "$DEV"
    ;;
  direct)
    # No virtual camera available (e.g. SteamOS): draw the grabbed frames straight onto the hidden
    # X display, which is what Go Live captures. Also blank the pointer there.
    W=$2; H=$3; FPS=$4; XD=${5:-:99}
    export DISPLAY=$XD
    HERE="$(dirname "$(readlink -f "$0")")"
    python3 "$HERE/hidecursor.py" "$XD" >/dev/null 2>&1 &
    DIMS=$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}')
    SW=${DIMS%x*}; SH=${DIMS#*x}; [ -z "$SW" ] && { SW=$W; SH=$H; }
    CARD=$(ls /dev/dri/card* | head -1)
    RENDER=$(ls /dev/dri/renderD* | head -1)
    # The GPU scales and letterboxes straight to the display size in BGRx, which ximagesink draws
    # as-is: no videoconvert/videoscale on the CPU (they cost ~35% of a Deck core at 720p30).
    grab() { python3 "$HERE/grabloop.py" "$SW" "$SH" "$FPS" "$CARD" "$RENDER" bgr0; }
    while true; do
      grab | gst-launch-1.0 -q fdsrc fd=0 ! rawvideoparse width="$SW" height="$SH" format=bgrx framerate="$FPS/1" ! \
        ximagesink sync=false force-aspect-ratio=false
      sleep 0.5
    done
    ;;
  test)
    # One-frame kernel capture through VAAPI, for diagnostics.
    CARD=$(ls /dev/dri/card* | head -1); RENDER=$(ls /dev/dri/renderD* | head -1)
    OUT=${2:-/tmp/deckycord-test.png}
    timeout 20 ffmpeg -hide_banner -loglevel warning -nostdin -y \
      -init_hw_device vaapi=va:$RENDER -device "$CARD" -f kmsgrab -framerate 30 -i - -filter_hw_device va \
      -vf "hwmap=derive_device=vaapi,scale_vaapi=w=1280:h=720:format=nv12:force_original_aspect_ratio=decrease,hwdownload,format=nv12,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
      -frames:v 1 -update 1 "$OUT" 2>&1 | tail -3
    [ -s "$OUT" ] && echo "captured $OUT ($(stat -c %s "$OUT") bytes)" || { echo "capture failed"; exit 1; }
    ;;
  start)
    if systemctl is-active -q $UNIT; then echo "already running"; exit 0; fi
    W=${2:-1280}; H=${3:-720}; FPS=${4:-30}
    DEV=$(find_loopback)
    if [ -z "$DEV" ]; then
      modprobe v4l2loopback exclusive_caps=1 card_label="Deckycord Screen" 2>/dev/null && sleep 0.5 && DEV=$(find_loopback)
    fi
    if [ -z "$DEV" ]; then
      systemd-run --unit=$UNIT --collect -p Nice=5 -p KillMode=control-group \
        bash "$(readlink -f "$0")" direct "$W" "$H" "$FPS" "${XVFB_DISPLAY:-:99}"
      sleep 2
      systemctl is-active -q $UNIT && echo "started direct" || { journalctl -u $UNIT --no-pager -n 6; exit 1; }
      exit 0
    fi
    systemd-run --unit=$UNIT --collect -p Nice=5 -p KillMode=control-group \
      bash "$(readlink -f "$0")" loop "$W" "$H" "$FPS" "$DEV"
    sleep 2
    systemctl is-active -q $UNIT && echo "started $DEV" || { journalctl -u $UNIT --no-pager -n 5; exit 1; }
    ;;
  stop)
    systemctl stop $UNIT 2>/dev/null; echo stopped ;;
  status)
    systemctl is-active $UNIT ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
