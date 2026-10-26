"""Exact browser-origin checks, independent of URL paths and default ports."""

import os
from urllib.parse import urlsplit

from fastapi import HTTPException, Request


def normalize_origin(value: str) -> tuple[str, str, int] | None:
    try:
        url = urlsplit(value)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.path not in ("", "/")
            or url.query
            or url.fragment
            or any(character.isspace() for character in value)
        ):
            return None
        port = url.port
        if port is None:
            port = 443 if url.scheme == "https" else 80
        return url.scheme, url.hostname.lower(), port
    except ValueError:
        return None


def check_login_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    # CLI/server clients need no Origin; browsers send it on login POSTs.
    if origin is None:
        return
    public_origin = os.getenv("PUBLIC_ORIGIN", "").strip()
    if public_origin:
        expected = normalize_origin(public_origin)
        if expected is None:
            raise HTTPException(503, "PUBLIC_ORIGIN_INVALID")
    else:
        # Uvicorn applies forwarded headers only from explicitly trusted proxies.
        # Drop root_path: an origin has a scheme/host/port, never a URL path.
        expected = normalize_origin(
            str(request.url.replace(path="", query="", fragment=""))
        )
    actual = normalize_origin(origin)
    if actual is None or expected is None or actual != expected:
        raise HTTPException(403, "ORIGIN_REJECTED")
