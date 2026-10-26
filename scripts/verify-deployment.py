"""Smoke-test the browser login flow through an actual reverse proxy (stdlib only)."""

import argparse
import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--base-url", default="http://127.0.0.1:8080")
parser.add_argument("--origin", default="http://127.0.0.1:8080")
parser.add_argument("--forwarded-proto", choices=("http", "https"))
parser.add_argument("--expect-secure-cookie", action="store_true")
args = parser.parse_args()
headers = {"Host": urlsplit(args.origin).netloc, "Origin": args.origin,
           "Content-Type": "application/json"}
if args.forwarded_proto:
    headers["X-Forwarded-Proto"] = args.forwarded_proto


def call(path, data=None, extra=None):
    request = Request(args.base_url.rstrip("/") + path,
                      data=json.dumps(data).encode() if data is not None else None,
                      headers={**headers, **(extra or {})})
    return urlopen(request, timeout=10)


with call("/api/v1/health") as response:
    assert json.load(response)["status"] == "ok"
with call("/api/v1/demo/login", {"profile": "ip"}) as response:
    session = json.load(response)
    cookie = response.headers["Set-Cookie"]
    assert "httponly" in cookie.lower()
    if args.expect_secure_cookie:
        assert "secure" in cookie.lower(), cookie
headers["Cookie"] = cookie.split(";", 1)[0]
headers["X-CSRF-Token"] = session["csrf"]
with call("/api/v1/me") as response:
    assert json.load(response)["account"]["id"] == "ip"
try:
    with call("/api/v1/demo/login", {"profile": "ip"}, {"Origin": "https://evil.example"}):
        raise AssertionError("Cross-origin login was accepted")
except HTTPError as error:
    assert error.code == 403
    assert json.load(error)["detail"] == "ORIGIN_REJECTED"
with call("/api/v1/logout", {}) as response:
    assert json.load(response)["success"]
print("Proxy smoke passed: health, login, cookie, session, foreign-origin rejection, logout")
