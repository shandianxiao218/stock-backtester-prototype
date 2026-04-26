/*
 * data_import.c - Fast database importer for Eastmarket stock data
 *
 * Compile: gcc -O3 -std=c11 -o data_import.exe data_import.c sqlite3.c -lws2_32
 * Usage: data_import.exe <db_path> <eastmoney_root>
 *
 * Progress is written to <db_path>.progress in JSON format:
 * {"phase": "scanning", "market": "SH", "current": 100, "total": 5000, "message": "..."}
 */

#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <ctype.h>
#include <sqlite3.h>
#include <windows.h>

// Eastmoney file format constants
#define EM_ENTRY_SIZE 516
#define EM_RECORD_SIZE 40
#define EM_FILE_HEADER_SIZE 48
#define EM_BLOCK_ID_OFFSET 32
#define EM_MAX_STOCKS 10000
#define EM_MAX_NAME 64

#pragma pack(push, 1)
typedef struct {
    uint32_t date;
    uint32_t _reserved;
    float open;
    float close;
    float high;
    float low;
    uint32_t volume;
    uint32_t _reserved2;
    double amount;
} EMRecord;

typedef struct {
    char code[16];
    uint8_t _entry_reserved[8];
    uint32_t total_days;
    uint32_t _entry_reserved2;
    uint32_t block_ids[121];
} EMEntry;
#pragma pack(pop)

typedef struct {
    char symbol[8];
    char name[EM_MAX_NAME];
    char market[4];
    int last_date;
    double last_close;
    uint32_t last_volume;
    int total_bars;
    uint32_t entry_offset;
} StockInfo;

typedef struct {
    char symbol[8];
    int date;
    double open;
    double high;
    double low;
    double close;
    uint32_t volume;
    double amount;
} BarData;

// Progress state
static char g_progress_path[512];
static sqlite3 *g_db = NULL;
static volatile long g_current = 0;
static volatile long g_total = 0;
static char g_message[256];
static char g_market[4] = "";
static char g_phase[32] = "";

static int get_file_size64(HANDLE hFile, uint64_t *file_size) {
    DWORD high = 0;
    DWORD low = GetFileSize(hFile, &high);
    if (low == INVALID_FILE_SIZE && GetLastError() != NO_ERROR) {
        return 0;
    }
    *file_size = ((uint64_t)high << 32) | low;
    return 1;
}

static void write_progress(void) {
    FILE *f = fopen(g_progress_path, "w");
    if (!f) return;

    fprintf(f, "{\"phase\":\"%s\",\"market\":\"%s\",\"current\":%ld,\"total\":%ld,\"message\":\"%s\"}",
            g_phase, g_market, g_current, g_total, g_message);
    fclose(f);
}

static int is_a_share_code(const char *code, const char *market) {
    if (strlen(code) != 6) return 0;
    for (int i = 0; i < 6; i++) {
        if (!isdigit(code[i])) return 0;
    }

    if (strcmp(market, "SH") == 0) {
        return strncmp(code, "600", 3) == 0 ||
               strncmp(code, "601", 3) == 0 ||
               strncmp(code, "603", 3) == 0 ||
               strncmp(code, "605", 3) == 0 ||
               strncmp(code, "688", 3) == 0 ||
               strncmp(code, "689", 3) == 0;
    } else if (strcmp(market, "SZ") == 0) {
        return strncmp(code, "000", 3) == 0 ||
               strncmp(code, "001", 3) == 0 ||
               strncmp(code, "002", 3) == 0 ||
               strncmp(code, "003", 3) == 0 ||
               strncmp(code, "300", 3) == 0 ||
               strncmp(code, "301", 3) == 0;
    }
    return 0;
}

