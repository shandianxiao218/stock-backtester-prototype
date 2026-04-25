from __future__ import annotations

import argparse
import json
import mmap
import os
import re
import sqlite3
import struct
import threading
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
PERF_LOG_FILE = DATA_DIR / "perf.log"
EASTMONEY_ROOT = Path(os.environ.get("EASTMONEY_ROOT", r"C:\eastmoney"))
DB_FILE = DATA_DIR / "eastmarket.db"
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

# mmap 文件缓存，避免每次请求都重新打开
MMAP_CACHE: dict[str, tuple[mmap.mmap, int, int, int, int]] = {}  # path -> (mm, capacity, records_per_block, data_start, mtime_ns)

# SQLite 数据库连接（线程安全）
DB_LOCK = threading.Lock()
DB_CONN: sqlite3.Connection | None = None

# 数据库重建状态（通过 C 程序执行，Python 仅读取进度）
DB_REBUILD_STATUS = {
    "in_progress": False,
    "progress": 0,
    "message": "",
    "started_at": None,
    "stats": None,
    "pid": None,  # C 进程 ID
}
DB_PROGRESS_FILE = DATA_DIR / "eastmarket.db.progress"  # C 程序写入的进度文件
DATA_IMPORT_EXE = ROOT / "data_import.exe"  # C 编译的数据导入程序


def get_db() -> sqlite3.Connection:
    """获取线程安全的数据库连接"""
    global DB_CONN
    if DB_CONN is None:
        ensure_data_dir()
        DB_CONN = sqlite3.connect(str(DB_FILE), check_same_thread=False)
        DB_CONN.execute("PRAGMA journal_mode=WAL")
        DB_CONN.execute("PRAGMA synchronous=NORMAL")
        DB_CONN.execute("PRAGMA cache_size=-64000")  # 64MB cache
    return DB_CONN


