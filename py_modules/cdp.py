"""Minimal Chrome DevTools Protocol client on top of aiohttp (which Decky Loader bundles)."""
import asyncio
import itertools
import json
import logging
from typing import Any, Callable, Optional

import aiohttp

log = logging.getLogger("deckycord.cdp")


class CDPError(Exception):
    pass


class CDPClient:
    def __init__(self, port: int = 9222, host: str = "127.0.0.1"):
        self.base = f"http://{host}:{port}"
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._reader: Optional[asyncio.Task] = None
        self.on_event: Optional[Callable[[str, dict], Any]] = None
        self.page_id: Optional[str] = None

    async def targets(self) -> list[dict]:
        async with aiohttp.ClientSession() as s:
            async with s.get(self.base + "/json", timeout=aiohttp.ClientTimeout(total=3)) as r:
                return await r.json()

    async def is_up(self) -> bool:
        try:
            await self.targets()
            return True
        except Exception:
            return False

    async def connect(self, url_filter: Callable[[dict], bool] = lambda t: t.get("type") == "page") -> dict:
        """Attach to the first page target matching url_filter."""
        await self.close()
        targets = await self.targets()
        page = next((t for t in targets if url_filter(t)), None)
        if page is None:
            raise CDPError(f"no matching page target in {[t.get('url') for t in targets]}")
        self._session = aiohttp.ClientSession()
        self._ws = await self._session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024)
        self._reader = asyncio.create_task(self._read_loop())
        self.page_id = page["id"]
        return page

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    async def close(self):
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._session:
            await self._session.close()
            self._session = None
        for f in self._pending.values():
            if not f.done():
                f.set_exception(CDPError("connection closed"))
        self._pending.clear()

    async def _read_loop(self):
        assert self._ws
        try:
            async for msg in self._ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if "id" in data:
                    fut = self._pending.pop(data["id"], None)
                    if fut and not fut.done():
                        if "error" in data:
                            fut.set_exception(CDPError(data["error"].get("message", str(data["error"]))))
                        else:
                            fut.set_result(data.get("result", {}))
                elif "method" in data and self.on_event:
                    try:
                        res = self.on_event(data["method"], data.get("params", {}))
                        if asyncio.iscoroutine(res):
                            asyncio.create_task(res)
                    except Exception:
                        log.exception("event handler failed")
        except Exception:
            log.exception("cdp read loop died")
        finally:
            for f in self._pending.values():
                if not f.done():
                    f.set_exception(CDPError("connection closed"))
            self._pending.clear()

    async def send(self, method: str, params: Optional[dict] = None, timeout: float = 15) -> dict:
        if not self.connected:
            raise CDPError("not connected")
        mid = next(self._ids)
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self._ws.send_str(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return await asyncio.wait_for(fut, timeout)

    async def eval(self, expression: str, timeout: float = 15) -> Any:
        """Evaluate JS in the page; awaits promises; returns the JSON value."""
        res = await self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in res:
            ex = res["exceptionDetails"]
            desc = ex.get("exception", {}).get("description") or ex.get("text")
            raise CDPError(f"JS exception: {desc}")
        return res.get("result", {}).get("value")

    async def screenshot(self, clip: Optional[dict] = None, fmt: str = "png") -> str:
        """Return base64 screenshot data."""
        params: dict = {"format": fmt}
        if clip:
            params["clip"] = {**clip, "scale": clip.get("scale", 1)}
        res = await self.send("Page.captureScreenshot", params)
        return res["data"]
