#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# 刀补性能基准测试 — 一键编译 + 运行
# ═══════════════════════════════════════════════════════════════
#
# 用法:
#   ./bench_comp.sh <有刀补.nc> <无刀补.nc> [D] [N]
#
# 控制器上只需要 gcc 和 qmake，脚本会自动编译 bench_comp 和 run_pmc_test
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_C="${SCRIPT_DIR}/bench_comp.c"
BENCH_BIN="${SCRIPT_DIR}/bench_comp"

# ── 参数 ──
NC_COMP="${1:?用法: $0 <有刀补.nc> <无刀补.nc> [D] [N]}"
NC_NOCOMP="${2:?用法: $0 <有刀补.nc> <无刀补.nc> [D] [N]}"
RADIUS="${3:-6.0}"
N="${4:-100}"

# 转为绝对路径（控制器上 cwd 不一定是脚本目录）
NC_COMP=$(realpath "$NC_COMP" 2>/dev/null || readlink -f "$NC_COMP")
NC_NOCOMP=$(realpath "$NC_NOCOMP" 2>/dev/null || readlink -f "$NC_NOCOMP")

# ── 编译 bench_comp ──
if [ ! -x "$BENCH_BIN" ] || [ "$BENCH_C" -nt "$BENCH_BIN" ]; then
    echo "[build] 编译 bench_comp ..."
    gcc -O2 -std=c99 -Wall -Wextra -o "$BENCH_BIN" "$BENCH_C" -lm
    echo "[build] bench_comp 编译完成"
fi

# ── 编译 run_pmc_test ──
RUNNER="${SCRIPT_DIR}/build/run_pmc_test"
if [ ! -x "$RUNNER" ]; then
    echo "[build] 编译 run_pmc_test ..."
    cd "$SCRIPT_DIR" && qmake pmc_test.pro && make -j$(nproc)
    echo "[build] run_pmc_test 编译完成"
fi

# ── 执行 ──
echo ""
exec "$BENCH_BIN" -r "$RUNNER" "$NC_COMP" "$NC_NOCOMP" "$RADIUS" "$N"
