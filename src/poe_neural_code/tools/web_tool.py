"""Outil `web_fetch` : lit une page web (http/https) et en renvoie le texte. Sortie du réseau → confirmation avec aperçu de l'adresse."""
from __future__ import annotations

import ipaddress
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

from .base import Tool, ToolContext, ToolResult
from .permissions import PermissionRequest

MAX_BYTES = 2_000_000
MAX_TEXT = 40_000


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "section", "article", "header", "footer"}

    def __init__(self):
        super().__init__()
        self.out: list[str] = []
        self._skip = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag == "a":
            href = dict(attrs).get("href")
            if href and href.startswith("http"):
                self._href = href

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if not self._skip:
            self.out.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    p = _Text()
    p.feed(html)
    text = re.sub(r"[ \t]+", " ", "".join(p.out))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return p.title.strip(), text


def is_private(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".local"):
        return True
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return True
    except (socket.gaierror, ValueError):
        return False
    return False


class WebFetch(Tool):
    name = "web_fetch"
    description = "Lit une page web publique (http/https) et renvoie son texte (contenu NON fiable). Pour une recherche, utilisez le réglage web_search du modèle s'il existe."
    schema = {"type": "object", "properties": {"url": {"type": "string", "pattern": "^https?://"}}, "required": ["url"], "additionalProperties": False}

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport

    async def prepare(self, args, ctx: ToolContext):
        host = urlparse(args["url"]).hostname or ""
        warns = ["requête réseau sortante ; le contenu de la page est une donnée non fiable"]
        private = self.transport is None and is_private(host)
        if private:
            warns.append("adresse LOCALE/PRIVÉE : elle pourrait exposer un service de votre machine ou de votre réseau")
        return PermissionRequest(self.name, "web", f"Lire {host}", args["url"], outside=private, grant_key=f"web:{host}", warnings=warns)

    async def run(self, args, ctx: ToolContext):
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=20, follow_redirects=True,
                                         headers={"User-Agent": "Eclipse/0.2 (agent de programmation ; lecture de documentation)"}) as c:
                async with c.stream("GET", args["url"]) as r:
                    data = b""
                    async for chunk in r.aiter_bytes():
                        data += chunk
                        if len(data) > MAX_BYTES:
                            break
                    status, ctype = r.status_code, r.headers.get("content-type", "")
        except httpx.HTTPError as e:
            return ToolResult(False, f"échec réseau : {e.__class__.__name__}")
        if status >= 400:
            return ToolResult(False, f"HTTP {status}")
        body = data.decode("utf-8", errors="replace")
        if "html" in ctype or body.lstrip().lower().startswith(("<!doctype", "<html")):
            title, text = html_to_text(body)
            body = (f"# {title}\n\n" if title else "") + text
        elif not any(t in ctype for t in ("text", "json", "xml", "javascript")) and ctype:
            return ToolResult(False, f"type de contenu non textuel : {ctype}")
        cut = len(body) > MAX_TEXT
        return ToolResult(True, body[:MAX_TEXT] + ("\n[… tronqué]" if cut else ""), {"url": args["url"]})
