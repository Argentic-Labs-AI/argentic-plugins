"""Retry-safe tools for real services: Stripe, Resend, SMTP, Slack, GitHub and a generic HTTP POST.

Every action Argentic hands you carries a stable key (``agent:seq``). These tools use it so a cut-off
action can be retried safely: the provider's own idempotency where it has one (Stripe, Resend, your
endpoint), and for the three that have none (SMTP, Slack, GitHub) a marker the tool looks for before it
sends again. Standard library only. What each provider can and cannot promise is in TOOLS.md.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import smtplib
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate
from typing import Any, Callable
from urllib.parse import urlparse

from .core import RetryLater, Tool, ToolContext

__all__ = ["tool_pack", "provider_key"]

STR = {"type": "string"}


def provider_key(key: str) -> str:
    """A key a provider accepts (Stripe allows 255 characters, Resend 256)."""
    return key if len(key) <= 200 else "sha256:" + hashlib.sha256(key.encode()).hexdigest()


def _unknown_note(what: str) -> str:
    return (f"{what} may or may not have been delivered before the process stopped, and it cannot be checked. "
            "It was not sent again. Check by hand before asking for it again.")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a: Any, **k: Any) -> None:  # a redirect comes back as the answer
        return None


class _Runtime:
    def __init__(self, state_path: str, tries: int, backoff: tuple[float, ...], sleep: Callable[[float], None], timeout: float):
        self.path = state_path
        self.tries = max(1, tries)
        self.backoff = backoff
        self.sleep = sleep
        self.timeout = timeout
        self.entries: dict[str, dict[str, Any]] = {}
        if os.path.exists(state_path):
            with open(state_path) as f:
                self.entries = json.load(f).get("entries", {})
        self._opener = urllib.request.build_opener(_NoRedirect)

    def _save(self) -> None:
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".argentic-intents-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump({"entries": self.entries}, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def once(self, ctx: ToolContext, tool: str, send: Callable[[bool, str], Any]) -> Any:
        """Run one action once. A finished intent returns its stored result. send(maybe_sent, started_at)."""
        key = ctx.idempotency_key
        prior = self.entries.get(key)
        if prior and prior["state"] == "done":
            return prior["result"]
        started = prior["at"] if prior else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if not prior:
            self.entries[key] = {"state": "started", "tool": tool, "at": started}
            self._save()
        result = json.loads(json.dumps(send(bool(prior and prior["state"] == "started"), started), default=str))
        self.entries[key] = {"state": "done", "tool": tool, "at": started, "result": result}
        self._save()
        return result

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, Any, bytes]:
        """One HTTP call. Never raises on an HTTP status; a network error raises OSError."""
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with self._opener.open(req, timeout=self.timeout) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def wait(self, attempt: int) -> None:
        if attempt > 0:
            self.sleep(self.backoff[min(attempt - 1, len(self.backoff) - 1)] if self.backoff else 0)

    def with_retry(self, what: str, call: Callable[[], tuple[int, Any, bytes]], retry_5xx: bool = True) -> tuple[int, Any, bytes]:
        """Same request again after a network error, 429, 409 or 5xx, then RetryLater. For providers that remember the key."""
        last = ""
        for attempt in range(self.tries):
            self.wait(attempt)
            try:
                status, hdrs, raw = call()
            except OSError as e:
                last = str(e)
                continue
            if status in (429, 409) or (retry_5xx and status >= 500):
                last = f"HTTP {status}"
                ra = hdrs.get("Retry-After") if hdrs else None
                if ra and ra.isdigit() and int(ra) > 0:
                    self.sleep(min(int(ra), 30))
                continue
            return status, hdrs, raw
        raise RetryLater(f"{what}: no answer after {self.tries} tries ({last}). Run again to try the same action with the same key.")

    def guarded(self, what: str, hold: bool, look_first: bool, post: Callable[[], tuple[int, Any, bytes]],
                lookup: Callable[[], Any]) -> tuple[str, Any]:
        """For a provider with no idempotency: a network error or 5xx may have landed, so look for the marker before
        posting again. lookup returns the found item, None for "not there", or False for "cannot check"."""
        maybe, last = look_first, ""
        for attempt in range(self.tries):
            self.wait(attempt)
            if maybe:
                found = lookup()
                if found:
                    return "hit", found
                if found is False and hold:
                    return "unknown", None
            try:
                status, hdrs, raw = post()
            except OSError as e:
                maybe, last = True, str(e)
                continue
            if status == 429:
                ra = hdrs.get("Retry-After") if hdrs else None
                if ra and ra.isdigit() and int(ra) > 0:
                    self.sleep(min(int(ra), 30))
                last = "HTTP 429"
                continue
            if status >= 500:
                maybe, last = True, f"HTTP {status}"
                continue
            return "res", (status, hdrs, raw)
        raise RetryLater(f"{what}: no answer after {self.tries} tries ({last}). Run again: it looks for the action before sending it again.")


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"raw": raw.decode(errors="replace")[:500]}


# ---- Stripe: native idempotency ---------------------------------------------------------------

def _stripe(rt: _Runtime, o: dict[str, Any]) -> list[Tool]:
    base = o.get("base_url", "https://api.stripe.com").rstrip("/")
    cap = o.get("max_amount")

    def call(ctx: ToolContext, path: str, params: dict[str, str]) -> dict[str, Any]:
        def go() -> tuple[int, Any, bytes]:
            return rt.request("POST", base + path, {
                "Authorization": f"Bearer {o['secret_key']}",
                "Content-Type": "application/x-www-form-urlencoded",
                "Idempotency-Key": provider_key(ctx.idempotency_key),
            }, urllib.parse.urlencode(params).encode())

        # Stripe stores a 500 under the key and replays it, so asking again cannot change it.
        status, hdrs, raw = rt.with_retry("stripe", go, retry_5xx=False)
        data = _json(raw)
        replayed = str(hdrs.get("Idempotent-Replayed", "")).lower() == "true"
        if not 200 <= status < 300:
            err = data.get("error", {}) if isinstance(data, dict) else {}
            return {"ok": False, "status": status, "error": err.get("message") or err.get("code") or "request failed",
                    "code": err.get("code"), "replayed": replayed}
        return {"ok": True, "id": data.get("id"), "status": data.get("status"), "amount": data.get("amount"),
                "currency": data.get("currency"), "replayed": replayed}

    def bad_amount(amount: Any) -> str | None:
        if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
            return "amount must be a positive whole number of minor units (cents)"
        if cap is not None and amount > cap:
            return f"amount is over the limit of {cap}"
        return None

    def refund(args: dict[str, Any], ctx: ToolContext) -> Any:
        def send(_m: bool, _t: str) -> Any:
            if args.get("amount") is not None:
                bad = bad_amount(args["amount"])
                if bad:
                    return {"ok": False, "error": bad}
            elif cap is not None:
                return {"ok": False, "error": "a full refund needs an amount while a limit is set"}
            p = {"payment_intent": str(args["payment_intent"])}
            if args.get("amount") is not None:
                p["amount"] = str(args["amount"])
            if args.get("reason"):
                p["reason"] = str(args["reason"])
            return call(ctx, "/v1/refunds", p)
        return rt.once(ctx, "stripe_refund", send)

    def charge(args: dict[str, Any], ctx: ToolContext) -> Any:
        def send(_m: bool, _t: str) -> Any:
            bad = bad_amount(args.get("amount"))
            if bad:
                return {"ok": False, "error": bad}
            p = {"customer": str(args["customer"]), "payment_method": str(args["payment_method"]),
                 "amount": str(args["amount"]), "currency": str(args["currency"]).lower(),
                 "confirm": "true", "off_session": "true"}
            if args.get("description"):
                p["description"] = str(args["description"])
            return call(ctx, "/v1/payment_intents", p)
        return rt.once(ctx, "stripe_charge", send)

    return [
        Tool("stripe_refund", "Refund a Stripe payment. Give the payment_intent id (pi_...) and, for a partial refund, the amount in cents.",
             {"type": "object", "properties": {"payment_intent": STR, "amount": {"type": "integer", "description": "cents; omit to refund the whole payment"},
                                               "reason": {"type": "string", "enum": ["duplicate", "fraudulent", "requested_by_customer"]}},
              "required": ["payment_intent"]}, refund),
        Tool("stripe_charge", "Charge a saved Stripe customer off-session. Give the customer id (cus_...), a payment_method id (pm_...), the amount in cents and a 3-letter currency.",
             {"type": "object", "properties": {"customer": STR, "payment_method": STR, "amount": {"type": "integer"}, "currency": STR, "description": STR},
              "required": ["customer", "payment_method", "amount", "currency"]}, charge),
    ]


# ---- Resend: native idempotency ---------------------------------------------------------------

def _resend(rt: _Runtime, o: dict[str, Any], name: str) -> list[Tool]:
    base = o.get("base_url", "https://api.resend.com").rstrip("/")

    def send_email(args: dict[str, Any], ctx: ToolContext) -> Any:
        def send(_m: bool, _t: str) -> Any:
            payload: dict[str, Any] = {"from": o["from"], "to": [str(args["to"])], "subject": str(args["subject"]), "text": str(args["body"])}
            if args.get("html"):
                payload["html"] = str(args["html"])
            if args.get("reply_to"):
                payload["reply_to"] = str(args["reply_to"])
            status, _h, raw = rt.with_retry("resend", lambda: rt.request("POST", base + "/emails", {
                "Authorization": f"Bearer {o['api_key']}", "Content-Type": "application/json",
                "Idempotency-Key": provider_key(ctx.idempotency_key)}, json.dumps(payload).encode()))
            data = _json(raw)
            if not 200 <= status < 300:
                return {"ok": False, "status": status, "error": data.get("message") or data.get("name") or "request failed"}
            return {"ok": True, "id": data.get("id"), "to": args["to"]}
        return rt.once(ctx, name, send)

    return [Tool(name, "Send an email. Plain text in body; add html for a formatted version.",
                 {"type": "object", "properties": {"to": STR, "subject": STR, "body": STR, "html": STR, "reply_to": STR},
                  "required": ["to", "subject", "body"]}, send_email)]


# ---- SMTP: no idempotency; intent log, fixed Message-ID, a hold when unsure -------------------

def _smtp(rt: _Runtime, o: dict[str, Any], name: str) -> list[Tool]:
    hold = o.get("on_ambiguous", "hold") == "hold"
    sender = o["from"]
    domain = re.sub(r"[^A-Za-z0-9.-]", "", (re.search(r"@([^>\s]+)", sender) or [None, "argentic.local"])[1])

    def deliver(msg: EmailMessage, to: str, phase: dict[str, bool]) -> None:
        port = o.get("port") or (465 if o.get("secure") else 587)
        cls = smtplib.SMTP_SSL if o.get("secure") else smtplib.SMTP
        with cls(o["host"], port, timeout=30) as s:
            if not o.get("secure"):
                s.ehlo()
                if s.has_extn("starttls"):
                    s.starttls()
                    s.ehlo()
            if o.get("user"):
                s.login(o["user"], o.get("password", ""))
            addr = (re.search(r"<([^>]+)>", sender) or [None, sender])[1]
            code, resp = s.mail(addr)
            if code >= 400:
                raise smtplib.SMTPSenderRefused(code, resp, addr)
            code, resp = s.rcpt(to)
            if code not in (250, 251):
                raise smtplib.SMTPRecipientsRefused({to: (code, resp)})
            phase["handed"] = True  # from here a cut-off connection leaves it unknown whether the server queued it
            s.data(msg.as_bytes())

    def send_email(args: dict[str, Any], ctx: ToolContext) -> Any:
        def send(maybe: bool, _t: str) -> Any:
            if maybe and hold:
                return {"ok": False, "outcome": "unknown", "note": _unknown_note("This email")}
            mid = f"<{hashlib.sha256(ctx.idempotency_key.encode()).hexdigest()[:32]}@{domain}>"
            msg = EmailMessage()
            msg["From"], msg["To"], msg["Subject"] = sender, str(args["to"]), str(args["subject"])
            msg["Message-ID"], msg["X-Argentic-Idempotency-Key"], msg["Date"] = mid, ctx.idempotency_key, formatdate(usegmt=True)
            msg.set_content(str(args["body"]))
            last = ""
            for attempt in range(rt.tries):
                rt.wait(attempt)
                phase = {"handed": False}
                try:
                    deliver(msg, str(args["to"]), phase)
                    return {"ok": True, "to": args["to"], "messageId": mid}
                except smtplib.SMTPDataError as e:  # the server answered the message itself: a definite no (or later try)
                    if e.smtp_code >= 500:
                        return {"ok": False, "error": f"smtp {e.smtp_code} {e.smtp_error!r}"}
                    last = str(e)
                except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPAuthenticationError) as e:
                    return {"ok": False, "error": f"smtp {e}"}
                except (smtplib.SMTPException, OSError) as e:
                    last = str(e)
                    if phase["handed"] and hold:
                        return {"ok": False, "outcome": "unknown", "note": _unknown_note("This email")}
            raise RetryLater(f"smtp: could not finish sending ({last}). Run again to try the same email.")
        return rt.once(ctx, name, send)

    return [Tool(name, "Send a plain-text email.", {"type": "object", "properties": {"to": STR, "subject": STR, "body": STR},
                                                    "required": ["to", "subject", "body"]}, send_email)]


# ---- Slack: key in message metadata, looked up before a repeat --------------------------------

def _slack(rt: _Runtime, o: dict[str, Any]) -> list[Tool]:
    base = o.get("base_url", "https://slack.com/api").rstrip("/")
    hold = o.get("on_ambiguous", "hold") == "hold"
    channels = o.get("channels")

    def call(method: str, payload: dict[str, Any]) -> tuple[int, Any, bytes]:
        return rt.request("POST", f"{base}/{method}", {"Authorization": f"Bearer {o['token']}",
                                                      "Content-Type": "application/json; charset=utf-8"}, json.dumps(payload).encode())

    def post_message(args: dict[str, Any], ctx: ToolContext) -> Any:
        def send(maybe: bool, started: str) -> Any:
            channel = str(args["channel"])
            if channels is not None and channel not in channels:
                return {"ok": False, "error": f"channel {channel} is not allowed"}
            thread = str(args["thread_ts"]) if args.get("thread_ts") else None

            def lookup() -> Any:
                oldest = str(int(time.mktime(time.strptime(started, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone) - 60)
                try:
                    payload = {"channel": channel, "oldest": oldest, "limit": 100, "include_all_metadata": True}
                    if thread:
                        payload["ts"] = thread
                    status, _h, raw = call("conversations.replies" if thread else "conversations.history", payload)
                    data = _json(raw)
                    if not data.get("ok"):
                        return False
                    for m in data.get("messages", []):
                        if (((m.get("metadata") or {}).get("event_payload")) or {}).get("key") == ctx.idempotency_key:
                            return m
                    return None
                except OSError:
                    return False

            def post() -> tuple[int, Any, bytes]:
                payload: dict[str, Any] = {"channel": channel, "text": str(args["text"]),
                                           "metadata": {"event_type": "argentic_action", "event_payload": {"key": ctx.idempotency_key}}}
                if thread:
                    payload["thread_ts"] = thread
                return call("chat.postMessage", payload)

            kind, val = rt.guarded("slack", hold, maybe, post, lookup)
            if kind == "unknown":
                return {"ok": False, "outcome": "unknown", "note": _unknown_note("This Slack message")}
            if kind == "hit":
                return {"ok": True, "ts": val.get("ts"), "channel": channel, "found": True}
            data = _json(val[2])
            if not data.get("ok"):
                return {"ok": False, "error": data.get("error") or f"HTTP {val[0]}"}
            return {"ok": True, "ts": data.get("ts"), "channel": channel}
        return rt.once(ctx, "slack_post_message", send)

    return [Tool("slack_post_message", "Post a message to a Slack channel (channel id, such as C0123ABCD). thread_ts replies in a thread.",
                 {"type": "object", "properties": {"channel": STR, "text": STR, "thread_ts": STR}, "required": ["channel", "text"]}, post_message)]


# ---- GitHub: hidden marker in the body, looked up before a repeat -----------------------------

def _github(rt: _Runtime, o: dict[str, Any]) -> list[Tool]:
    base = o.get("base_url", "https://api.github.com").rstrip("/")
    hold = o.get("on_ambiguous", "hold") == "hold"
    repos = o.get("repos")
    hdr = {"Authorization": f"Bearer {o['token']}", "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"}

    def marker(key: str) -> str:
        return f"<!-- argentic-key:{key.replace('--', '-')} -->"

    def scan(url: str, mk: str) -> Any:
        try:
            for page in range(1, 4):
                sep = "&" if "?" in url else "?"
                status, _h, raw = rt.request("GET", f"{url}{sep}per_page=100&page={page}", hdr, None)
                if status != 200:
                    return False
                items = json.loads(raw)
                for i in items:
                    if isinstance(i.get("body"), str) and mk in i["body"] and "pull_request" not in i:
                        return i
                if len(items) < 100:
                    return None
            return None
        except (OSError, ValueError):
            return False

    def make(name: str, list_url: Callable[[dict[str, Any], str], str], create_url: Callable[[dict[str, Any]], str],
             payload: Callable[[dict[str, Any], str], dict[str, Any]]) -> Callable[[dict[str, Any], ToolContext], Any]:
        def run(args: dict[str, Any], ctx: ToolContext) -> Any:
            def send(maybe: bool, started: str) -> Any:
                repo = str(args["repo"])
                if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or (repos is not None and repo not in repos):
                    return {"ok": False, "error": f"repo {repo} is not allowed"}
                mk = marker(ctx.idempotency_key)
                since = urllib.parse.quote(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.mktime(time.strptime(started, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone - 60)))
                kind, val = rt.guarded("github", hold, maybe,
                                       lambda: rt.request("POST", create_url(args), hdr, json.dumps(payload(args, mk)).encode()),
                                       lambda: scan(list_url(args, since), mk))
                if kind == "unknown":
                    return {"ok": False, "outcome": "unknown", "note": _unknown_note("This GitHub write")}
                if kind == "hit":
                    return {"ok": True, "number": val.get("number"), "id": val.get("id"), "url": val.get("html_url"), "found": True}
                status, _h, raw = val
                data = _json(raw)
                if not 200 <= status < 300:
                    return {"ok": False, "status": status, "error": data.get("message") or "request failed"}
                return {"ok": True, "number": data.get("number"), "id": data.get("id"), "url": data.get("html_url")}
            return rt.once(ctx, name, send)
        return run

    issue = make("github_create_issue",
                 lambda a, since: f"{base}/repos/{a['repo']}/issues?state=all&sort=created&direction=desc&since={since}",
                 lambda a: f"{base}/repos/{a['repo']}/issues",
                 lambda a, mk: {"title": str(a["title"]), "body": f"{a.get('body') or ''}\n\n{mk}",
                                **({"labels": a["labels"]} if isinstance(a.get("labels"), list) else {})})
    comment = make("github_create_comment",
                   lambda a, since: f"{base}/repos/{a['repo']}/issues/{int(a['issue_number'])}/comments?since={since}",
                   lambda a: f"{base}/repos/{a['repo']}/issues/{int(a['issue_number'])}/comments",
                   lambda a, mk: {"body": f"{a['body']}\n\n{mk}"})
    return [
        Tool("github_create_issue", "Open a GitHub issue. repo is owner/name.",
             {"type": "object", "properties": {"repo": STR, "title": STR, "body": STR, "labels": {"type": "array", "items": {"type": "string"}}},
              "required": ["repo", "title"]}, issue),
        Tool("github_create_comment", "Comment on a GitHub issue or pull request. repo is owner/name.",
             {"type": "object", "properties": {"repo": STR, "issue_number": {"type": "integer"}, "body": STR},
              "required": ["repo", "issue_number", "body"]}, comment),
    ]


# ---- Generic HTTP POST with an Idempotency-Key header -----------------------------------------

def _http(rt: _Runtime, o: dict[str, Any]) -> list[Tool]:
    hosts = {h.lower() for h in o["allow_hosts"]}

    def post(args: dict[str, Any], ctx: ToolContext) -> Any:
        def send(_m: bool, _t: str) -> Any:
            u = urlparse(str(args["url"]))
            if u.scheme not in ("http", "https") or not u.netloc:
                return {"ok": False, "error": "not a URL"}
            if u.scheme != "https" and not (o.get("allow_http") and u.scheme == "http"):
                return {"ok": False, "error": "only https URLs are allowed"}
            if u.netloc.lower() not in hosts and (u.hostname or "").lower() not in hosts:
                return {"ok": False, "error": f"host {u.netloc} is not allowed"}
            headers = {**o.get("headers", {}), "Content-Type": str(args.get("content_type") or "application/json"),
                       "Idempotency-Key": provider_key(ctx.idempotency_key)}
            status, hdrs, raw = rt.with_retry("http_post", lambda: rt.request("POST", str(args["url"]), headers, str(args["body"]).encode()))
            replayed = str(hdrs.get("Idempotent-Replayed", hdrs.get("Idempotency-Replayed", ""))).lower() == "true"
            return {"ok": 200 <= status < 300, "status": status, "body": raw.decode(errors="replace")[:2000], "replayed": replayed}
        return rt.once(ctx, "http_post", send)

    return [Tool("http_post", "POST a body to an allowed URL. The receiver is sent an Idempotency-Key for this action.",
                 {"type": "object", "properties": {"url": STR, "body": {"type": "string", "description": "the request body, such as JSON text"}, "content_type": STR},
                  "required": ["url", "body"]}, post)]


def tool_pack(
    *,
    stripe: dict[str, Any] | None = None,
    resend: dict[str, Any] | None = None,
    smtp: dict[str, Any] | None = None,
    slack: dict[str, Any] | None = None,
    github: dict[str, Any] | None = None,
    http: dict[str, Any] | None = None,
    state_path: str = ".argentic-intents.json",
    tries: int = 4,
    backoff: tuple[float, ...] = (0.5, 1.5, 4.0),
    sleep: Callable[[float], None] = time.sleep,
    timeout: float = 30.0,
) -> list[Tool]:
    """Tools for run_durable. Pass only the services you use; each is built from your options and secrets,
    never from anything the model sends. With Resend and SMTP both set, Resend is ``send_email`` and SMTP
    is ``send_email_smtp``.

    Options: stripe {secret_key, base_url?, max_amount?}; resend {api_key, from, base_url?};
    smtp {host, port?, secure?, user?, password?, from, on_ambiguous?}; slack {token, base_url?, channels?, on_ambiguous?};
    github {token, base_url?, repos?, on_ambiguous?}; http {allow_hosts, headers?, allow_http?}.
    on_ambiguous is "hold" (default) or "retry"."""
    rt = _Runtime(state_path, tries, backoff, sleep, timeout)
    out: list[Tool] = []
    if stripe:
        out += _stripe(rt, stripe)
    if resend:
        out += _resend(rt, resend, "send_email")
    if smtp:
        out += _smtp(rt, smtp, "send_email_smtp" if resend else "send_email")
    if slack:
        out += _slack(rt, slack)
    if github:
        out += _github(rt, github)
    if http:
        out += _http(rt, http)
    return out
