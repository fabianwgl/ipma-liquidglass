import json
import socket
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

import server


LOCATIONS = [
    {
        "globalIdLocal": 1110600,
        "local": "Lisboa",
        "latitude": "38.7660",
        "longitude": "-9.1286",
        "idRegiao": 1,
    },
    {
        "globalIdLocal": 3410300,
        "local": "Ponta Delgada",
        "latitude": "37.7415",
        "longitude": "-25.6677",
        "idRegiao": 3,
    },
]

AGGREGATE = [
    {
        "idPeriodo": 24,
        "dataPrev": "2026-09-18T00:00:00",
        "dataUpdate": "2026-09-18T07:55:43",
        "tMin": "15.6",
        "tMax": "28.0",
        "probabilidadePrecipita": "0.0",
        "idTipoTempo": 2,
    },
    {
        "idPeriodo": 1,
        "dataPrev": "2026-09-18T08:00:00",
        "dataUpdate": "2026-09-18T07:55:43",
        "tMed": "17.7",
        "utci": "16.8",
        "probabilidadePrecipita": "-99.0",
        "ffVento": "14.0",
        "ddVento": "NW",
        "hR": "75.1",
        "idTipoTempo": 1,
    },
]

DAILY = {
    "dataUpdate": "2026-09-18T12:31:02",
    "data": [
        {
            "forecastDate": "2026-09-18",
            "tMin": "15.6",
            "tMax": "28.0",
            "precipitaProb": "0.0",
            "idWeatherType": 2,
        }
    ],
}


class FakeClock:
    def __init__(self):
        self.value = 1_000.0

    def __call__(self):
        return self.value