static int valid_em_date(uint32_t date) {
    int year = date / 10000;
    int month = (date / 100) % 100;
    int day = date % 100;
    return year >= 1990 && year <= 2030 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

static int init_schema(void) {
    const char *sql =
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);"
        "CREATE TABLE IF NOT EXISTS stocks ("
        "  symbol TEXT PRIMARY KEY,"
        "  name TEXT,"
        "  market TEXT,"
        "  last_date INTEGER,"
        "  last_close REAL,"
        "  last_volume INTEGER,"
        "  total_bars INTEGER DEFAULT 0"
        ");"
        "CREATE TABLE IF NOT EXISTS bars ("
        "  symbol TEXT NOT NULL,"
        "  date INTEGER NOT NULL,"
        "  open REAL,"
        "  high REAL,"
        "  low REAL,"
        "  close REAL,"
        "  volume INTEGER,"
        "  amount REAL,"
        "  PRIMARY KEY (symbol, date)"
        ");"
        "CREATE TABLE IF NOT EXISTS daily_quotes ("
        "  symbol TEXT NOT NULL,"
        "  date INTEGER NOT NULL,"
        "  open REAL,"
        "  high REAL,"
        "  low REAL,"
        "  close REAL,"
        "  volume INTEGER,"
        "  amount REAL,"
        "  prev_close REAL,"
        "  avg_volume_5 REAL"
        ");"
        "CREATE TABLE IF NOT EXISTS quote_snapshots ("
        "  date INTEGER PRIMARY KEY,"
        "  count INTEGER NOT NULL,"
        "  quotes_json TEXT NOT NULL"
        ");";
    return sqlite3_exec(g_db, sql, NULL, NULL, NULL) == SQLITE_OK;
}

