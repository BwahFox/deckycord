#!/bin/bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemctl --user stop deckycord-viewer deckycord-vesktop deckycord-xvfb 2>/dev/null
# Kill stragglers so a fresh instance never hits Electron's single-instance lock.
flatpak kill dev.vencord.Vesktop 2>/dev/null
sleep 1
pkill -f "vesktop\.bi[n]" 2>/dev/null
pkill -f "startvesktop" 2>/dev/null
exit 0
