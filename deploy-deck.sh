#!/bin/bash
# Build, package and install the plugin on a Steam Deck that has no passwordless sudo.
# Uses Decky's own installer (runs as root) via a zip served on the Deck's localhost, and accepts
# the confirmation dialog through Steam's CEF debug port.
set -e
HOST=${1:?usage: deploy-deck.sh <deck@host>}
cd "$(dirname "$0")"
pnpm build >/dev/null
TMP=$(mktemp -d); mkdir -p "$TMP/deckycord"
rsync -a --exclude node_modules --exclude src --exclude .git --exclude '*.map' --exclude login-qr.png --exclude 'deploy*.sh' ./ "$TMP/deckycord/"
(cd "$TMP" && zip -qr deckycord.zip deckycord)
HASH=$(sha256sum "$TMP/deckycord.zip" | cut -c1-64)
ssh "$HOST" 'mkdir -p ~/deckycord-dev/zip'
scp -q "$TMP/deckycord.zip" "$HOST:~/deckycord-dev/zip/deckycord.zip"
rm -rf "$TMP"
ssh "$HOST" "export XDG_RUNTIME_DIR=/run/user/\$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\$(id -u)/bus; systemctl --user is-active -q deckycord-zipserve || systemd-run --user --unit=deckycord-zipserve --collect -p WorkingDirectory=\$HOME/deckycord-dev/zip /usr/bin/python3 -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1; sleep 1; curl -s -o /dev/null -w 'zip served: %{http_code}\n' http://127.0.0.1:8766/deckycord.zip
python3 - <<PY
import json, urllib.request, asyncio, aiohttp
HASH='$HASH'
async def main():
    ts = json.load(urllib.request.urlopen('http://127.0.0.1:8080/json', timeout=3))
    bp = next(t for t in ts if 'Big Picture' in (t.get('title') or ''))
    sjc = next(t for t in ts if t.get('title') == 'SharedJSContext')
    async with aiohttp.ClientSession() as s, s.ws_connect(bp['webSocketDebuggerUrl']) as wb, s.ws_connect(sjc['webSocketDebuggerUrl']) as wj:
        n=[0]
        async def ev(ws, expr, timeout=20):
            n[0]+=1; i=n[0]
            await ws.send_json({'id':i,'method':'Runtime.evaluate','params':{'expression':expr,'awaitPromise':True,'returnByValue':True}})
            while True:
                d = await asyncio.wait_for(ws.receive_json(), timeout)
                if d.get('id')==i: return d.get('result',{}).get('result',{}).get('value')
        has = await ev(wj, 'DeckyPluginLoader.hasPlugin(\"Deckycord\")')
        itype = 2 if has else 0   # 0 = install, 2 = update (Decky InstallType)
        task = asyncio.ensure_future(ev(wj, 'DeckyBackend.call(\"utilities/install_plugin\", \"http://127.0.0.1:8766/deckycord.zip\", \"Deckycord\", \"0.0.1\", \"%s\", %d).then(r=>\"ok\", e=>\"err:\"+String(e))' % (HASH, itype), timeout=180))
        for i in range(30):
            await asyncio.sleep(1)
            m = await ev(wb, '(()=>{const ms=[...document.querySelectorAll(\"[class*=ModalPosition]\")];const m=ms[ms.length-1];return m?m.innerText.slice(0,120):\"\"})()')
            if m and 'eckycord' in m:
                print('accepting:', m.replace(chr(10), ' | '))
                print(await ev(wb, '(()=>{const ms=[...document.querySelectorAll(\"[class*=ModalPosition]\")];const m=ms[ms.length-1];const b=[...m.querySelectorAll(\"button\")].find(b=>!/cancel/i.test(b.textContent||\"\"));b.click();return \"clicked \"+(b.textContent||\"\").trim()})()'))
                break
        print('install:', await task)
asyncio.run(main())
PY
sleep 5; tail -n 3 \"\$(ls -t ~/homebrew/logs/deckycord/*.log | head -1)\" | cut -c1-140"