def init_database():
    """初始化数据库表结构"""
    conn = get_db()

    # 元数据表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    # 股票列表表（带预计算字段）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stocks (
            symbol TEXT PRIMARY KEY,
            name TEXT,
            market TEXT,
            last_date INTEGER,
            last_close REAL,
            last_volume INTEGER,
            total_bars INTEGER DEFAULT 0
        )
    """)

    # K线数据表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bars (
            symbol TEXT NOT NULL,
            date INTEGER NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            amount REAL,
            PRIMARY KEY (symbol, date)
        )
    """)

    # 预计算行情快照表：按日期直接取全市场，用于把日期切换压到 100ms 级别。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_quotes (
            symbol TEXT NOT NULL,
            date INTEGER NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            amount REAL,
            prev_close REAL,
            avg_volume_5 REAL
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS quote_snapshots (
            date INTEGER PRIMARY KEY,
            count INTEGER NOT NULL,
            quotes_json TEXT NOT NULL
        )
    """)

    # 创建索引以加速查询
    conn.execute("CREATE INDEX IF NOT EXISTS idx_bars_date ON bars(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_bars_symbol_date ON bars(symbol, date)")
    # DESC 顺序索引加速"最新记录"查询
    conn.execute("CREATE INDEX IF NOT EXISTS idx_bars_symbol_date_desc ON bars(symbol, date DESC)")
    # 市场索引加速全市场扫描
    conn.execute("CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_daily_quotes_date_symbol ON daily_quotes(date, symbol)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_quotes_symbol_date ON daily_quotes(symbol, date)")

    # 为已存在的 stocks 表添加新字段（迁移）
    try:
        conn.execute("ALTER TABLE stocks ADD COLUMN last_date INTEGER")
    except sqlite3.OperationalError:
        pass  # 字段已存在
    try:
        conn.execute("ALTER TABLE stocks ADD COLUMN last_close REAL")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE stocks ADD COLUMN last_volume INTEGER")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE stocks ADD COLUMN total_bars INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    conn.commit()


def get_source_file_signature() -> dict[str, str]:
    """获取源文件的签名，用于检测数据更新"""
    sh_file = eastmoney_day_file("SH")
    sz_file = eastmoney_day_file("SZ")
    sig = {}
    if sh_file.exists():
        st = sh_file.stat()
        sig["SH"] = f"{st.st_mtime_ns}:{st.st_size}"
    if sz_file.exists():
        st = sz_file.stat()
        sig["SZ"] = f"{st.st_mtime_ns}:{st.st_size}"
    return sig

def read_import_progress() -> dict[str, Any] | None:
    """
    从 C 程序写入的进度文件读取导入进度

    Returns:
        包含 phase, market, current, total, message 的字典，文件不存在返回 None
    """
    if not DB_PROGRESS_FILE.exists():
        return None

    try:
        content = DB_PROGRESS_FILE.read_text(encoding="utf-8")
        return json.loads(content)
    except (json.JSONDecodeError, IOError):
        return None


def update_rebuild_status_from_progress():
    """从进度文件更新重建状态"""
    global DB_REBUILD_STATUS

    progress = read_import_progress()
    if progress:
        DB_REBUILD_STATUS["in_progress"] = progress.get("phase") not in ("complete", "error", "")
        DB_REBUILD_STATUS["message"] = progress.get("message", "")
        if progress.get("total", 0) > 0:
            DB_REBUILD_STATUS["progress"] = int(100 * progress.get("current", 0) / progress["total"])
        else:
            DB_REBUILD_STATUS["progress"] = 0

        if progress.get("phase") == "complete":
            DB_REBUILD_STATUS["in_progress"] = False
            # 读取数据库统计信息
            try:
                conn = get_db()
                cursor = conn.execute("SELECT COUNT(*) FROM stocks")
                stocks_count = cursor.fetchone()[0]
                cursor = conn.execute("SELECT COUNT(*) FROM bars")
                bars_count = cursor.fetchone()[0]
                DB_REBUILD_STATUS["stats"] = {
                    "stocks_count": stocks_count,
                    "bars_count": bars_count,
                }
                DB_REBUILD_STATUS["message"] = f"导入完成: {stocks_count} 只股票, {bars_count} 条 K 线"
            except Exception:
                pass

            # 更新源文件签名
            update_source_signature()

    elif DB_REBUILD_STATUS["in_progress"]:
        # 进度文件不存在但状态显示正在重建，可能是 C 程序刚启动
        DB_REBUILD_STATUS["message"] = "等待 C 导入程序启动..."
        DB_REBUILD_STATUS["progress"] = 0


def is_db_expired() -> bool:
    """检查数据库是否需要重建"""
    conn = get_db()
    cursor = conn.execute("SELECT value FROM meta WHERE key = 'source_signature'")
    row = cursor.fetchone()
    if not row:
        return True

    stored = json.loads(row[0])
    current = get_source_file_signature()
    return stored != current


def update_source_signature():
    """更新源文件签名"""
    conn = get_db()
    sig = json.dumps(get_source_file_signature())
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('source_signature', ?)", (sig,))
    conn.commit()


def trigger_db_import() -> dict[str, Any]:
    """
    触发 C 程序执行数据库导入（仅手动触发）

    Returns:
        触发状态信息
    """
    global DB_REBUILD_STATUS

    # 检查 C 程序是否存在
    if not DATA_IMPORT_EXE.exists():
        return {
            "success": False,
            "error": f"C 导入程序不存在: {DATA_IMPORT_EXE}\n请先编译: gcc -O3 -o data_import.exe data_import.c -lsqlite3"
        }

    # 检查是否已在运行
    progress = read_import_progress()
    if progress and progress.get("phase") not in ("complete", "error", ""):
        return {
            "success": False,
            "error": "导入正在进行中",
            "in_progress": True,
            "progress": progress,
        }

    # 启动 C 程序
    try:
        import subprocess
        process = subprocess.Popen(
            [str(DATA_IMPORT_EXE), str(DB_FILE), str(EASTMONEY_ROOT)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )

        DB_REBUILD_STATUS["in_progress"] = True
        DB_REBUILD_STATUS["progress"] = 0
        DB_REBUILD_STATUS["message"] = "C 导入程序已启动"
        DB_REBUILD_STATUS["started_at"] = datetime.now().isoformat()
        DB_REBUILD_STATUS["pid"] = process.pid

        return {
            "success": True,
            "message": "C 导入程序已启动",
            "pid": process.pid,
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"启动失败: {e}"
        }


def get_db_status() -> dict[str, Any]:
    """获取数据库状态信息"""
    conn = get_db()
    cursor = conn.execute("SELECT value FROM meta WHERE key = 'source_signature'")
    row = cursor.fetchone()

    # 计算数据库文件大小
    db_size = DB_FILE.stat().st_size if DB_FILE.exists() else 0

    status = {
        "db_exists": DB_FILE.exists(),
        "db_size_mb": round(db_size / 1024 / 1024, 2),
        "rebuild_in_progress": DB_REBUILD_STATUS["in_progress"],
        "rebuild_progress": DB_REBUILD_STATUS["progress"],
        "rebuild_message": DB_REBUILD_STATUS["message"],
    }

    if DB_FILE.exists():
        cursor = conn.execute("SELECT COUNT(*) FROM stocks")
        status["stocks_count"] = cursor.fetchone()[0]
        cursor = conn.execute("SELECT COUNT(*) FROM bars")
        status["bars_count"] = cursor.fetchone()[0]

        if row:
            stored_sig = json.loads(row[0])
            current_sig = get_source_file_signature()
            status["source_signature_match"] = stored_sig == current_sig
            status["source_signature"] = stored_sig
        else:
            status["source_signature_match"] = False

    if DB_REBUILD_STATUS["stats"]:
        status["last_rebuild"] = DB_REBUILD_STATUS["stats"]

    return status


# 股票列表缓存（从数据库）
STOCKS_FROM_DB_CACHE: dict[str, Any] = {"time": 0.0, "stocks": []}


def load_stocks_from_db() -> list[dict[str, Any]]:
    """从数据库加载股票列表"""
    if STOCKS_FROM_DB_CACHE["stocks"] and time.time() - STOCKS_FROM_DB_CACHE["time"] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(STOCKS_FROM_DB_CACHE["stocks"])

    conn = get_db()
    cursor = conn.execute("""
        SELECT symbol, name, market, last_date, last_close, last_volume, total_bars
        FROM stocks
        ORDER BY market, symbol
    """)

    stocks = []
    for row in cursor.fetchall():
        symbol, name, market, last_date, last_close, last_volume, total_bars = row
        stocks.append({
            "symbol": symbol,
            "name": name or symbol,
            "market": market,
            "_last_date": last_date,
            "_last_close": last_close,
            "_last_volume": last_volume,
            "_total_bars": total_bars or 0,
        })

    STOCKS_FROM_DB_CACHE["time"] = time.time()
    STOCKS_FROM_DB_CACHE["stocks"] = deepcopy(stocks)
    return stocks


def get_mmap_context(day_file: Path) -> tuple[mmap.mmap, int, int, int] | None:
    """获取缓存的 mmap 上下文，如果文件已修改则重新加载"""
    path_str = str(day_file)
    if not day_file.exists():
        return None

    mtime_ns = day_file.stat().st_mtime_ns
    cached = MMAP_CACHE.get(path_str)
    if cached and cached[4] == mtime_ns:
        return (cached[0], cached[1], cached[2], cached[3])

    # 文件已修改或首次加载，重新打开
    if cached:
        try:
            cached[0].close()
        except:
            pass

    handle = day_file.open("rb")
    mm = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
    capacity = struct.unpack_from("<I", mm, 20)[0]
    records_per_block = struct.unpack_from("<I", mm, 16)[0] or EM_RECORDS_PER_BLOCK
    data_start = EM_FILE_HEADER_SIZE + capacity * EM_ENTRY_SIZE
    MMAP_CACHE[path_str] = (mm, capacity, records_per_block, data_start, mtime_ns)
    return (mm, capacity, records_per_block, data_start)


def stock_by_symbol(symbol: str) -> dict[str, Any] | None:
    """根据股票代码从数据库查找股票信息"""
    conn = get_db()
    cursor = conn.execute("""
        SELECT symbol, name, market, last_date, last_close, last_volume, total_bars
        FROM stocks
        WHERE symbol = ?
    """, (symbol,))
    row = cursor.fetchone()
    if not row:
        return None
    symbol, name, market, last_date, last_close, last_volume, total_bars = row
    return {
        "symbol": symbol,
        "name": name or symbol,
        "market": market,
        "_last_date": last_date,
        "_last_close": last_close,
        "_last_volume": last_volume,
        "_total_bars": total_bars or 0,
    }


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

    # 使用空字典跳过名称解析，首次加载更快
    # 名称会在后台异步填充
    NAME_CACHE["signature"] = signature
    NAME_CACHE["names"] = dict(FALLBACK_NAMES)

    # 后台异步填充名称
    def fill_names():
        try:
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
            NAME_CACHE["names"] = names
        except:
            pass

    import threading
    thread = threading.Thread(target=fill_names, daemon=True)
    thread.start()

    return dict(NAME_CACHE["names"])


def read_stock_index_for_market(market: str, names: dict[str, str]) -> list[dict[str, Any]]:
    read_start = time.time()
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

    read_time = time.time() - read_start
    write_perf_log([
        {"label": f"read_stock_index_for_market({market})", "duration": read_time * 1000},
        {"label": f"  found {len(stocks)} stocks", "duration": 0},
    ])

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
    perf_stats: dict | None = None,
) -> dict[str, Any] | None:
    entry_offset = int(stock.get("_entry_offset") or -1)
    if entry_offset < EM_FILE_HEADER_SIZE or entry_offset + EM_ENTRY_SIZE > data_start:
        return None

    total_days = int(stock.get("_total_days") or struct.unpack_from("<I", mm, entry_offset + 24)[0])
    if total_days <= 0:
        return None

    find_start = time.time()
    block_ids = read_entry_block_ids(mm, entry_offset, total_days, records_per_block)
    last_index = total_days - 1
    last_record = read_day_record_at_index(mm, block_ids, last_index, data_start, records_per_block)
    if last_record and int(last_record["_date_value"]) <= as_of_value:
        latest_index = last_index
    else:
        latest_index = find_latest_record_index(mm, block_ids, total_days, as_of_value, data_start, records_per_block)
    if perf_stats:
        perf_stats["find_time"] += time.time() - find_start

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

    volume_ratio = None

    suspended = latest["date"] < as_of_date and is_weekday_date(as_of_date)

    quote = {
        "symbol": stock["symbol"],
        "name": stock["name"],
        "market": stock["market"],
        "date": as_of_date,
        "_last_trade_date": latest["date"],
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

    total_start = time.time()
    stocks = load_stock_universe()
    stocks_time = time.time() - total_start

    by_market = {
        "SH": [stock for stock in stocks if stock["market"] == "SH"],
        "SZ": [stock for stock in stocks if stock["market"] == "SZ"],
    }
    quotes: list[dict[str, Any]] = []
    as_of_value = date_int(as_of_date)

    snapshot_start = time.time()
    perf_stats = {"find_time": 0.0, "vol_time": 0.0}
    for market, market_stocks in by_market.items():
        day_file = eastmoney_day_file(market)
        ctx = get_mmap_context(day_file)
        if not ctx or not market_stocks:
            continue
        mm, capacity, records_per_block, data_start = ctx
        for stock in market_stocks:
            quote = read_latest_snapshot(mm, stock, as_of_value, as_of_date, data_start, records_per_block, perf_stats)
            if quote:
                quotes.append(quote)
    snapshot_time = time.time() - snapshot_start

    quotes.sort(key=lambda item: (item["market"], item["symbol"]))
    QUOTE_CACHE[as_of_date] = (time.time(), deepcopy(quotes))

    # 记录性能
    total_time = time.time() - total_start
    write_perf_log([
        {"label": "load_market_quotes total", "duration": total_time * 1000},
        {"label": f"  load_stock_universe", "duration": stocks_time * 1000},
        {"label": f"  find latest records", "duration": perf_stats["find_time"] * 1000},
        {"label": f"  calc volume ratio", "duration": perf_stats["vol_time"] * 1000},
        {"label": f"  read snapshots ({len(quotes)} quotes)", "duration": snapshot_time * 1000},
    ])

    # Keep at most a few snapshots; data files can be large and users scrub dates while reviewing.
    if len(QUOTE_CACHE) > 6:
        oldest = sorted(QUOTE_CACHE.items(), key=lambda item: item[1][0])[:-6]
        for key, _ in oldest:
            QUOTE_CACHE.pop(key, None)

    return quotes


def load_market_quotes_from_db(as_of_date: str) -> list[dict[str, Any]]:
    """
    从数据库加载市场行情，优先使用预计算数据

    目标响应时间: < 100ms
    """
    cached = QUOTE_CACHE.get(as_of_date)
    if cached and time.time() - cached[0] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(cached[1])

    total_start = time.time()
    conn = get_db()
    as_of_value = date_int(as_of_date)

    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_quotes'")
    if cursor.fetchone():
        try:
            return load_market_quotes_from_daily_table(conn, as_of_date, as_of_value, total_start)
        except sqlite3.OperationalError:
            pass

    # 第一步：从 stocks 表获取预计算数据（~10-30ms）
    stocks_start = time.time()
    cursor = conn.execute("""
        SELECT symbol, name, market, last_date, last_close, last_volume, total_bars
        FROM stocks
        ORDER BY market, symbol
    """)
    stocks_data = cursor.fetchall()
    stocks_time = time.time() - stocks_start

    quotes: list[dict[str, Any]] = []
    need_supplement: list[tuple[str, str]] = []  # (symbol, market)

    # 第二步：使用预计算数据构建行情
    build_start = time.time()
    for symbol, name, market, last_date, last_close, last_volume, total_bars in stocks_data:
        if last_date and last_date <= as_of_value:
            # 预计算数据有效，直接使用
            prev_close = None  # 需要查询前一日数据
            change = 0.0
            pct = 0.0
            amplitude_pct = 0.0

            quote = {
                "symbol": symbol,
                "name": name or symbol,
                "market": market,
                "date": as_of_date,
                "_last_trade_date": date_string(last_date),
                "open": last_close,
                "high": last_close,
                "low": last_close,
                "close": last_close,
                "prevClose": prev_close,
                "change": change,
                "pct": pct,
                "volumeRatio": None,
                "volume": last_volume or 0,
                "amount": 0,
                "turnover": 0,
                "amplitudePct": amplitude_pct,
                "suspended": last_date < as_of_value or (last_volume or 0) <= 0,
            }
            quotes.append(quote)
        else:
            # 需要补充查询
            need_supplement.append((symbol, market))

    build_time = time.time() - build_start

    # 第三步：补充查询需要更新的股票（批量查询优化）
    supplement_time = 0.0
    if need_supplement:
        supp_start = time.time()
        for symbol, market in need_supplement:
            # 查询该股票在 as_of_date 之前的最新 K 线
            cursor = conn.execute("""
                SELECT date, open, high, low, close, volume, amount
                FROM bars
                WHERE symbol = ? AND date <= ?
                ORDER BY date DESC
                LIMIT 2
            """, (symbol, as_of_value))
            rows = cursor.fetchall()

            if not rows or len(rows) == 0:
                continue

            latest = rows[0]
            date_val, open_p, high_p, low_p, close_p, volume, amount = latest
            date_str = date_string(date_val)

            # 获取前一日收盘价
            prev_close = None
            if len(rows) > 1:
                prev_close = rows[1][4]  # close

            change = close_p - prev_close if prev_close else 0.0
            pct = (change / prev_close) * 100 if prev_close else 0.0
            amplitude_pct = ((high_p - low_p) / prev_close) * 100 if prev_close else 0.0

            # 获取名称
            name_cursor = conn.execute("SELECT name FROM stocks WHERE symbol = ?", (symbol,))
            name_row = name_cursor.fetchone()
            name = name_row[0] if name_row and name_row[0] else symbol

            suspended = date_val < as_of_value and is_weekday_date(as_of_date)

            quote = {
                "symbol": symbol,
                "name": name,
                "market": market,
                "date": as_of_date,
                "_last_trade_date": date_str,
                "open": round(open_p, 4),
                "high": round(high_p, 4),
                "low": round(low_p, 4),
                "close": round(close_p, 4),
                "prevClose": round(prev_close, 4) if prev_close else None,
                "change": round(change, 4),
                "pct": round(pct, 4),
                "volumeRatio": None,
                "volume": int(volume),
                "amount": round(amount, 2),
                "turnover": 0,
                "amplitudePct": round(amplitude_pct, 4),
                "suspended": suspended or volume <= 0,
            }
            quotes.append(quote)

        supplement_time = time.time() - supp_start

    quotes.sort(key=lambda item: (item["market"], item["symbol"]))
    QUOTE_CACHE[as_of_date] = (time.time(), deepcopy(quotes))

    # 记录性能
    total_time = time.time() - total_start
    write_perf_log([
        {"label": "load_market_quotes_from_db total", "duration": total_time * 1000},
        {"label": f"  fetch stocks ({len(stocks_data)} rows)", "duration": stocks_time * 1000},
        {"label": f"  build quotes from precomputed", "duration": build_time * 1000},
        {"label": f"  supplement queries ({len(need_supplement)} stocks)", "duration": supplement_time * 1000},
        {"label": f"  result: {len(quotes)} quotes", "duration": 0},
    ])

    # Keep at most a few snapshots
    if len(QUOTE_CACHE) > 6:
        oldest = sorted(QUOTE_CACHE.items(), key=lambda item: item[1][0])[:-6]
        for key, _ in oldest:
            QUOTE_CACHE.pop(key, None)

    return quotes


def load_market_quotes_from_daily_table(
    conn: sqlite3.Connection,
    as_of_date: str,
    as_of_value: int,
    total_start: float,
) -> list[dict[str, Any]]:
    query_start = time.time()
    cursor = conn.execute(
        """
        WITH target AS (
            SELECT max(date) AS date
            FROM daily_quotes
            WHERE date <= ?
        )
        SELECT
            q.symbol,
            s.name,
            s.market,
            q.date,
            q.open,
            q.high,
            q.low,
            q.close,
            q.volume,
            q.amount,
            q.prev_close,
            q.avg_volume_5
        FROM target t
        JOIN daily_quotes q ON q.date = t.date
        JOIN stocks s ON s.symbol = q.symbol
        ORDER BY s.market, q.symbol
        """,
        (as_of_value,),
    )
    rows = cursor.fetchall()
    query_time = time.time() - query_start

    build_start = time.time()
    quotes: list[dict[str, Any]] = []
    for symbol, name, market, date_val, open_p, high_p, low_p, close_p, volume, amount, prev_close, avg_volume in rows:
        change = close_p - prev_close if prev_close else 0.0
        pct = (change / prev_close) * 100 if prev_close else 0.0
        amplitude_pct = ((high_p - low_p) / prev_close) * 100 if prev_close else 0.0
        volume_ratio = (volume / avg_volume) if avg_volume and avg_volume > 0 else None
        date_str = date_string(date_val)

        quotes.append(
            {
                "symbol": symbol,
                "name": name or symbol,
                "market": market,
                "date": date_str,
                "_last_trade_date": date_str,
                "open": round(open_p, 4),
                "high": round(high_p, 4),
                "low": round(low_p, 4),
                "close": round(close_p, 4),
                "prevClose": round(prev_close, 4) if prev_close else None,
                "change": round(change, 4),
                "pct": round(pct, 4),
                "volumeRatio": round(volume_ratio, 4) if volume_ratio is not None else None,
                "volume": int(volume),
                "amount": round(amount, 2),
                "turnover": 0,
                "amplitudePct": round(amplitude_pct, 4),
                "suspended": date_val < as_of_value and is_weekday_date(as_of_date),
            }
        )
    build_time = time.time() - build_start

    QUOTE_CACHE[as_of_date] = (time.time(), deepcopy(quotes))
    if len(QUOTE_CACHE) > 6:
        oldest = sorted(QUOTE_CACHE.items(), key=lambda item: item[1][0])[:-6]
        for key, _ in oldest:
            QUOTE_CACHE.pop(key, None)

    total_time = time.time() - total_start
    write_perf_log([
        {"label": "load_market_quotes_from_daily_table total", "duration": total_time * 1000},
        {"label": f"  db query ({len(rows)} rows)", "duration": query_time * 1000},
        {"label": "  build json rows", "duration": build_time * 1000},
    ])
    return quotes


def fetch_quote_snapshot_payload(as_of_date: str) -> bytes | None:
    conn = get_db()
    as_of_value = date_int(as_of_date)
    cursor = conn.execute(
        """
        SELECT date, count, quotes_json
        FROM quote_snapshots
        WHERE date = (
            SELECT max(date)
            FROM quote_snapshots
            WHERE date <= ?
        )
        """,
        (as_of_value,),
    )
    row = cursor.fetchone()
    if not row:
        return None

    trade_date, count, quotes_json = row
    meta = {
        "as_of_date": as_of_date,
        "trade_date": date_string(trade_date),
        "source": "sqlite_snapshot",
        "db_path": str(DB_FILE),
        "count": count,
    }
    prefix = json.dumps(meta, ensure_ascii=False)[:-1] + ',"quotes":'
    return (prefix + quotes_json + "}").encode("utf-8")


def fetch_bars(symbol: str, as_of_date: str, adjust: str, start_date: str) -> dict[str, Any]:
    """
    从数据库查询 K 线数据

    目标响应时间: < 20ms
    """
    stock = stock_by_symbol(symbol)
    if stock is None:
        raise ValueError(f"unknown symbol: {symbol}")

    cache_key = (symbol, as_of_date, adjust, start_date, "db")
    cached = BAR_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < BAR_CACHE_TTL_SECONDS:
        return deepcopy(cached[1])

    query_start = time.time()
    conn = get_db()
    as_of_value = date_int(as_of_date)
    start_value = date_int(start_date)

    cursor = conn.execute("""
        SELECT date, open, high, low, close, volume, amount
        FROM bars
        WHERE symbol = ? AND date >= ? AND date <= ?
        ORDER BY date
    """, (symbol, start_value, as_of_value))

    rows = cursor.fetchall()
    query_time = time.time() - query_start

    bars: list[dict[str, Any]] = []
    for date_val, open_p, high_p, low_p, close_p, volume, amount in rows:
        date_str = date_string(date_val)
        bars.append({
            "date": date_str,
            "open": round(open_p, 4),
            "high": round(high_p, 4),
            "low": round(low_p, 4),
            "close": round(close_p, 4),
            "volume": int(volume),
            "amount": round(amount, 2),
            "turnover": 0,
            "suspended": volume <= 0,
        })

    # 计算涨跌幅等指标
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

    calc_time = time.time() - query_start - query_time

    result = {
        "symbol": stock["symbol"],
        "name": stock["name"],
        "market": stock["market"],
        "adjust": adjust,
        "as_of_date": as_of_date,
        "source": "sqlite",
        "bars": bars,
    }

    BAR_CACHE[cache_key] = (time.time(), deepcopy(result))

    # 性能日志
    write_perf_log([
        {"label": f"fetch_bars({symbol})", "duration": (query_time + calc_time) * 1000},
        {"label": f"  db query ({len(rows)} rows)", "duration": query_time * 1000},
        {"label": f"  calc indicators", "duration": calc_time * 1000},
    ])

    return result


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(exist_ok=True)


def write_perf_log(entries: list[dict[str, Any]]) -> None:
    ensure_data_dir()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    with PERF_LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(f"\n=== {timestamp} ===\n")
        for entry in entries:
            label = entry.get("label", "unknown")
            duration = entry.get("duration", 0)
            f.write(f"{label}: {duration:.2f}ms\n")
        f.write("\n")


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

            if path == "/api/db-status":
                self.send_json(get_db_status())
                return

            if path == "/api/db-progress":
                # 更新状态（从 C 程序的进度文件读取）
                update_rebuild_status_from_progress()
                status = {
                    "in_progress": DB_REBUILD_STATUS["in_progress"],
                    "progress": DB_REBUILD_STATUS["progress"],
                    "message": DB_REBUILD_STATUS["message"],
                }
                if DB_REBUILD_STATUS["stats"]:
                    status["stats"] = DB_REBUILD_STATUS["stats"]
                self.send_json(status)
                return

            if path == "/api/stocks":
                self.send_json({"stocks": [public_stock(stock) for stock in load_stocks_from_db()]})
                return

            if path == "/api/stock-debug":
                symbol = self.required_query(query, "symbol")
                as_of_date = parse_date(self.required_query(query, "as_of_date"), "as_of_date")
                stock = stock_by_symbol(symbol)
                if not stock:
                    self.send_json({"error": "stock not found"}, HTTPStatus.NOT_FOUND)
                    return

                day_file = eastmoney_day_file(stock["market"])
                ctx = get_mmap_context(day_file)
                if not ctx:
                    self.send_json({"error": "day file not found"}, HTTPStatus.NOT_FOUND)
                    return

                mm, capacity, records_per_block, data_start = ctx
                as_of_value = date_int(as_of_date)

                debug_info = {
                    "symbol": symbol,
                    "as_of_date": as_of_date,
                    "as_of_value": as_of_value,
                    "market": stock["market"],
                    "total_days": stock.get("_total_days"),
                }

                entry_offset = int(stock.get("_entry_offset") or -1)
                if entry_offset < EM_FILE_HEADER_SIZE:
                    debug_info["error"] = "invalid entry_offset"
                    self.send_json(debug_info)
                    return

                block_ids = read_entry_block_ids(mm, entry_offset, debug_info["total_days"], records_per_block)
                debug_info["block_count"] = len(block_ids)

                # 读取最后几条记录
                last_index = debug_info["total_days"] - 1
                last_record = read_day_record_at_index(mm, block_ids, last_index, data_start, records_per_block)
                second_last = read_day_record_at_index(mm, block_ids, last_index - 1, data_start, records_per_block)

                debug_info["last_record"] = last_record
                debug_info["second_last_record"] = second_last

                # 查找 as_of_date 之前的最新记录
                latest_index = find_latest_record_index(mm, block_ids, debug_info["total_days"], as_of_value, data_start, records_per_block)
                debug_info["latest_index"] = latest_index
                if latest_index >= 0:
                    latest_record = read_day_record_at_index(mm, block_ids, latest_index, data_start, records_per_block)
                    debug_info["latest_record"] = latest_record

                self.send_json(debug_info)
                return

            if path == "/api/quotes":
                as_of_date = parse_date(self.required_query(query, "as_of_date"), "as_of_date")
                market = query.get("market", ["all"])[0].upper()
                limit = parse_int(query.get("limit", ["0"])[0], 0)
                if market == "ALL" and limit <= 0:
                    payload = fetch_quote_snapshot_payload(as_of_date)
                    if payload is not None:
                        self.send_json_bytes(payload)
                        return
                quotes = load_market_quotes_from_db(as_of_date)
                if market in {"SH", "SZ"}:
                    quotes = [quote for quote in quotes if quote["market"] == market]
                if limit > 0:
                    quotes = quotes[:limit]
                self.send_json(
                    {
                        "as_of_date": as_of_date,
                        "source": "sqlite",
                        "db_path": str(DB_FILE),
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
            if path == "/api/rebuild-db":
                result = trigger_db_import()
                status_code = HTTPStatus.OK if result.get("success") else HTTPStatus.BAD_REQUEST
                self.send_json(result, status_code)
                return

            if path == "/api/perf-log":
                payload = self.read_json_body()
                entries = payload.get("entries") or []
                write_perf_log(entries)
                self.send_json({"ok": True, "count": len(entries)})
                return

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
        self.send_json_bytes(body, status)

    def send_json_bytes(self, body: bytes, status: HTTPStatus = HTTPStatus.OK) -> None:
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

    # 初始化数据库表结构
    init_database()

    # 数据库更新已改为手动触发，不再自动更新
    # 使用 POST /api/rebuild-db 触发 C 程序执行数据导入
    db_status = get_db_status()
    if not DB_FILE.exists():
        print("Database not found. Initialize it with: POST /api/rebuild-db")
    else:
        print(f"Database: {db_status.get('stocks_count', 0)} stocks, {db_status.get('bars_count', 0)} bars")
        if not db_status.get('source_signature_match', True):
            print("NOTE: Source files may have changed. Rebuild with: POST /api/rebuild-db")

    server = ThreadingHTTPServer((args.host, args.port), BacktesterHandler)
    print(f"Serving stock backtester at http://{args.host}:{args.port}")
    print(f"Market API: Eastmoney local day V43 data under {EASTMONEY_ROOT}, truncated by required as_of_date")
    print(f"Database: {DB_FILE}")
    print(f"C Importer: {DATA_IMPORT_EXE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
