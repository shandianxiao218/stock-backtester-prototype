"""
API 性能基准测试

测试目标：
- /api/quotes: < 100ms
- /api/bars: < 100ms
- /api/stocks: < 200ms
"""

import json
import os
import statistics
import time
import urllib.request
import urllib.error


BASE_URL = os.environ.get("BACKTESTER_BASE_URL", "http://127.0.0.1:8010")


def time_request(url: str) -> tuple[float, dict | None]:
    """测量请求耗时"""
    start = time.time()
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
        elapsed = (time.time() - start) * 1000
        return elapsed, data
    except urllib.error.URLError as e:
        return (time.time() - start) * 1000, None


def bench_endpoint(name: str, url: str, iterations: int = 5) -> dict:
    """测试单个接口"""
    print(f"\n测试 {name}...")
    print(f"URL: {url}")

    times: list[float] = []
    data_samples: list[dict] = []

    for i in range(iterations):
        elapsed, data = time_request(url)
        if data is None:
            print(f"  请求 {i+1}: 失败")
            continue
        times.append(elapsed)
        data_samples.append(data)
        print(f"  请求 {i+1}: {elapsed:.2f}ms")

    if not times:
        return {"status": "failed", "error": "所有请求失败"}

    return {
        "status": "ok",
        "min": round(min(times), 2),
        "max": round(max(times), 2),
        "mean": round(statistics.mean(times), 2),
        "median": round(statistics.median(times), 2),
        "stdev": round(statistics.stdev(times) if len(times) > 1 else 0, 2),
        "count": data_samples[0]["count"] if isinstance(data_samples[0], dict) and "count" in data_samples[0] else len(data_samples[0]) if isinstance(data_samples[0], list) else "N/A",
    }


def main():
    print("=" * 60)
    print("API 性能基准测试")
    print("=" * 60)

    results = {}

    # 测试 /api/health
    print("\n--- 健康检查 ---")
    health_url = f"{BASE_URL}/api/health"
    elapsed, health_data = time_request(health_url)
    if health_data:
        print(f"服务器正常运行: {health_data}")
    else:
        print("服务器无响应!")
        return

    # 测试数据库状态
    print("\n--- 数据库状态 ---")
    db_url = f"{BASE_URL}/api/db-status"
    elapsed, db_data = time_request(db_url)
    if db_data:
        print(f"数据库状态: {json.dumps(db_data, indent=2, ensure_ascii=False)}")
        if not db_data.get("db_exists"):
            print("数据库不存在，请先运行数据导入!")
            return
        if db_data.get("rebuild_in_progress"):
            print("数据库正在重建中，请等待完成...")
            return

    # 测试 /api/stocks
    results["stocks"] = bench_endpoint(
        "/api/stocks",
        f"{BASE_URL}/api/stocks",
        iterations=5
    )

    # 测试 /api/quotes (这是最重要的)
    as_of_date = "2026-04-24"
    results["quotes"] = bench_endpoint(
        f"/api/quotes (as_of={as_of_date})",
        f"{BASE_URL}/api/quotes?as_of_date={as_of_date}",
        iterations=5
    )

    # 测试 /api/bars
    results["bars"] = bench_endpoint(
        "/api/bars (600519)",
        f"{BASE_URL}/api/bars?symbol=600519&as_of_date={as_of_date}&start_date=2026-01-01",
        iterations=5
    )

    # 测试 /api/bars (长周期)
    results["bars_long"] = bench_endpoint(
        "/api/bars (600519, 2年)",
        f"{BASE_URL}/api/bars?symbol=600519&as_of_date={as_of_date}&start_date=2024-01-01",
        iterations=3
    )

    # 打印汇总
    print("\n" + "=" * 60)
    print("测试汇总")
    print("=" * 60)

    print("\n| 接口 | 最小 | 最大 | 平均 | 中位数 | 标准差 | 数据量 |")
    print("|------|------|------|------|--------|--------|--------|")

    for name, stats in results.items():
        if stats["status"] == "ok":
            print(f"| {name:20} | {stats['min']:5}ms | {stats['max']:5}ms | {stats['mean']:5}ms | {stats['median']:6}ms | {stats['stdev']:6}ms | {stats['count']:6} |")
        else:
            print(f"| {name:20} | FAILED | {stats.get('error', 'Unknown error')} |")

    # 检查目标
    print("\n目标检查:")
    print(f"  /api/quotes < 100ms: {'PASS' if results['quotes']['mean'] < 100 else 'FAIL'} (平均 {results['quotes']['mean']:.2f}ms)")
    print(f"  /api/bars < 100ms:   {'PASS' if results['bars']['mean'] < 100 else 'FAIL'} (平均 {results['bars']['mean']:.2f}ms)")
    print(f"  /api/stocks < 200ms: {'PASS' if results['stocks']['mean'] < 200 else 'FAIL'} (平均 {results['stocks']['mean']:.2f}ms)")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    main()