static void create_indexes(void) {
    sqlite3_exec(g_db, "CREATE INDEX IF NOT EXISTS idx_bars_date ON bars(date)", NULL, NULL, NULL);
    sqlite3_exec(g_db, "CREATE INDEX IF NOT EXISTS idx_bars_symbol_date ON bars(symbol, date)", NULL, NULL, NULL);
    sqlite3_exec(g_db, "CREATE INDEX IF NOT EXISTS idx_bars_symbol_date_desc ON bars(symbol, date DESC)", NULL, NULL, NULL);
    sqlite3_exec(g_db, "CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market)", NULL, NULL, NULL);
    sqlite3_exec(g_db, "CREATE INDEX IF NOT EXISTS idx_daily_quotes_date_symbol ON daily_quotes(date, symbol)", NULL, NULL, NULL);
    sqlite3_exec(g_db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_quotes_symbol_date ON daily_quotes(symbol, date)", NULL, NULL, NULL);
}

static int date_to_string(uint32_t date, char *buf) {
    return sprintf(buf, "%04u-%02u-%02u",
                   date / 10000,
                   (date / 100) % 100,
                   date % 100);
}

static char* extract_name_from_memory(const char *mm, size_t file_size, const char *target) {
    static char name_buf[EM_MAX_NAME];
    name_buf[0] = '\0';
    if (!mm || file_size == 0) return name_buf;

    // Find the target code
    char target_pattern[16];
    sprintf(target_pattern, "%s", target);

    const char *found = NULL;
    size_t target_len = strlen(target_pattern);
    for (size_t i = 0; i + target_len <= file_size; i++) {
        if (memcmp(mm + i, target_pattern, target_len) == 0) {
            found = mm + i;
            break;
        }
    }

    if (found && found >= mm + 120) {
        // Look backwards for Chinese name
        int best_score = 0;
        const char *window_start = found - 120;

        for (const char *p = window_start; p < found; p++) {
            if (*p == 0) {
                // Found a null terminator, potential name segment
                const char *seg_start = p + 1;
                while (seg_start > window_start && *(seg_start - 1) != 0) seg_start--;

                int len = p - seg_start;
                if (len >= 4 && len <= 24) {
                    int high_byte_count = 0;
                    for (int i = 0; i < len; i++) {
                        if ((unsigned char)seg_start[i] >= 0x80) high_byte_count++;
                    }

                    if (high_byte_count >= len / 2) {
                        int score = high_byte_count * 4 + len;
                        if (score > best_score) {
                            best_score = score;
                            strncpy(name_buf, seg_start, len);
                            name_buf[len] = '\0';
                        }
                    }
                }
            }
        }
    }

    return name_buf;
}

static char* extract_name_before_code(const char *name_file, size_t file_size, const char *target) {
    static char name_buf[EM_MAX_NAME];
    name_buf[0] = '\0';

    HANDLE hFile = CreateFileA(name_file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return name_buf;

    uint64_t file_size64 = 0;
    if (!get_file_size64(hFile, &file_size64)) {
        CloseHandle(hFile);
        return name_buf;
    }
    file_size = (size_t)file_size64;

    HANDLE hMap = CreateFileMappingA(hFile, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!hMap) { CloseHandle(hFile); return name_buf; }

    char *mm = MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0);
    if (!mm) { CloseHandle(hMap); CloseHandle(hFile); return name_buf; }

    strncpy(name_buf, extract_name_from_memory(mm, file_size, target), EM_MAX_NAME - 1);
    name_buf[EM_MAX_NAME - 1] = '\0';

    UnmapViewOfFile(mm);
    CloseHandle(hMap);
    CloseHandle(hFile);
    return name_buf;
}

static int scan_market_file(const char *day_file, const char *market, StockInfo **stocks_out) {
    HANDLE hFile = CreateFileA(day_file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        return 0;
    }

    uint64_t file_size = 0;
    if (!get_file_size64(hFile, &file_size)) {
        CloseHandle(hFile);
        return 0;
    }

    HANDLE hMap = CreateFileMappingA(hFile, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!hMap) { CloseHandle(hFile); return 0; }

    char *mm = MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0);
    if (!mm) { CloseHandle(hMap); CloseHandle(hFile); return 0; }

    uint32_t capacity = *(uint32_t*)(mm + 20);
    uint32_t records_per_block = *(uint32_t*)(mm + 16);
    if (records_per_block == 0) records_per_block = 400;

    StockInfo *stocks = calloc(EM_MAX_STOCKS, sizeof(StockInfo));
    if (!stocks) {
        UnmapViewOfFile(mm);
        CloseHandle(hMap);
        CloseHandle(hFile);
        return 0;
    }
    int stock_count = 0;

    strcpy(g_phase, "scanning");
    strcpy(g_market, market);
    g_total = capacity;

    for (uint32_t slot = 0; slot < capacity && stock_count < EM_MAX_STOCKS; slot++) {
        g_current = slot;
        if (slot % 500 == 0) {
            sprintf(g_message, "Scanning %s: %d stocks found", market, stock_count);
            write_progress();
        }

        uint32_t entry_offset = EM_FILE_HEADER_SIZE + slot * EM_ENTRY_SIZE;
        if (entry_offset + EM_ENTRY_SIZE > file_size) break;

        EMEntry *entry = (EMEntry*)(mm + entry_offset);
        char code[17];
        memcpy(code, entry->code, 16);
        code[16] = '\0';
        char *nul = memchr(code, '\0', 16);
        if (nul) *nul = '\0';

        if (!is_a_share_code(code, market)) continue;
        if (entry->total_days == 0) continue;

        StockInfo *s = &stocks[stock_count++];
        strncpy(s->symbol, code, 7);
        s->symbol[7] = '\0';
        strcpy(s->market, market);
        s->total_bars = (int)entry->total_days;
        s->entry_offset = entry_offset;
    }

    UnmapViewOfFile(mm);
    CloseHandle(hMap);
    CloseHandle(hFile);

    *stocks_out = stocks;
    return stock_count;
}

