from __future__ import annotations

import argparse
import json
import mmap
import os
import re
import struct
import time
import uuid
from copy import deepcopy
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SESSIONS_FILE = DATA_DIR / "sessions.json"
EASTMONEY_ROOT = Path(os.environ.get("EASTMONEY_ROOT", r"C:\eastmoney"))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BAR_CACHE_TTL_SECONDS = 15 * 60
MAX_STALE_QUOTE_DAYS = 370
VOLUME_RATIO_DAYS = 5
EM_ENTRY_SIZE = 516
EM_RECORD_SIZE = 40
EM_RECORDS_PER_BLOCK = 400
EM_FILE_HEADER_SIZE = 48
EM_BLOCK_ID_OFFSET = 32
STOCK_CODE_RE = re.compile(r"^\d{6}$")

STOCKS: list[dict[str, Any]] = [
    {"symbol": "000001", "name": "平安银行", "market": "SZ"},
    {"symbol": "600519", "name": "贵州茅台", "market": "SH"},
    {"symbol": "300750", "name": "宁德时代", "market": "SZ"},
    {"symbol": "601318", "name": "中国平安", "market": "SH"},
    {"symbol": "000858", "name": "五粮液", "market": "SZ"},
    {"symbol": "002594", "name": "比亚迪", "market": "SZ"},
    {"symbol": "600036", "name": "招商银行", "market": "SH"},
    {"symbol": "688981", "name": "中芯国际", "market": "SH"},
]
FALLBACK_NAMES = {stock["symbol"]: stock["name"] for stock in STOCKS}

ADJUST_FLAGS = {
    "none": "0",
    "qfq": "1",
    "hfq": "2",
}

BAR_CACHE: dict[tuple[str, str, str, str, int], tuple[float, dict[str, Any]]] = {}
FULL_BAR_CACHE: dict[tuple[str, str, int], tuple[float, list[dict[str, Any]]]] = {}
NAME_CACHE: dict[str, Any] = {"signature": None, "names": {}}
STOCK_UNIVERSE_CACHE: dict[str, Any] = {"signature": None, "time": 0.0, "stocks": []}
QUOTE_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def stock_by_symbol(symbol: str) -> dict[str, Any] | None:
    return next((stock for stock in load_stock_universe() if stock["symbol"] == symbol), None)


def parse_date(value: str, field: str = "date") -> str:
    if not DATE_RE.match(value):
        raise ValueError(f"{field} must use YYYY-MM-DD")
    datetime.strptime(value, "%Y-%m-%d")
    return value


def date_int(value: str) -> int:
    return int(value.replace("-", ""))


def date_string(value: int) -> str:
    return f"{value // 10000:04d}-{(value // 100) % 100:02d}-{value % 100:02d}"


def is_weekday_date(value: str) -> bool:
    return datetime.strptime(value, "%Y-%m-%d").weekday() < 5


def days_between(start: str, end: str) -> int:
    return (datetime.strptime(end, "%Y-%m-%d") - datetime.strptime(start, "%Y-%m-%d")).days


def parse_adjust(value: str | None) -> str:
    if not value:
        return "qfq"
    if value not in ADJUST_FLAGS:
        raise ValueError("adjust must be one of none, qfq, hfq")
    return value


