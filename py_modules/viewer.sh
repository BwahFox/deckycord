#!/bin/bash
# Shows the virtual camera feed on the hidden Xvfb display so Discord's Go Live captures it.
# Scales the feed to the display's real size (so a capture/display resolution mismatch can never
# letterbox the stream into a corner) and hides the X pointer via XFIXES for the unit's lifetime.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
UNIT=deckycord-viewer
XD=${XVFB_DISPLAY:-:99}
DEV=${2:-/dev/video0}
HERE="$(dirname "$(readlink -f "$0")")"

case "$1" in
  run)
    export DISPLAY=$XD
    # Hide/blank the pointer for as long as this process group lives, and park it in a corner.
    python3 "$HERE/hidecursor.py" "$XD" >/dev/null 2>&1 &
    xdotool mousemove 0 0 2>/dev/null
    DIMS=$(DISPLAY=$XD xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}')
    W=${DIMS%x*}; H=${DIMS#*x}
    [ -z "$W" ] && { W=1280; H=720; }
    # Retry preroll: the loopback device can be briefly busy right after a previous reader exits.
    while true; do
      gst-launch-1.0 -q v4l2src device="$DEV" ! videoconvert ! videoscale ! \
        "video/x-raw,width=$W,height=$H" ! ximagesink sync=false force-aspect-ratio=false
      sleep 0.5
    done
    ;;
  start)
    [ -e "$DEV" ] || { echo "no loopback device; direct mode"; exit 0; }
    if systemctl --user is-active -q $UNIT; then echo "already running"; exit 0; fi
    systemd-run --user --unit=$UNIT --collect -p KillMode=control-group \
      bash "$(readlink -f "$0")" run "$DEV"
    sleep 1.5
    systemctl --user is-active -q $UNIT && echo started || { journalctl --user -u $UNIT --no-pager -n 4; exit 1; }
    ;;
  stop) systemctl --user stop $UNIT 2>/dev/null; echo stopped ;;
  status) systemctl --user is-active $UNIT ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
