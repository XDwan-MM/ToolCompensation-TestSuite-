#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  刀补批量测试 — 遍历 TC-xxx.nc × D半径 × 参数组合
# ═══════════════════════════════════════════════════════════════════
#  用法:
#    ./run_matrix.sh               全量: 26文件 × 61 D × 16组参数
#    ./run_matrix.sh TC-001.nc     只跑指定文件
#    ./run_matrix.sh -d            只打印命令，不执行 (dry-run)
#    ./run_matrix.sh -j 8          8 进程并行 (默认 1)
#    ./run_matrix.sh -r 0 10       只跑 D=0..10 范围
#    ./run_matrix.sh -h            帮助
#
#  参数矩阵 (16组): cav{0,1} × naa{0,1} × sup{0,1} × ccc{0,1}
#                   cnv=0(FullCheck) suv=0 固定
#  D 半径: 0.00 ~ 30.00, 步长 0.5 → 61 个
#  输出结构: 结果/<cnv>_<cav>_<naa>_<sup>_<suv>_<ccc>/<文件名>/D<半径>.json
# ═══════════════════════════════════════════════════════════════════

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NC_DIR="$DIR/nc测试文件"
BIN="$DIR/build/run_pmc_test"
RESULT_DIR="$DIR/结果"

# ── 默认参数 ──────────────────────────────────────────────

DRY_RUN=false
JOBS=1
TARGET_FILE=""
D_MIN=0
D_MAX=30
D_STEP=0.5
CNV=0    # 固定 FullCheck
SUV=0    # 固定

# ── 参数解析 ──────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dry-run) DRY_RUN=true; shift ;;
        -j) JOBS="$2"; shift 2 ;;
        -r|--range) D_MIN="$2"; D_MAX="$3"; shift 3 ;;
        -h|--help)
            echo "用法: $0 [选项] [NC文件]"
            echo ""
            echo "选项:"
            echo "  -d           dry-run，只打印命令不执行"
            echo "  -j N         并行进程数 (默认 1)"
            echo "  -r MIN MAX   D 半径范围 (默认 0 30)"
            echo "  -h           帮助"
            echo ""
            echo "示例:"
            echo "  $0                      全量测试"
            echo "  $0 TC-001.nc            单文件"
            echo "  $0 -j 8                 8 并行全量"
            echo "  $0 -r 0 10 -j 4         只测 D=0~10, 4 并行"
            exit 0
            ;;
        *.nc)
            TARGET_FILE="$(basename "$1")"
            shift
            ;;
        *)
            echo "未知参数: $1 (用 -h 查看帮助)"
            exit 1
            ;;
    esac
done

# ── 编译 ───────────────────────────────────────────────────

echo "=== 编译 run_pmc_test ==="
cd "$DIR"
qmake pmc_test.pro && make -j$(nproc)
echo ""

# ── 文件列表 ──────────────────────────────────────────────

if [ -n "$TARGET_FILE" ]; then
    if [ ! -f "$NC_DIR/$TARGET_FILE" ]; then
        echo "错误: 文件不存在: $NC_DIR/$TARGET_FILE"
        exit 1
    fi
    FILES=("$TARGET_FILE")
