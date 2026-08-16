#!/usr/bin/env python3
"""Make one minimal Bailian OpenAI-compatible chat completion request."""

from __future__ import annotations

import json
import os
import re
import socket
import ssl
import sys
from pathlib import Path
from urllib import error, parse, request


CONFIG_NAMES = ("BAILIAN_API_KEY", "BAILIAN_BASE_URL", "BAILIAN_MODEL")
EXPECTED_TEXT = "Forge API OK"


def load_dev_vars(path: Path) -> None:
    """Load the three supported values, without overriding the environment."""
    if not path.exists():
        return

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ValueError(f"could not read {path.name}: {type(exc).__name__}") from None

    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(
                f"invalid entry in {path.name} on line {line_number}; expected NAME=value"
            )

        name, value = line.split("=", 1)
        name = name.strip()
        if name not in CONFIG_NAMES or name in os.environ:
            continue

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[name] = value


def require_config() -> tuple[str, str, str]:
    values = {name: os.environ.get(name, "").strip() for name in CONFIG_NAMES}
    missing = [name for name, value in values.items() if not value]
    if missing:
        joined = ", ".join(missing)
        raise ValueError(
            f"missing configuration: set {joined} in .dev.vars or the environment"
        )

    base_url = values["BAILIAN_BASE_URL"]
    parsed_url = parse.urlparse(base_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ValueError(
            "invalid BAILIAN_BASE_URL: set a complete http(s) OpenAI-compatible base URL"
        )

    return values["BAILIAN_API_KEY"], base_url, values["BAILIAN_MODEL"]


def safe_text(value: object, api_key: str, limit: int = 300) -> str:
    """Return a short diagnostic with credential-like text removed."""
    text = str(value).replace(api_key, "[REDACTED]") if api_key else str(value)
    text = re.sub(r"(?i)bearer\s+\S+", "Bearer [REDACTED]", text)
    return " ".join(text.split())[:limit]


def api_error_detail(body: bytes, api_key: str) -> str:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ""

    api_error = payload.get("error", payload) if isinstance(payload, dict) else {}
    if not isinstance(api_error, dict):
        return ""
    code = api_error.get("code")
    message = api_error.get("message")
    detail = ": ".join(str(part) for part in (code, message) if part)
    return safe_text(detail, api_key)


def report_http_failure(exc: error.HTTPError, api_key: str) -> None:
    body = exc.read(32_768)
    detail = api_error_detail(body, api_key)
    detail_suffix = f" ({detail})" if detail else ""
    lowered = detail.lower()

    if exc.code in {401, 403} or any(
        marker in lowered
        for marker in ("api key", "apikey", "authentication", "unauthorized")
    ):
        category = "authentication failure; check BAILIAN_API_KEY"
    elif exc.code == 429 or any(
        marker in lowered
        for marker in ("quota", "rate limit", "throttl", "arrearage", "balance")
    ):
        category = "rate limit or quota failure"
    elif "model" in lowered or "deployment" in lowered:
        category = "invalid or unavailable model; check BAILIAN_MODEL"
    elif exc.code in {400, 404}:
        category = "endpoint or region mismatch; check BAILIAN_BASE_URL"
    else:
        category = "API request failure"

    print(f"HTTP/API status: failure (HTTP {exc.code}: {category}){detail_suffix}")


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        load_dev_vars(repo_root / ".dev.vars")
        api_key, base_url, model = require_config()
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "user", "content": f"Reply with exactly: {EXPECTED_TEXT}"}
            ],
            "temperature": 0.1,
            "max_tokens": 64,
            "enable_thinking": False,
        }
    ).encode("utf-8")
    api_request = request.Request(
        endpoint,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    print(f"Model: {model}")
    print(f"Endpoint host: {parse.urlparse(base_url).hostname}")
    try:
        with request.urlopen(api_request, timeout=30) as response:
            response_body = response.read(65_536)
            status = response.status
    except error.HTTPError as exc:
        report_http_failure(exc, api_key)
        return 1
    except error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (TimeoutError, socket.timeout)):
            detail = "request timed out"
        elif isinstance(reason, ssl.SSLError):
            detail = "TLS connection failed"
        else:
            detail = safe_text(reason, api_key)
        print(f"HTTP/API status: failure (network/API error: {detail})")
        return 1
    except TimeoutError:
        print("HTTP/API status: failure (network/API error: request timed out)")
        return 1

    try:
        response_payload = json.loads(response_body.decode("utf-8"))
        assistant_text = response_payload["choices"][0]["message"]["content"]
        if not isinstance(assistant_text, str):
            raise TypeError
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
        print(
            f"HTTP/API status: failure (HTTP {status}: unexpected response format)"
        )
        return 1

    print(f"Status: success (HTTP {status})")
    print(f"Response: {assistant_text}")
    usage = response_payload.get("usage")
    if isinstance(usage, dict):
        prompt_tokens = usage.get("prompt_tokens", usage.get("input_tokens"))
        completion_tokens = usage.get("completion_tokens", usage.get("output_tokens"))
        total_tokens = usage.get("total_tokens")
        print(
            "Token usage: "
            f"input={prompt_tokens}, output={completion_tokens}, total={total_tokens}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
