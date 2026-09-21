"""Small, bounded IPMA weather proxy for the weather UI.

The service deliberately exposes only a fixed set of IPMA HTTPS resources.  It
does not accept a URL from a caller and it only builds a forecast URL after the
requested location has been found in the cached IPMA locations catalogue.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


HOST = os.environ.get("IPMA_HOST", "0.0.0.0")
PORT = int(os.environ.get("IPMA_PORT", "8090"))
PUBLIC_DIR = Path(__file__).with_name("public")

LOCATIONS_URL = "https://api.ipma.pt/public-data/forecast/locations.json"
AGGREGATE_URL = "https://api.ipma.pt/public-data/forecast/aggregate/{id}.json"
DAILY_URL = "https://api.ipma.pt/open-data/forecast/meteorology/cities/daily/{id}.json"

# These are intentionally short.  A stale in-memory entry may be served for a
# bounded period when IPMA is temporarily unavailable, but it is labelled in
# the response.
LOCATIONS_TTL_SECONDS = 6 * 60 * 60
LOCATIONS_STALE_SECONDS = 7 * 24 * 60 * 60
WEATHER_TTL_SECONDS = 10 * 60
WEATHER_STALE_SECONDS = 24 * 60 * 60
WEATHER_CACHE_MAX_ENTRIES = 64
UPSTREAM_TIMEOUT_SECONDS = 5
CLIENT_SOCKET_TIMEOUT_SECONDS = 10
REQUEST_HEADER_DEADLINE_SECONDS = 5
MAX_HANDLER_THREADS = 16
MAX_UPSTREAM_BYTES = 2 * 1024 * 1024

ALLOWED_UPSTREAM_HOSTS = frozenset({"api.ipma.pt"})
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "font-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "frame-ancestors 'none'"
)


def _is_allowed_upstream_url(url: str) -> bool:
    """Accept only the three fixed IPMA resource URL families."""

    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return False
    if (
        parsed.scheme != "https"
        or hostname not in ALLOWED_UPSTREAM_HOSTS
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
    ):
        return False
    if parsed.query or parsed.fragment:
        return False
    if parsed.path == "/public-data/forecast/locations.json":
        return True
    if re.fullmatch(r"/public-data/forecast/aggregate/[1-9][0-9]*\.json", parsed.path):
        return True
    return bool(re.fullmatch(r"/open-data/forecast/meteorology/cities/daily/[1-9][0-9]*\.json", parsed.path))


class _AllowlistedRedirectHandler(HTTPRedirectHandler):
    """Reject a redirect before urllib opens a non-IPMA target."""

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str):
        from urllib.parse import urljoin

        target = urljoin(req.full_url, newurl)
        if not _is_allowed_upstream_url(target):
            raise UpstreamError("IPMA redirect target is outside the allowlist")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_IPMA_OPENER = build_opener(_AllowlistedRedirectHandler())

# This is the current official IPMA weather type table.  -99 and unknown
# values are treated as unavailable, so the frontend can render a neutral icon.
WEATHER_DESCRIPTIONS: dict[int, str] = {
    0: "Sem informação",
    1: "Céu limpo",
    2: "Céu pouco nublado",
    3: "Céu parcialmente nublado",
    4: "Céu muito nublado ou encoberto",
    5: "Céu nublado por nuvens altas",
    6: "Aguaceiros/chuva",
    7: "Aguaceiros/chuva fracos",
    8: "Aguaceiros/chuva forte",
    9: "Chuva/aguaceiros",
    10: "Chuva fraca ou chuvisco",
    11: "Chuva/aguaceiros fortes",
    12: "Períodos de chuva",
    13: "Períodos de chuva fraca",
    14: "Períodos de chuva forte",
    15: "Chuvisco",
    16: "Neblina",
    17: "Nevoeiro ou nuvens baixas",
    18: "Neve",
    19: "Trovoada",
    20: "Aguaceiros e possibilidade de trovoada",
    21: "Granizo",
    22: "Geada",
    23: "Chuva e possibilidade de trovoada",
    24: "Nebulosidade convectiva",
    25: "Céu com períodos de muito nublado",
    26: "Nevoeiro",
    27: "Céu nublado",
    28: "Aguaceiros de neve",
    29: "Chuva e Neve",
    30: "Chuva e Neve",
}


class UpstreamError(RuntimeError):
    """An IPMA response could not be fetched or validated."""


class _DeadlineReader:
    """Read HTTP headers within one absolute deadline, even with trickle input."""

    def __init__(self, reader: Any, connection: Any) -> None:
        self._reader = reader
        self._connection = connection
        self._deadline = 0.0

    def start_deadline(self) -> None:
        self._deadline = time.monotonic() + REQUEST_HEADER_DEADLINE_SECONDS

    def readline(self, limit: int = -1) -> bytes:
        data = bytearray()
        while limit < 0 or len(data) < limit:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("request headers exceeded their deadline")
            self._connection.settimeout(min(CLIENT_SOCKET_TIMEOUT_SECONDS, remaining))
            byte = self._reader.read(1)
            if not byte:
                break
            data.extend(byte)
            if byte == b"\n":
                break
        return bytes(data)

    def close(self) -> None:
        self._reader.close()


@dataclass
class _CacheEntry:
    value: Any
    fetched_at: str
    stored_at: float


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _as_number(value: Any, *, integer: bool = False) -> int | float | None:
    """Convert an IPMA number, preserving null for missing/sentinel values."""

    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value or value in {"-99", "-99.0", "-999", "-999.0"}:
            return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number in {-99.0, -999.0}:
        return None
    if integer:
        return int(number)
    return number


def _as_weather_code(value: Any) -> int | None:
    number = _as_number(value, integer=True)
    if number is None or number == -99:
        return None
    return number


def _description(code: int | None) -> str | None:
    if code is None:
        return None
    return WEATHER_DESCRIPTIONS.get(code)


def _utc_timestamp(value: Any) -> str | None:
    """Normalize IPMA's UTC timestamp, which omits the trailing Z."""

    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1]
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def _date_only(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    try:
        return datetime.fromisoformat(text[:10]).date().isoformat()
    except ValueError:
        return None


def fetch_json(url: str) -> Any:
    """Fetch one of the fixed IPMA JSON resources with a bounded body."""

    if not _is_allowed_upstream_url(url):
        raise UpstreamError("upstream URL is outside the IPMA allowlist")
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "ipma-weather/1.0",
        },
        method="GET",
    )
    try:
        with _IPMA_OPENER.open(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > MAX_UPSTREAM_BYTES:
                        raise UpstreamError("upstream response is too large")
                except ValueError:
                    pass
            body = response.read(MAX_UPSTREAM_BYTES + 1)
    except UpstreamError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise UpstreamError("IPMA request failed") from exc
    if len(body) > MAX_UPSTREAM_BYTES:
        raise UpstreamError("upstream response is too large")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpstreamError("IPMA returned invalid JSON") from exc


def _copy(value: Any) -> Any:
    """Copy cached JSON-shaped values without exposing mutable cache state."""

    return json.loads(json.dumps(value, ensure_ascii=False))


class WeatherService:
    """IPMA catalogue and forecast service with bounded in-memory caching."""

    def __init__(
        self,
        fetcher: Callable[[str], Any] | None = None,
        *,
        clock: Callable[[], float] = time.time,
        iso_clock: Callable[[], str] = _now_iso,
    ) -> None:
        self._fetcher = fetcher or fetch_json
        self._clock = clock
        self._iso_clock = iso_clock
        self._locations: _CacheEntry | None = None
        self._weather: OrderedDict[int, _CacheEntry] = OrderedDict()
        self._lock = threading.RLock()
        self._locations_fetch_lock = threading.Lock()
        self._weather_fetch_lock = threading.Lock()

    def locations(self) -> tuple[list[dict[str, Any]], bool]:
        with self._lock:
            entry = self._locations
            if entry and self._clock() - entry.stored_at < LOCATIONS_TTL_SECONDS:
                return _copy(entry.value), False
        # Single flight prevents concurrent first requests from creating a
        # burst of identical catalogue downloads.
        with self._locations_fetch_lock:
            with self._lock:
                entry = self._locations
                if entry and self._clock() - entry.stored_at < LOCATIONS_TTL_SECONDS:
                    return _copy(entry.value), False
            try:
                raw = self._fetcher(LOCATIONS_URL)
                normalized = self._normalize_locations(raw)
                if not normalized:
                    raise UpstreamError("IPMA returned no locations")
                fetched_at = self._iso_clock()
                with self._lock:
                    self._locations = _CacheEntry(normalized, fetched_at, self._clock())
                return _copy(normalized), False
            except Exception as exc:
                with self._lock:
                    entry = self._locations
                    age = self._clock() - entry.stored_at if entry else None
                if entry and age is not None and age <= LOCATIONS_STALE_SECONDS:
                    return _copy(entry.value), True
                if isinstance(exc, UpstreamError):
                    raise
                raise UpstreamError("could not normalize IPMA locations") from exc

    def weather(self, location_id: int) -> dict[str, Any]:
        locations, locations_stale = self.locations()
        location = next((item for item in locations if item["id"] == location_id), None)
        if location is None:
            raise KeyError(location_id)

        with self._lock:
            entry = self._weather.get(location_id)
            if entry and self._clock() - entry.stored_at < WEATHER_TTL_SECONDS:
                self._weather.move_to_end(location_id)
                result = _copy(entry.value)
                if locations_stale:
                    result["stale"] = True
                return result

        # Single flight also re-checks the cache after waiting, so multiple
        # browsers selecting the same location share one upstream request.
        with self._weather_fetch_lock:
            with self._lock:
                entry = self._weather.get(location_id)
                if entry and self._clock() - entry.stored_at < WEATHER_TTL_SECONDS:
                    self._weather.move_to_end(location_id)
                    result = _copy(entry.value)
                    if locations_stale:
                        result["stale"] = True
                    return result

            aggregate_url = AGGREGATE_URL.format(id=location_id)
            try:
                aggregate = self._fetcher(aggregate_url)
                result = self._from_aggregate(location, aggregate, aggregate_url)
            except Exception as aggregate_error:
                daily_url = DAILY_URL.format(id=location_id)
                try:
                    daily = self._fetcher(daily_url)
                    result = self._from_daily(location, daily, daily_url)
                except Exception as daily_error:
                    with self._lock:
                        entry = self._weather.get(location_id)
                        age = self._clock() - entry.stored_at if entry else None
                    if entry and age is not None and age <= WEATHER_STALE_SECONDS:
                        self._weather.move_to_end(location_id)
                        result = _copy(entry.value)
                        result["stale"] = True
                        return result
                    if isinstance(daily_error, UpstreamError):
                        raise daily_error from aggregate_error
                    raise UpstreamError("could not normalize IPMA daily forecast") from daily_error

            if locations_stale:
                result["stale"] = True
            with self._lock:
                self._weather[location_id] = _CacheEntry(
                    _copy(result), result["fetchedAt"], self._clock()
                )
                self._weather.move_to_end(location_id)
                while len(self._weather) > WEATHER_CACHE_MAX_ENTRIES:
                    self._weather.popitem(last=False)
            return _copy(result)

    @staticmethod
    def _normalize_locations(raw: Any) -> list[dict[str, Any]]:
        if not isinstance(raw, list):
            raise UpstreamError("IPMA locations payload is not a list")
        result: list[dict[str, Any]] = []
        seen: set[int] = set()
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            raw_id = item.get("globalIdLocal", item.get("id"))
            try:
                location_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if location_id <= 0 or location_id in seen:
                continue
            name = item.get("local", item.get("name"))
            if not isinstance(name, str) or not name.strip():
                continue
            region = item.get("idRegiao")
            try:
                region_id = int(region)
            except (TypeError, ValueError):
                region_id = 0
            result.append(
                {
                    "id": location_id,
                    "name": name.strip(),
                    "lat": _as_number(item.get("latitude")),
                    "lon": _as_number(item.get("longitude")),
                    "timezone": "Atlantic/Azores" if region_id == 3 else "Europe/Lisbon",
                }
            )
            seen.add(location_id)
        return result

    def _from_aggregate(
        self, location: Mapping[str, Any], raw: Any, source_url: str
    ) -> dict[str, Any]:
        if not isinstance(raw, list):
            raise UpstreamError("IPMA aggregate payload is not a list")
        hourly: dict[str, tuple[int, dict[str, Any]]] = {}
        daily: dict[str, dict[str, Any]] = {}
        updated_at: str | None = None
        recognized = False
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            update = _utc_timestamp(item.get("dataUpdate"))
            if update and (updated_at is None or update > updated_at):
                updated_at = update
            period = _as_number(item.get("idPeriodo"), integer=True)
            if period in (1, 3):
                timestamp = _utc_timestamp(item.get("dataPrev"))
                if timestamp is None:
                    continue
                code = _as_weather_code(item.get("idTipoTempo"))
                row = {
                    "time": timestamp,
                    "temp": _as_number(item.get("tMed")),
                    "feelsLike": _as_number(item.get("utci")),
                    "rain": _as_number(item.get("probabilidadePrecipita")),
                    "wind": _as_number(item.get("ffVento")),
                    "direction": item.get("ddVento") if isinstance(item.get("ddVento"), str) else None,
                    "humidity": _as_number(item.get("hR")),
                    "weatherCode": code,
                    "description": _description(code),
                }
                # Prefer an hourly (period 1) row if both period variants cover
                # the same timestamp; IPMA's own page does the same grouping.
                previous = hourly.get(timestamp)
                if previous is None or period < previous[0]:
                    hourly[timestamp] = (period, row)
                recognized = True
            elif period == 24:
                date = _date_only(item.get("dataPrev"))
                if date is None:
                    continue
                code = _as_weather_code(item.get("idTipoTempo"))
                daily[date] = {
                    "date": date,
                    "min": _as_number(item.get("tMin")),
                    "max": _as_number(item.get("tMax")),
                    "rain": _as_number(item.get("probabilidadePrecipita")),
                    "weatherCode": code,
                    "description": _description(code),
                }
                recognized = True
        if not recognized:
            raise UpstreamError("IPMA aggregate payload contained no forecast rows")
        fetched_at = self._iso_clock()
        return {
            "location": _copy(location),
            "updatedAt": updated_at,
            "fetchedAt": fetched_at,
            "sourceUrl": source_url,
            "hours": [hourly[key][1] for key in sorted(hourly)],
            "days": [daily[key] for key in sorted(daily)],
            "stale": False,
        }

    def _from_daily(
        self, location: Mapping[str, Any], raw: Any, source_url: str
    ) -> dict[str, Any]:
        if not isinstance(raw, Mapping) or not isinstance(raw.get("data"), list):
            raise UpstreamError("IPMA daily payload has an invalid shape")
        days: list[dict[str, Any]] = []
        updated_at = _utc_timestamp(raw.get("dataUpdate"))
        for item in raw["data"]:
            if not isinstance(item, Mapping):
                continue
            date = _date_only(item.get("forecastDate"))
            if date is None:
                continue
            code = _as_weather_code(item.get("idWeatherType"))
            days.append(
                {
                    "date": date,
                    "min": _as_number(item.get("tMin")),
                    "max": _as_number(item.get("tMax")),
                    "rain": _as_number(item.get("precipitaProb")),
                    "weatherCode": code,
                    "description": _description(code),
                }
            )
        if not days:
            raise UpstreamError("IPMA daily payload contained no forecast days")
        days.sort(key=lambda item: item["date"])
        return {
            "location": _copy(location),
            "updatedAt": updated_at,
            "fetchedAt": self._iso_clock(),
            "sourceUrl": source_url,
            "hours": [],
            "days": days,
            "stale": False,
        }


SERVICE = WeatherService()


class WeatherHandler(BaseHTTPRequestHandler):
    """GET-only HTTP surface for static assets and normalized weather JSON."""

    server_version = "IPMAWeather/1.0"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(CLIENT_SOCKET_TIMEOUT_SECONDS)
        self.rfile = _DeadlineReader(self.rfile, self.connection)

    def handle_one_request(self) -> None:
        self.rfile.start_deadline()
        super().handle_one_request()

    def parse_request(self) -> bool:
        try:
            return super().parse_request()
        finally:
            self.connection.settimeout(CLIENT_SOCKET_TIMEOUT_SECONDS)

    @staticmethod
    def _security_headers() -> dict[str, str]:
        return {
            "Content-Security-Policy": CONTENT_SECURITY_POLICY,
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
        }

    def _send_security_headers(self) -> None:
        for name, value in self._security_headers().items():
            self.send_header(name, value)

    def _send_json(self, status: int, value: Any) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(payload)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_header_json(self, status: int, value: Any, headers: Mapping[str, str]) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._send_security_headers()
        for name, header_value in headers.items():
            self.send_header(name, header_value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlsplit(self.path)
        path = parsed.path
        try:
            if path == "/healthz":
                self._send_json(HTTPStatus.OK, {"ok": True})
                return
            if path == "/api/locations":
                locations, stale = SERVICE.locations()
                if stale:
                    self._send_header_json(HTTPStatus.OK, locations, {"X-IPMA-Stale": "true"})
                else:
                    self._send_json(HTTPStatus.OK, locations)
                return
            if path == "/api/weather":
                self._handle_weather(parse_qs(parsed.query, keep_blank_values=True))
                return
            if path in {
                "/",
                "/index.html",
                "/app.js",
                "/style.css",
                "/vendor/liquidGL.js",
                "/vendor/LICENSE.txt",
            }:
                self._serve_static("/index.html" if path == "/" else path)
                return
            self._send_error_json(HTTPStatus.NOT_FOUND, "not found")
        except KeyError:
            self._send_error_json(HTTPStatus.NOT_FOUND, "unknown location")
        except UpstreamError:
            self._send_error_json(HTTPStatus.BAD_GATEWAY, "weather provider unavailable")
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "internal server error")

    def _handle_weather(self, query: Mapping[str, list[str]]) -> None:
        values = query.get("id", [])
        if len(values) != 1 or not values[0].isdigit():
            self._send_error_json(HTTPStatus.BAD_REQUEST, "id must be a numeric location id")
            return
        try:
            location_id = int(values[0])
        except ValueError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "id must be a numeric location id")
            return
        if location_id <= 0:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "id must be a numeric location id")
            return
        self._send_json(HTTPStatus.OK, SERVICE.weather(location_id))

    def _serve_static(self, path: str) -> None:
        relative = {
            "/index.html": "index.html",
            "/app.js": "app.js",
            "/style.css": "style.css",
            "/vendor/liquidGL.js": "vendor/liquidGL.js",
            "/vendor/LICENSE.txt": "vendor/LICENSE.txt",
        }[path]
        target = PUBLIC_DIR / relative
        try:
            payload = target.read_bytes()
        except OSError:
            self._send_error_json(HTTPStatus.NOT_FOUND, "not found")
            return
        content_type = {
            "vendor/liquidGL.js": "application/javascript",
            "vendor/LICENSE.txt": "text/plain",
        }.get(relative, mimetypes.guess_type(relative)[0] or "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(payload)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        # Keep method errors on the same JSON/security-header surface as the
        # explicit API errors instead of emitting an unbounded HTML response.
        self._send_error_json(code, message or HTTPStatus(code).phrase)

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "GET required")

    def do_PUT(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "GET required")

    def do_DELETE(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "GET required")

    def log_message(self, format: str, *args: Any) -> None:
        # Keep the default access log useful in Docker without leaking query
        # values (which may contain malformed or untrusted input).
        safe_args = list(args)
        if safe_args and isinstance(safe_args[0], str):
            request_line = safe_args[0]
            parts = request_line.split(" ", 2)
            if len(parts) == 3:
                safe_args[0] = f"{parts[0]} {urlsplit(parts[1]).path} {parts[2]}"
        try:
            rendered = format % tuple(safe_args)
        except (TypeError, ValueError):
            rendered = format
        super().log_message("%s", rendered)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Cap concurrent request threads so a slow upstream cannot exhaust it."""

    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], request_handler: type[BaseHTTPRequestHandler]):
        super().__init__(server_address, request_handler)
        self._request_slots = threading.BoundedSemaphore(MAX_HANDLER_THREADS)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


def run() -> None:
    server = BoundedThreadingHTTPServer((HOST, PORT), WeatherHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
