#!/bin/bash
# Build and install the plugin on a machine with passwordless sudo, then restart Decky Loader.
set -e
HOST=${1:?usage: deploy.sh <user@host>}
cd "$(dirname "$0")"
pnpm build >/dev/null
rsync -a --delete --exclude node_modules --exclude src --exclude .git --exclude '*.map' --exclude login-qr.png --exclude deploy.sh \
  ./ "$HOST:~/deckycord-dev/deploy/deckycord/"
ssh "$HOST" 'sudo rm -rf ~/homebrew/plugins/deckycord && sudo cp -r ~/deckycord-dev/deploy/deckycord ~/homebrew/plugins/deckycord && sudo chown -R root:root ~/homebrew/plugins/deckycord && sudo systemctl restart plugin_loader && sleep 6 && systemctl is-active plugin_loader && tail -n 20 ~/homebrew/logs/deckycord/*.log 2>/dev/null || ls ~/homebrew/logs'
