#!/bin/bash
# Launch Vesktop invisibly on an Xvfb display with the DevTools port open, as transient systemd user units.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
XD=${XVFB_DISPLAY:-:99}
HERE="$(dirname "$(readlink -f "$0")")"
XVFB=$(command -v Xvfb)
XVFB_ENV=()
if [ -z "$XVFB" ]; then
  # Bundled Xvfb (from SteamOS 3.8). Newer SteamOS dropped libnettle.so.8, so ship it alongside.
  XVFB="$HERE/bin/Xvfb"
  XVFB_ENV=(--setenv=LD_LIBRARY_PATH="$HERE/bin/lib")
fi
PORT=${CDP_PORT:-9222}
if ! systemctl --user is-active -q deckycord-xvfb; then
  systemd-run --user --unit=deckycord-xvfb --collect "${XVFB_ENV[@]}" "$XVFB" $XD -screen 0 ${XVFB_SIZE:-1280x720}x24 -nolisten tcp -ac
  sleep 1
  if ! systemctl --user is-active -q deckycord-xvfb; then
    # Surface why (e.g. a SteamOS update removed a library the bundled Xvfb links) in the plugin log.
    echo "Xvfb failed to start ($XVFB):"
    journalctl --user -u deckycord-xvfb -n 3 --no-pager -o cat 2>&1
    LD_LIBRARY_PATH="$HERE/bin/lib" ldd "$XVFB" 2>&1 | grep "not found"
    exit 1
  fi
fi
if ! systemctl --user is-active -q deckycord-vesktop; then
  # An orphaned instance would make the new one exit immediately (single-instance lock).
  if pgrep -f "vesktop\.bi[n]" >/dev/null; then
    flatpak kill dev.vencord.Vesktop 2>/dev/null; sleep 1; pkill -f "vesktop\.bi[n]" 2>/dev/null; pkill -f "startvesktop" 2>/dev/null; sleep 1
  fi
  systemd-run --user --unit=deckycord-vesktop --collect \
    --setenv=DISPLAY=$XD \
    flatpak run dev.vencord.Vesktop --remote-debugging-port=$PORT --no-sandbox $VESKTOP_ARGS
fi