class WeatherServiceTests(unittest.TestCase):
    def test_upstream_allowlist_rejects_ssrf_and_unapproved_redirect_targets(self):
        self.assertTrue(server._is_allowed_upstream_url(server.LOCATIONS_URL))
        self.assertTrue(server._is_allowed_upstream_url(server.AGGREGATE_URL.format(id=1110600)))
        self.assertFalse(server._is_allowed_upstream_url("http://api.ipma.pt/public-data/forecast/locations.json"))
        self.assertFalse(server._is_allowed_upstream_url("https://127.0.0.1/public-data/forecast/locations.json"))
        self.assertFalse(server._is_allowed_upstream_url("https://api.ipma.pt/public-data/forecast/locations.json?next=https://evil.test"))
        self.assertFalse(server._is_allowed_upstream_url("https://api.ipma.pt/public-data/forecast/aggregate/0.json"))
        self.assertFalse(server._is_allowed_upstream_url("https://evil.test/public-data/forecast/locations.json"))

    def test_request_header_reader_enforces_one_absolute_deadline(self):
        left, right = socket.socketpair()
        reader = left.makefile("rb")
        deadline_reader = server._DeadlineReader(reader, left)
        original_deadline = server.REQUEST_HEADER_DEADLINE_SECONDS
        server.REQUEST_HEADER_DEADLINE_SECONDS = 0.12
        deadline_reader.start_deadline()

        def trickle():
            try:
                for byte in b"GET / HTTP/1.1\r\n":
                    right.send(bytes([byte]))
                    time.sleep(0.04)
            except OSError:
                pass

        sender = threading.Thread(target=trickle)
        sender.start()
        try:
            with self.assertRaises(TimeoutError):
                deadline_reader.readline(65537)
        finally:
            server.REQUEST_HEADER_DEADLINE_SECONDS = original_deadline
            deadline_reader.close()
            left.close()
            right.close()
            sender.join(timeout=1)

    def test_normalizes_official_aggregate_schema(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if url == server.LOCATIONS_URL:
                return LOCATIONS
            if url == server.AGGREGATE_URL.format(id=1110600):
                return AGGREGATE
            raise AssertionError(url)

        service = server.WeatherService(fetch, iso_clock=lambda: "2026-09-18T12:40:00Z")
        result = service.weather(1110600)

        self.assertEqual(result["location"]["timezone"], "Europe/Lisbon")
        self.assertEqual(result["location"]["lat"], 38.766)
        self.assertEqual(result["hours"][0]["time"], "2026-09-18T08:00:00Z")
        self.assertEqual(result["hours"][0]["temp"], 17.7)
        self.assertEqual(result["hours"][0]["feelsLike"], 16.8)
        self.assertIsNone(result["hours"][0]["rain"])
        self.assertEqual(result["hours"][0]["weatherCode"], 1)
        self.assertEqual(result["hours"][0]["description"], "Céu limpo")
        self.assertEqual(result["days"][0]["min"], 15.6)
        self.assertEqual(result["days"][0]["max"], 28.0)
        self.assertFalse(result["stale"])
        self.assertEqual(calls.count(server.LOCATIONS_URL), 1)

    def test_locations_normalize_region_timezone_and_reject_unknown_weather_id(self):
        def fetch(url):
            if url == server.LOCATIONS_URL:
                return LOCATIONS
            raise AssertionError(url)

        service = server.WeatherService(fetch)
        locations, stale = service.locations()
        self.assertFalse(stale)
        self.assertEqual(locations[1]["timezone"], "Atlantic/Azores")
        self.assertEqual(locations[1]["id"], 3410300)
        with self.assertRaises(KeyError):
            service.weather(9999999)

    def test_daily_endpoint_is_a_fresh_fallback_when_hourly_fails(self):
        def fetch(url):
            if url == server.LOCATIONS_URL:
                return LOCATIONS
            if url == server.AGGREGATE_URL.format(id=1110600):
                raise server.UpstreamError("hourly unavailable")
            if url == server.DAILY_URL.format(id=1110600):
                return DAILY
            raise AssertionError(url)

        service = server.WeatherService(fetch, iso_clock=lambda: "2026-09-18T12:40:00Z")
        result = service.weather(1110600)
        self.assertEqual(result["hours"], [])
        self.assertEqual(result["days"][0]["weatherCode"], 2)
        self.assertEqual(result["sourceUrl"], server.DAILY_URL.format(id=1110600))
        self.assertFalse(result["stale"])

    def test_cached_forecast_is_labelled_stale_after_both_sources_fail(self):
        clock = FakeClock()
        failing = False

        def fetch(url):
            nonlocal failing
            if url == server.LOCATIONS_URL:
                return LOCATIONS
            if failing:
                raise server.UpstreamError("offline")
            if url == server.AGGREGATE_URL.format(id=1110600):
                return AGGREGATE
            raise AssertionError(url)

        service = server.WeatherService(fetch, clock=clock, iso_clock=lambda: "2026-09-18T12:40:00Z")
        first = service.weather(1110600)
        failing = True
        clock.value += server.WEATHER_TTL_SECONDS + 1
        stale = service.weather(1110600)
        self.assertFalse(first["stale"])
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["fetchedAt"], first["fetchedAt"])


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.old_service = server.SERVICE
        self.service = server.WeatherService(lambda url: LOCATIONS if url == server.LOCATIONS_URL else AGGREGATE)
        server.SERVICE = self.service
        try:
            self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.WeatherHandler)
        except PermissionError:
            server.SERVICE = self.old_service
            self.skipTest("socket creation is unavailable in this test sandbox")
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.httpd.server_address

    def tearDown(self):
        self.httpd.shutdown()
        self.thread.join(timeout=2)
        self.httpd.server_close()
        server.SERVICE = self.old_service

    def get(self, path):
        connection = HTTPConnection(self.host, self.port, timeout=2)
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, response.getheader("Content-Type"), body

    def test_health_and_allowlisted_api_shapes(self):
        status, content_type, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertIn("application/json", content_type)
        self.assertEqual(json.loads(body), {"ok": True})

        status, _, body = self.get("/api/locations")
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), list)

        status, _, body = self.get("/api/weather?id=1110600")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["location"]["id"], 1110600)

    def test_invalid_and_unknown_paths_are_rejected(self):
        self.assertEqual(self.get("/api/weather?id=https://evil.test")[0], 400)
        self.assertEqual(self.get("/api/weather?id=9999999")[0], 404)
        self.assertEqual(self.get("/etc/passwd")[0], 404)


if __name__ == "__main__":
    unittest.main()