else
    mapfile -t FILES < <(ls "$NC_DIR"/*.nc 2>/dev/null | xargs -n1 basename | sort -V)
fi

# ── 参数组合列表 ──────────────────────────────────────────

PARAM_GROUPS=()
for cav in 0 1; do
    for naa in 0 1; do
        for sup in 0 1; do
            for ccc in 0 1; do
                PARAM_GROUPS+=("${CNV}_${cav}_${naa}_${sup}_${SUV}_${ccc}")
            done
        done
    done
done

# ── 生成 D 值列表 ─────────────────────────────────────────

D_VALUES=()
d="$D_MIN"
while awk "BEGIN {exit !($d <= $D_MAX)}"; do
    D_VALUES+=("$(printf "%.2f" "$d")")
    d=$(awk "BEGIN {printf \"%.2f\", $d + $D_STEP}")
done

# ── 生成任务列表 ──────────────────────────────────────────

TASK_FILE="$(mktemp)"
TOTAL=0

for nc_file in "${FILES[@]}"; do
    name="${nc_file%.nc}"
    for pg in "${PARAM_GROUPS[@]}"; do
        IFS='_' read -r _cnv _cav _naa _sup _suv _ccc <<< "$pg"
        out_subdir="$RESULT_DIR/$pg/$name"
        mkdir -p "$out_subdir"

        for D in "${D_VALUES[@]}"; do
            out_json="$out_subdir/D${D}.json"
            # 如果 JSON 已存在且有效，跳过
            if [ -f "$out_json" ] && [ -s "$out_json" ]; then
                continue
            fi
            echo "$nc_file" "$_cnv" "$_cav" "$_naa" "$_sup" "$_suv" "$_ccc" "$D" "$out_json" >> "$TASK_FILE"
            TOTAL=$((TOTAL + 1))
        done
    done
done

# ── 统计 ───────────────────────────────────────────────────

printf "文件数:    %d\n" "${#FILES[@]}"
printf "参数组:    %d  (cnv=%d suv=%d 固定, cav×naa×sup×ccc)\n" "${#PARAM_GROUPS[@]}" "$CNV" "$SUV"
printf "D 范围:    %.2f ~ %.2f (步长 %.2f, %d 个)\n" "$D_MIN" "$D_MAX" "$D_STEP" "${#D_VALUES[@]}"
printf "任务总数:  %d\n" "$TOTAL"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo "=== Dry-run (前20条) ==="
    head -20 "$TASK_FILE" | while read -r f cnv cav naa sup suv ccc D out; do
        echo "[${cnv}_${cav}_${naa}_${sup}_${suv}_${ccc}] $f D=$D → $out"
    done
    echo "... (共 $TOTAL 条)"
    rm -f "$TASK_FILE"
    exit 0
fi

if [ "$TOTAL" -eq 0 ]; then
    echo "所有任务已完成，无需运行。"
    rm -f "$TASK_FILE"
    exit 0
fi

# ── 执行 ───────────────────────────────────────────────────

echo "=== 开始测试 (并行: ${JOBS}) ==="
START_TIME=$(date +%s)

run_one() {
    local nc_file="$1" cnv="$2" cav="$3" naa="$4" sup="$5" suv="$6" ccc="$7" D="$8" out_json="$9"
    if "$BIN" "$NC_DIR/$nc_file" "$D" "$cnv" "$cav" "$naa" "$sup" "$suv" "$ccc" 8 "$out_json" > /dev/null 2>&1; then
        echo "OK    ${cnv}_${cav}_${naa}_${sup}_${suv}_${ccc}  $nc_file  D=$D"
    else
        echo "FAIL  ${cnv}_${cav}_${naa}_${sup}_${suv}_${ccc}  $nc_file  D=$D"
    fi
}

export -f run_one
export BIN NC_DIR

DONE=0
while IFS=' ' read -r nc_file cnv cav naa sup suv ccc D out_json; do
    echo "run_one \"$nc_file\" \"$cnv\" \"$cav\" \"$naa\" \"$sup\" \"$suv\" \"$ccc\" \"$D\" \"$out_json\""
done < "$TASK_FILE" | xargs -P "$JOBS" -I {} bash -c '{}' || true

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── 汇总 ───────────────────────────────────────────────────

echo ""
echo "=== 完成 ==="
echo "耗时: ${ELAPSED}s ($((ELAPSED / 60))m $((ELAPSED % 60))s)"
echo "输出: $RESULT_DIR"
echo ""

# 统计成功/失败
SUCC=$(find "$RESULT_DIR" -name "D*.json" -size +0c 2>/dev/null | wc -l)
echo "生成文件: $SUCC 个"

rm -f "$TASK_FILE"