def parse_float(value: str, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def parse_int(value: str, fallback: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def eastmoney_day_file(market: str) -> Path:
    if market == "SH":
        return EASTMONEY_ROOT / "swc8" / "data" / "SHANGHAI" / "DayData_SH_V43.dat"
    if market == "SZ":
        return EASTMONEY_ROOT / "swc8" / "data" / "SHENZHEN" / "DayData_SZ_V43.dat"
    raise ValueError(f"unsupported market: {market}")


def eastmoney_quote_name_files() -> list[Path]:
    return [
        EASTMONEY_ROOT / "swc8" / "data" / "StkQuoteList" / "StkQuoteList_V10_0.dat",
        EASTMONEY_ROOT / "swc8" / "data" / "StkQuoteList" / "StkQuoteList_V10_1.dat",
    ]


def file_signature(paths: list[Path]) -> tuple[tuple[str, int, int], ...]:
    signature: list[tuple[str, int, int]] = []
    for path in paths:
        if not path.exists():
            signature.append((str(path), 0, 0))
            continue
        stat = path.stat()
        signature.append((str(path), stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


def public_stock(stock: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": stock["symbol"],
        "name": stock["name"],
        "market": stock["market"],
    }


def public_quote(quote: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in quote.items() if not key.startswith("_")}


def is_a_share_code(symbol: str, market: str) -> bool:
    if not STOCK_CODE_RE.match(symbol):
        return False
    if market == "SH":
        return symbol.startswith(("600", "601", "603", "605", "688", "689"))
    if market == "SZ":
        return symbol.startswith(("000", "001", "002", "003", "300", "301"))
    return False


def chinese_score(text: str) -> int:
    chinese_count = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    if chinese_count == 0:
        return 0
    ascii_count = sum(1 for char in text if char.isascii() and char.isalnum())
    return chinese_count * 4 + min(len(text), 12) - ascii_count


def clean_stock_name(text: str) -> str:
    text = re.sub(r"[\x00-\x1f]+", "", text).strip()
    text = re.sub(r"\s+", "", text)
    return text[:24]


def extract_name_before_code(raw: bytes, offset: int) -> str:
    window = raw[max(0, offset - 120) : offset]
    best = ""
    best_score = 0
    for segment in window.split(b"\x00"):
        segment = segment.strip()
        if len(segment) < 4 or len(segment) > 64:
            continue
        try:
            text = clean_stock_name(segment.decode("gb18030", errors="ignore"))
        except UnicodeDecodeError:
            continue
        score = chinese_score(text)
        if 2 <= len(text) <= 24 and score >= best_score:
            best = text
            best_score = score
    return best


def build_name_map() -> dict[str, str]:
    paths = eastmoney_quote_name_files()
    signature = file_signature(paths)
    if NAME_CACHE["signature"] == signature:
        return dict(NAME_CACHE["names"])

    names: dict[str, str] = dict(FALLBACK_NAMES)
    for path in paths:
        if not path.exists():
            continue
        raw = path.read_bytes()
        for match in re.finditer(rb"(?<!\d)(\d{6})(?!\d)", raw):
            symbol = match.group(1).decode("ascii", errors="ignore")
            name = extract_name_before_code(raw, match.start())
            if name:
                names.setdefault(symbol, name)

    NAME_CACHE["signature"] = signature
    NAME_CACHE["names"] = dict(names)
    return names


def read_stock_index_for_market(market: str, names: dict[str, str]) -> list[dict[str, Any]]:
    day_file = eastmoney_day_file(market)
    if not day_file.exists():
        return []

    stocks: list[dict[str, Any]] = []
    seen: set[str] = set()
    with day_file.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            capacity = struct.unpack_from("<I", mm, 20)[0]
            for slot in range(capacity):
                entry_offset = EM_FILE_HEADER_SIZE + slot * EM_ENTRY_SIZE
                if entry_offset + EM_ENTRY_SIZE > mm.size():
                    break
                raw_code = mm[entry_offset : entry_offset + 16].split(b"\x00", 1)[0]
                try:
                    symbol = raw_code.decode("ascii")
                except UnicodeDecodeError:
                    continue
                if symbol in seen or not is_a_share_code(symbol, market):
                    continue
                total_days = struct.unpack_from("<I", mm, entry_offset + 24)[0]
                if total_days <= 0:
                    continue
                seen.add(symbol)
                stocks.append(
                    {
                        "symbol": symbol,
                        "name": names.get(symbol) or symbol,
                        "market": market,
                        "_entry_offset": entry_offset,
                        "_day_file": str(day_file),
                        "_total_days": int(total_days),
                    }
                )
    return stocks


def load_stock_universe() -> list[dict[str, Any]]:
    if STOCK_UNIVERSE_CACHE["stocks"] and time.time() - STOCK_UNIVERSE_CACHE["time"] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(STOCK_UNIVERSE_CACHE["stocks"])

    paths = [eastmoney_day_file("SH"), eastmoney_day_file("SZ"), *eastmoney_quote_name_files()]
    signature = file_signature(paths)
    if STOCK_UNIVERSE_CACHE["signature"] == signature:
        STOCK_UNIVERSE_CACHE["time"] = time.time()
        return deepcopy(STOCK_UNIVERSE_CACHE["stocks"])

    names = build_name_map()
    stocks = read_stock_index_for_market("SH", names) + read_stock_index_for_market("SZ", names)
    stocks.sort(key=lambda item: (item["market"], item["symbol"]))
    STOCK_UNIVERSE_CACHE["signature"] = signature
    STOCK_UNIVERSE_CACHE["time"] = time.time()
    STOCK_UNIVERSE_CACHE["stocks"] = deepcopy(stocks)
    return stocks


def valid_em_date(value: int) -> bool:
    year = value // 10000
    month = (value // 100) % 100
    day = value % 100
    return 1990 <= year <= 2030 and 1 <= month <= 12 and 1 <= day <= 31


def find_eastmoney_entry(mm: mmap.mmap, symbol: str, data_start: int) -> int:
    code = symbol.encode("ascii")
    start = EM_FILE_HEADER_SIZE
    while True:
      offset = mm.find(code, start, data_start)
      if offset < 0:
          return -1
      if (offset - EM_FILE_HEADER_SIZE) % EM_ENTRY_SIZE == 0:
          return offset
      start = offset + 1


def read_all_local_bars(symbol: str, stock: dict[str, Any], day_file: Path, file_mtime_ns: int) -> list[dict[str, Any]]:
    full_cache_key = (symbol, stock["market"], file_mtime_ns)
    cached = FULL_BAR_CACHE.get(full_cache_key)
    if cached and time.time() - cached[0] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(cached[1])

    bars_by_date: dict[str, dict[str, Any]] = {}
    block_size = EM_RECORDS_PER_BLOCK * EM_RECORD_SIZE

    with day_file.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            capacity = struct.unpack_from("<I", mm, 20)[0]
            records_per_block = struct.unpack_from("<I", mm, 16)[0] or EM_RECORDS_PER_BLOCK
            data_start = EM_FILE_HEADER_SIZE + capacity * EM_ENTRY_SIZE
            entry_offset = int(stock.get("_entry_offset") or -1)
            if entry_offset < EM_FILE_HEADER_SIZE or entry_offset + EM_ENTRY_SIZE > data_start:
                entry_offset = find_eastmoney_entry(mm, symbol, data_start)
            else:
                raw_code = mm[entry_offset : entry_offset + 16].split(b"\x00", 1)[0]
                if raw_code != symbol.encode("ascii"):
                    entry_offset = find_eastmoney_entry(mm, symbol, data_start)
            if entry_offset < 0:
                raise RuntimeError(f"{symbol} not found in eastmoney local day data")

            total_days = struct.unpack_from("<I", mm, entry_offset + 24)[0]
            raw_block_count = (EM_ENTRY_SIZE - EM_BLOCK_ID_OFFSET) // 4
            used_block_count = min(raw_block_count, max(1, (total_days + records_per_block - 1) // records_per_block))
            block_ids = struct.unpack_from(f"<{raw_block_count}I", mm, entry_offset + EM_BLOCK_ID_OFFSET)
            block_ids = [block_id for block_id in block_ids[:used_block_count] if block_id != 0xFFFFFFFF]

            for block_id in block_ids:
                block_offset = data_start + block_id * block_size
                if block_offset < data_start or block_offset >= mm.size():
                    continue
                for row in range(records_per_block):
                    record_offset = block_offset + row * EM_RECORD_SIZE
                    if record_offset + EM_RECORD_SIZE > mm.size():
                        break
                    date_value = struct.unpack_from("<I", mm, record_offset)[0]
                    if not valid_em_date(date_value):
                        continue
                    date = f"{date_value // 10000:04d}-{(date_value // 100) % 100:02d}-{date_value % 100:02d}"
                    _, _, open_price, close, high, low, volume, _, amount = struct.unpack_from(
                        "<IIffffIId", mm, record_offset
                    )
                    if close <= 0 or open_price <= 0:
                        continue
                    bars_by_date[date] = {
                        "date": date,
                        "open": round(open_price, 4),
                        "high": round(high, 4),
                        "low": round(low, 4),
                        "close": round(close, 4),
                        "volume": int(volume),
                        "amount": round(amount, 2),
                        "turnover": 0,
                        "suspended": volume <= 0,
                    }

    bars = [bars_by_date[date] for date in sorted(bars_by_date)]
    previous_close: float | None = None
    for bar in bars:
        close = bar["close"]
        prev = previous_close
        change = close - prev if prev else 0.0
        pct = (change / prev) * 100 if prev else 0.0
        amplitude_pct = ((bar["high"] - bar["low"]) / prev) * 100 if prev else 0.0
        bar["change"] = round(change, 4)
        bar["pct"] = round(pct, 4)
        bar["amplitudePct"] = round(amplitude_pct, 4)
        bar["prevClose"] = prev
        previous_close = close

    FULL_BAR_CACHE[full_cache_key] = (time.time(), deepcopy(bars))
    return bars


def read_day_record(mm: mmap.mmap, offset: int) -> dict[str, Any] | None:
    if offset + EM_RECORD_SIZE > mm.size():
        return None
    date_value = struct.unpack_from("<I", mm, offset)[0]
    if not valid_em_date(date_value):
        return None
    _, _, open_price, close, high, low, volume, _, amount = struct.unpack_from("<IIffffIId", mm, offset)
    if open_price <= 0 or close <= 0:
        return None
    return {
        "date": date_string(date_value),
        "_date_value": date_value,
        "open": round(open_price, 4),
        "high": round(high, 4),
        "low": round(low, 4),
        "close": round(close, 4),
        "volume": int(volume),
        "amount": round(amount, 2),
    }


def read_entry_block_ids(mm: mmap.mmap, entry_offset: int, total_days: int, records_per_block: int) -> list[int]:
    raw_block_count = (EM_ENTRY_SIZE - EM_BLOCK_ID_OFFSET) // 4
    used_block_count = min(raw_block_count, max(1, (total_days + records_per_block - 1) // records_per_block))
    block_ids = struct.unpack_from(f"<{raw_block_count}I", mm, entry_offset + EM_BLOCK_ID_OFFSET)
    return [block_id for block_id in block_ids[:used_block_count] if block_id != 0xFFFFFFFF]


def read_day_record_at_index(
    mm: mmap.mmap,
    block_ids: list[int],
    logical_index: int,
    data_start: int,
    records_per_block: int,
) -> dict[str, Any] | None:
    if logical_index < 0:
        return None
    block_index = logical_index // records_per_block
    row = logical_index % records_per_block
    if block_index >= len(block_ids):
        return None
    block_size = records_per_block * EM_RECORD_SIZE
    record_offset = data_start + block_ids[block_index] * block_size + row * EM_RECORD_SIZE
    return read_day_record(mm, record_offset)


def find_latest_record_index(
    mm: mmap.mmap,
    block_ids: list[int],
    total_days: int,
    as_of_value: int,
    data_start: int,
    records_per_block: int,
) -> int:
    left = 0
    right = total_days - 1
    answer = -1
    while left <= right:
        mid = (left + right) // 2
        record = read_day_record_at_index(mm, block_ids, mid, data_start, records_per_block)
        if not record:
            right = mid - 1
            continue
        record_date = int(record["_date_value"])
        if record_date <= as_of_value:
            answer = mid
            left = mid + 1
        else:
            right = mid - 1
    return answer


def volume_ratio_at_index(
    mm: mmap.mmap,
    block_ids: list[int],
    latest_index: int,
    latest_volume: int,
    data_start: int,
    records_per_block: int,
) -> float | None:
    if latest_index <= 0:
        return None
    volumes: list[int] = []
    start = max(0, latest_index - VOLUME_RATIO_DAYS)
    for logical_index in range(start, latest_index):
        record = read_day_record_at_index(mm, block_ids, logical_index, data_start, records_per_block)
        if record and record["volume"] > 0:
            volumes.append(int(record["volume"]))
    if not volumes:
        return None
    average = sum(volumes) / len(volumes)
    if average <= 0:
        return None
    return round(latest_volume / average, 4)


def read_latest_snapshot(
    mm: mmap.mmap,
    stock: dict[str, Any],
    as_of_value: int,
    as_of_date: str,
    data_start: int,
    records_per_block: int,
) -> dict[str, Any] | None:
    entry_offset = int(stock.get("_entry_offset") or -1)
    if entry_offset < EM_FILE_HEADER_SIZE or entry_offset + EM_ENTRY_SIZE > data_start:
        return None

    total_days = int(stock.get("_total_days") or struct.unpack_from("<I", mm, entry_offset + 24)[0])
    if total_days <= 0:
        return None
    block_ids = read_entry_block_ids(mm, entry_offset, total_days, records_per_block)
    last_index = total_days - 1
    last_record = read_day_record_at_index(mm, block_ids, last_index, data_start, records_per_block)
    if last_record and int(last_record["_date_value"]) <= as_of_value:
        latest_index = last_index
    else:
        latest_index = find_latest_record_index(mm, block_ids, total_days, as_of_value, data_start, records_per_block)
    if latest_index < 0:
        return None

    latest = (
        last_record
        if latest_index == last_index and last_record and int(last_record["_date_value"]) <= as_of_value
        else read_day_record_at_index(mm, block_ids, latest_index, data_start, records_per_block)
    )
    previous = read_day_record_at_index(mm, block_ids, latest_index - 1, data_start, records_per_block)

    if latest is None:
        return None
    if days_between(latest["date"], as_of_date) > MAX_STALE_QUOTE_DAYS:
        return None

    prev_close = previous["close"] if previous else None
    change = latest["close"] - prev_close if prev_close else 0.0
    pct = (change / prev_close) * 100 if prev_close else 0.0
    amplitude_pct = ((latest["high"] - latest["low"]) / prev_close) * 100 if prev_close else 0.0
    volume_ratio = volume_ratio_at_index(
        mm, block_ids, latest_index, latest["volume"], data_start, records_per_block
    )
    suspended = latest["date"] < as_of_date and is_weekday_date(as_of_date)

    quote = {
        "symbol": stock["symbol"],
        "name": stock["name"],
        "market": stock["market"],
        "date": latest["date"],
        "open": latest["open"],
        "high": latest["high"],
        "low": latest["low"],
        "close": latest["close"],
        "prevClose": prev_close,
        "change": round(change, 4),
        "pct": round(pct, 4),
        "volumeRatio": volume_ratio,
        "volume": latest["volume"],
        "amount": latest["amount"],
        "turnover": 0,
        "amplitudePct": round(amplitude_pct, 4),
        "suspended": suspended or latest["volume"] <= 0,
    }
    return quote


def load_market_quotes(as_of_date: str) -> list[dict[str, Any]]:
    cached = QUOTE_CACHE.get(as_of_date)
    if cached and time.time() - cached[0] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(cached[1])

    stocks = load_stock_universe()
    by_market = {
        "SH": [stock for stock in stocks if stock["market"] == "SH"],
        "SZ": [stock for stock in stocks if stock["market"] == "SZ"],
    }
    quotes: list[dict[str, Any]] = []
    as_of_value = date_int(as_of_date)

    for market, market_stocks in by_market.items():
        day_file = eastmoney_day_file(market)
        if not day_file.exists() or not market_stocks:
            continue
        with day_file.open("rb") as handle:
            with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                capacity = struct.unpack_from("<I", mm, 20)[0]
                records_per_block = struct.unpack_from("<I", mm, 16)[0] or EM_RECORDS_PER_BLOCK
                data_start = EM_FILE_HEADER_SIZE + capacity * EM_ENTRY_SIZE
                for stock in market_stocks:
                    quote = read_latest_snapshot(mm, stock, as_of_value, as_of_date, data_start, records_per_block)
                    if quote:
                        quotes.append(quote)

    quotes.sort(key=lambda item: (item["market"], item["symbol"]))
    QUOTE_CACHE[as_of_date] = (time.time(), deepcopy(quotes))

    # Keep at most a few snapshots; data files can be large and users scrub dates while reviewing.
    if len(QUOTE_CACHE) > 6:
        oldest = sorted(QUOTE_CACHE.items(), key=lambda item: item[1][0])[:-6]
        for key, _ in oldest:
            QUOTE_CACHE.pop(key, None)

    return quotes


def fetch_bars(symbol: str, as_of_date: str, adjust: str, start_date: str) -> dict[str, Any]:
    stock = stock_by_symbol(symbol)
    if stock is None:
        raise ValueError(f"unknown symbol: {symbol}")

    day_file = eastmoney_day_file(stock["market"])
    if not day_file.exists():
        raise RuntimeError(f"eastmoney local day file not found: {day_file}")

    file_mtime_ns = day_file.stat().st_mtime_ns
    cache_key = (symbol, as_of_date, adjust, start_date, file_mtime_ns)
    cached = BAR_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(cached[1])

    all_bars = read_all_local_bars(symbol, stock, day_file, file_mtime_ns)
    bars = [bar for bar in all_bars if start_date <= bar["date"] <= as_of_date]

    result = {
        "symbol": stock["symbol"],
        "name": stock["name"],
        "market": stock["market"],
        "adjust": adjust,
        "as_of_date": as_of_date,
        "source": "eastmoney_local_day_v43",
        "source_path": str(day_file),
        "bars": bars,
    }
    BAR_CACHE[cache_key] = (time.time(), deepcopy(result))
    return result


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(exist_ok=True)


def read_sessions() -> list[dict[str, Any]]:
    ensure_data_dir()
    if not SESSIONS_FILE.exists():
        return []
    try:
        return json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def write_sessions(sessions: list[dict[str, Any]]) -> None:
    ensure_data_dir()
    tmp = SESSIONS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SESSIONS_FILE)


def summarize_session(session: dict[str, Any]) -> dict[str, Any]:
    trades = session.get("trades") or []
    return {
        "id": session["id"],
        "name": session.get("name") or "未命名复盘",
        "symbol": session.get("symbol"),
        "as_of_date": session.get("as_of_date"),
        "trade_count": len(trades),
        "created_at": session.get("created_at"),
        "updated_at": session.get("updated_at"),
    }


class BacktesterHandler(SimpleHTTPRequestHandler):
    server_version = "StockBacktesterPrototype/0.2"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed.path, parse_qs(parsed.query))
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_post(parsed.path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        try:
            if path == "/api/health":
                self.send_json({"ok": True, "source": "eastmoney_local_day_v43", "root": str(EASTMONEY_ROOT)})
                return

            if path == "/api/stocks":
                self.send_json({"stocks": [public_stock(stock) for stock in load_stock_universe()]})
                return

            if path == "/api/quotes":
                as_of_date = parse_date(self.required_query(query, "as_of_date"), "as_of_date")
                market = query.get("market", ["all"])[0].upper()
                limit = parse_int(query.get("limit", ["0"])[0], 0)
                quotes = load_market_quotes(as_of_date)
                if market in {"SH", "SZ"}:
                    quotes = [quote for quote in quotes if quote["market"] == market]
                if limit > 0:
                    quotes = quotes[:limit]
                self.send_json(
                    {
                        "as_of_date": as_of_date,
                        "source": "eastmoney_local_day_v43",
                        "root": str(EASTMONEY_ROOT),
                        "count": len(quotes),
                        "quotes": [public_quote(quote) for quote in quotes],
                    }
                )
                return

            if path == "/api/bars":
                symbol = self.required_query(query, "symbol")
                as_of_date = parse_date(self.required_query(query, "as_of_date"), "as_of_date")
                start_date = parse_date(query.get("start_date", ["2020-01-01"])[0], "start_date")
                adjust = parse_adjust(query.get("adjust", ["qfq"])[0])
                self.send_json(fetch_bars(symbol, as_of_date, adjust, start_date))
                return

            if path == "/api/sessions":
                sessions = [summarize_session(session) for session in read_sessions()]
                sessions.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
                self.send_json({"sessions": sessions})
                return

            if path.startswith("/api/sessions/"):
                session_id = path.rsplit("/", 1)[-1]
                session = next((item for item in read_sessions() if item.get("id") == session_id), None)
                if session is None:
                    self.send_json({"error": "session not found"}, HTTPStatus.NOT_FOUND)
                    return
                as_of = query.get("as_of_date", [None])[0]
                if as_of:
                    as_of_date = parse_date(as_of, "as_of_date")
                    session = deepcopy(session)
                    session["trades"] = [
                        trade for trade in session.get("trades", []) if str(trade.get("date", "")) <= as_of_date
                    ]
                self.send_json({"session": session})
                return

            self.send_json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_GATEWAY)

    def handle_api_post(self, path: str) -> None:
        try:
            if path != "/api/sessions":
                self.send_json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)
                return

            payload = self.read_json_body()
            now = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
            session = {
                "id": str(uuid.uuid4()),
                "name": payload.get("name") or f"复盘 {now}",
                "symbol": payload.get("symbol"),
                "as_of_date": payload.get("as_of_date"),
                "trades": payload.get("trades") or [],
                "settings": payload.get("settings") or {},
                "drawings": payload.get("drawings") or [],
                "created_at": now,
                "updated_at": now,
            }
            sessions = read_sessions()
            sessions.append(session)
            write_sessions(sessions)
            self.send_json({"session": session}, HTTPStatus.CREATED)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            raise ValueError("request body is required")
        if length > 2_000_000:
            raise ValueError("request body is too large")
        raw = self.rfile.read(length).decode("utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("request body must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("request body must be an object")
        return payload

    @staticmethod
    def required_query(query: dict[str, list[str]], name: str) -> str:
        value = query.get(name, [""])[0].strip()
        if not value:
            raise ValueError(f"{name} is required")
        return value

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stock backtester prototype server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    ensure_data_dir()
    server = ThreadingHTTPServer((args.host, args.port), BacktesterHandler)
    print(f"Serving stock backtester at http://{args.host}:{args.port}")
    print(f"Market API: Eastmoney local day V43 data under {EASTMONEY_ROOT}, truncated by required as_of_date")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