static int import_market_data(const char *day_file, const char *market, StockInfo *stocks, int stock_count, const char *name_file) {
    HANDLE hFile = CreateFileA(day_file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return 0;

    uint64_t file_size = 0;
    if (!get_file_size64(hFile, &file_size)) {
        CloseHandle(hFile);
        return 0;
    }

    HANDLE hMap = CreateFileMappingA(hFile, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!hMap) { CloseHandle(hFile); return 0; }

    char *mm = MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0);
    if (!mm) { CloseHandle(hMap); CloseHandle(hFile); return 0; }

    uint32_t capacity = *(uint32_t*)(mm + 20);
    uint32_t records_per_block = *(uint32_t*)(mm + 16);
    if (records_per_block == 0) records_per_block = 400;
    uint32_t data_start = EM_FILE_HEADER_SIZE + capacity * EM_ENTRY_SIZE;
    uint32_t block_size = records_per_block * EM_RECORD_SIZE;

    HANDLE hNameFile = INVALID_HANDLE_VALUE;
    HANDLE hNameMap = NULL;
    char *name_mm = NULL;
    size_t name_file_size = 0;
    if (name_file && name_file[0]) {
        hNameFile = CreateFileA(name_file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hNameFile != INVALID_HANDLE_VALUE) {
            uint64_t name_size64 = 0;
            if (get_file_size64(hNameFile, &name_size64)) {
                name_file_size = (size_t)name_size64;
                hNameMap = CreateFileMappingA(hNameFile, NULL, PAGE_READONLY, 0, 0, NULL);
                if (hNameMap) {
                    name_mm = MapViewOfFile(hNameMap, FILE_MAP_READ, 0, 0, 0);
                }
            }
        }
    }

    // Prepare SQLite statements
    sqlite3_stmt *insert_bar;
    sqlite3_prepare_v2(g_db,
        "INSERT OR REPLACE INTO bars (symbol, date, open, high, low, close, volume, amount) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        -1, &insert_bar, NULL);

    sqlite3_stmt *insert_stock;
    sqlite3_prepare_v2(g_db,
        "INSERT OR REPLACE INTO stocks (symbol, name, market, last_date, last_close, last_volume, total_bars) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        -1, &insert_stock, NULL);

    strcpy(g_phase, "importing");
    strcpy(g_market, market);
    g_total = stock_count;

    sqlite3_exec(g_db, "BEGIN TRANSACTION", NULL, NULL, NULL);

    for (int i = 0; i < stock_count; i++) {
        g_current = i;
        if (i % 100 == 0) {
            sprintf(g_message, "Importing %s: %d/%d stocks", market, i, stock_count);
            write_progress();
        }

        StockInfo *s = &stocks[i];

        uint32_t entry_offset = s->entry_offset;

        if (entry_offset < EM_FILE_HEADER_SIZE || entry_offset + EM_ENTRY_SIZE > data_start) continue;

        EMEntry *entry = (EMEntry*)(mm + entry_offset);
        uint32_t block_count = (EM_ENTRY_SIZE - EM_BLOCK_ID_OFFSET) / 4;
        uint32_t used_blocks = (entry->total_days + records_per_block - 1) / records_per_block;
        if (used_blocks > block_count) used_blocks = block_count;

        // Get stock name
        char name[EM_MAX_NAME];
        strncpy(name, s->symbol, EM_MAX_NAME - 1);
        if (name_mm && name_file_size > 0) {
            char *extracted = extract_name_from_memory(name_mm, name_file_size, s->symbol);
            if (extracted[0]) strncpy(name, extracted, EM_MAX_NAME - 1);
        }
        name[EM_MAX_NAME - 1] = '\0';

        // Read bars
        int bars_count = 0;
        uint32_t latest_date = 0;
        double latest_close = 0;
        uint32_t latest_volume = 0;

        for (uint32_t bi = 0; bi < used_blocks; bi++) {
            uint32_t block_id = entry->block_ids[bi];
            if (block_id == 0xFFFFFFFF) continue;

            uint64_t block_offset = (uint64_t)data_start + (uint64_t)block_id * block_size;
            if (block_offset + block_size > file_size) continue;

            uint32_t rows_in_block = records_per_block;
            if (bi == used_blocks - 1 && entry->total_days % records_per_block) {
                rows_in_block = entry->total_days % records_per_block;
            }

            for (uint32_t ri = 0; ri < rows_in_block; ri++) {
                EMRecord *rec = (EMRecord*)(mm + block_offset + ri * EM_RECORD_SIZE);
                if (!valid_em_date(rec->date)) continue;
                if (rec->close <= 0 || rec->open <= 0) continue;

                sqlite3_bind_text(insert_bar, 1, s->symbol, -1, SQLITE_STATIC);
                sqlite3_bind_int(insert_bar, 2, rec->date);
                sqlite3_bind_double(insert_bar, 3, rec->open);
                sqlite3_bind_double(insert_bar, 4, rec->high);
                sqlite3_bind_double(insert_bar, 5, rec->low);
                sqlite3_bind_double(insert_bar, 6, rec->close);
                sqlite3_bind_int(insert_bar, 7, rec->volume);
                sqlite3_bind_double(insert_bar, 8, rec->amount);
                sqlite3_step(insert_bar);
                sqlite3_reset(insert_bar);

                bars_count++;
                latest_date = rec->date;
                latest_close = rec->close;
                latest_volume = rec->volume;
            }
        }

        // Insert stock info
        sqlite3_bind_text(insert_stock, 1, s->symbol, -1, SQLITE_STATIC);
        sqlite3_bind_text(insert_stock, 2, name, -1, SQLITE_STATIC);
        sqlite3_bind_text(insert_stock, 3, s->market, -1, SQLITE_STATIC);
        sqlite3_bind_int(insert_stock, 4, latest_date);
        sqlite3_bind_double(insert_stock, 5, latest_close);
        sqlite3_bind_int(insert_stock, 6, latest_volume);
        sqlite3_bind_int(insert_stock, 7, bars_count);
        sqlite3_step(insert_stock);
        sqlite3_reset(insert_stock);

        s->total_bars = bars_count;
    }

    sqlite3_exec(g_db, "COMMIT", NULL, NULL, NULL);

    sqlite3_finalize(insert_bar);
    sqlite3_finalize(insert_stock);

    if (name_mm) UnmapViewOfFile(name_mm);
    if (hNameMap) CloseHandle(hNameMap);
    if (hNameFile != INVALID_HANDLE_VALUE) CloseHandle(hNameFile);

    UnmapViewOfFile(mm);
    CloseHandle(hMap);
    CloseHandle(hFile);

    return stock_count;
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <db_path> <eastmoney_root> [snapshot_start_date]\n", argv[0]);
        return 1;
    }

    char *db_path = argv[1];
    char *eastmoney_root = argv[2];
    uint32_t snapshot_start = (argc >= 4) ? (uint32_t)atoi(argv[3]) : 20200101;

    sprintf(g_progress_path, "%s.progress", db_path);

    // Initialize progress
    strcpy(g_phase, "init");
    g_current = 0;
    g_total = 1;
    strcpy(g_message, "Initializing...");
    write_progress();

    // Open database
    int rc = sqlite3_open(db_path, &g_db);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Cannot open database: %s\n", sqlite3_errmsg(g_db));
        return 1;
    }

    // Enable optimizations
    sqlite3_exec(g_db, "PRAGMA journal_mode=WAL", NULL, NULL, NULL);
    sqlite3_exec(g_db, "PRAGMA synchronous=OFF", NULL, NULL, NULL);
    sqlite3_exec(g_db, "PRAGMA temp_store=MEMORY", NULL, NULL, NULL);
    sqlite3_exec(g_db, "PRAGMA mmap_size=30000000000", NULL, NULL, NULL);

    if (!init_schema()) {
        fprintf(stderr, "Cannot initialize schema: %s\n", sqlite3_errmsg(g_db));
        sqlite3_close(g_db);
        return 1;
    }

    // Clear existing data
    strcpy(g_message, "Clearing old data...");
    write_progress();
    sqlite3_exec(g_db, "DELETE FROM bars", NULL, NULL, NULL);
    sqlite3_exec(g_db, "DELETE FROM stocks", NULL, NULL, NULL);
    sqlite3_exec(g_db, "DELETE FROM daily_quotes", NULL, NULL, NULL);
    sqlite3_exec(g_db, "DELETE FROM quote_snapshots", NULL, NULL, NULL);

    char sh_day_file[512], sz_day_file[512];
    char sh_name_file[512], sz_name_file[512];

    sprintf(sh_day_file, "%s\\swc8\\data\\SHANGHAI\\DayData_SH_V43.dat", eastmoney_root);
    sprintf(sz_day_file, "%s\\swc8\\data\\SHENZHEN\\DayData_SZ_V43.dat", eastmoney_root);
    sprintf(sh_name_file, "%s\\swc8\\data\\StkQuoteList\\StkQuoteList_V10_1.dat", eastmoney_root);
    sprintf(sz_name_file, "%s\\swc8\\data\\StkQuoteList\\StkQuoteList_V10_0.dat", eastmoney_root);

    int total_stocks = 0;
    int total_bars = 0;

    // Process SH market
    StockInfo *sh_stocks = NULL;
    int sh_count = scan_market_file(sh_day_file, "SH", &sh_stocks);
    if (sh_count > 0) {
        import_market_data(sh_day_file, "SH", sh_stocks, sh_count, sh_name_file);
        total_stocks += sh_count;
    }
    free(sh_stocks);

    // Process SZ market
    StockInfo *sz_stocks = NULL;
    int sz_count = scan_market_file(sz_day_file, "SZ", &sz_stocks);
    if (sz_count > 0) {
        import_market_data(sz_day_file, "SZ", sz_stocks, sz_count, sz_name_file);
        total_stocks += sz_count;
    }
    free(sz_stocks);

    // Get final stats
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(g_db, "SELECT COUNT(*) FROM bars", -1, &stmt, NULL);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        total_bars = sqlite3_column_int(stmt, 0);
    }
    sqlite3_finalize(stmt);

    strcpy(g_phase, "precomputing");
    strcpy(g_market, "");
    g_current = 0;
    g_total = 1;
    strcpy(g_message, "Precomputing daily quotes...");
    write_progress();
    sqlite3_exec(g_db, "DELETE FROM daily_quotes", NULL, NULL, NULL);
    sqlite3_exec(g_db,
        "INSERT INTO daily_quotes (symbol, date, open, high, low, close, volume, amount, prev_close, avg_volume_5) "
        "SELECT symbol, date, open, high, low, close, volume, amount, "
        "       LAG(close) OVER (PARTITION BY symbol ORDER BY date), "
        "       AVG(volume) OVER (PARTITION BY symbol ORDER BY date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) "
        "FROM bars",
        NULL, NULL, NULL);

    strcpy(g_message, "Precomputing recent quote snapshots...");
    write_progress();
    char snapshot_sql[2048];
    snprintf(snapshot_sql, sizeof(snapshot_sql),
        "INSERT INTO quote_snapshots(date, count, quotes_json) "
        "SELECT date, count(*), '[' || group_concat(json, ',') || ']' "
        "FROM ("
        "  SELECT q.date AS date, json_array("
        "    q.symbol,"
        "    coalesce(s.name, q.symbol),"
        "    s.market,"
        "    round(q.open, 4),"
        "    round(q.high, 4),"
        "    round(q.low, 4),"
        "    round(q.close, 4),"
        "    round(CASE WHEN q.prev_close IS NOT NULL AND q.prev_close != 0 THEN q.close - q.prev_close ELSE 0 END, 4),"
        "    round(CASE WHEN q.prev_close IS NOT NULL AND q.prev_close != 0 THEN (q.close - q.prev_close) / q.prev_close * 100 ELSE 0 END, 4),"
        "    round(CASE WHEN q.avg_volume_5 IS NOT NULL AND q.avg_volume_5 > 0 THEN q.volume / q.avg_volume_5 ELSE NULL END, 4),"
        "    q.volume,"
        "    round(q.amount, 2)"
        "  ) AS json "
        "  FROM daily_quotes q JOIN stocks s ON s.symbol = q.symbol "
        "  WHERE q.date >= %u "
        "  ORDER BY q.date, s.market, q.symbol"
        ") GROUP BY date",
        snapshot_start);
    sqlite3_exec(g_db, snapshot_sql, NULL, NULL, NULL);
    create_indexes();

    // Update source signature
    strcpy(g_phase, "complete");
    sprintf(g_message, "Import complete: %d stocks, %d bars", total_stocks, total_bars);
    g_current = g_total;
    write_progress();

    printf("Import complete: %d stocks, %d bars\n", total_stocks, total_bars);
    printf("Progress file: %s\n", g_progress_path);

    // Clean up progress file after 5 seconds (give Python time to read final state)
    Sleep(5000);
    remove(g_progress_path);

    sqlite3_close(g_db);
    return 0;
}
