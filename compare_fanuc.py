#!/usr/bin/env python3
"""
FANUC 仿真结果 vs 本算法解释器输出 对比工具

用法:
    python3 compare_fanuc.py [--angle-threshold 2.0] [--dist-tolerance 0.01] [--html]

数据读取路径固定为 tools_test/测试结果/ 下的 FANUC结果/ 和 本算法结果/。
"""

import json
import csv
import math
import os
import sys
import time
import argparse
from pathlib import Path


# ============================================================
# 1. 参数映射
# ============================================================

def fanuc_to_ours(fanuc_dir_name):
    """
    FANUC: cav{X}_naa{Y}_sup{Z}_ccc{W}  (CNV=0, SUV=0 隐式)
    本算法: 0_{X}_{Y}_{Z}_0_{W}
    """
    parts = fanuc_dir_name.split('_')
    mapping = {}
    for p in parts:
        k, v = p[0:3], p[3:]
        mapping[k] = v
    cav = mapping.get('cav', '0')
    naa = mapping.get('naa', '0')
    sup = mapping.get('sup', '0')
    ccc = mapping.get('ccc', '0')
    return f"0_{cav}_{naa}_{sup}_0_{ccc}"


def parse_our_param_dir(dir_name):
    """解析本算法目录名为参数dict。格式: cnv_cav_naa_sup_suv_ccc"""
    parts = dir_name.split('_')
    return {
        'cnv': int(parts[0]), 'cav': int(parts[1]), 'naa': int(parts[2]),
        'sup': int(parts[3]), 'suv': int(parts[4]), 'ccc': int(parts[5])
    }


# ============================================================
# 2. 拐点检测（FANUC CSV → 拐点序列）
# ============================================================

def detect_corners(csv_path, angle_threshold_deg):
    """
    从 FANUC 密集 CSV 路径点中检测拐点。
    使用滑动窗口平均方向法计算转角，窗口大小 = 前后各 window_size 个点。
    返回 [(x, y), ...] 拐点坐标序列。
    """
    window_size = 5  # 前后各取5个点做平滑

    points_raw = []
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            x = float(row['abs_X'])
            y = float(row['abs_Y'])
            points_raw.append((x, y))

    if not points_raw:
        return []

    # 步骤1: 去重 — 连续相同坐标只保留首次出现
    deduped = [points_raw[0]]
    for p in points_raw[1:]:
        dx = p[0] - deduped[-1][0]
        dy = p[1] - deduped[-1][1]
        if math.hypot(dx, dy) > 1e-9:
            deduped.append(p)

    if len(deduped) <= 2:
        return deduped

    # 步骤2: 滑动窗口平均方向，计算窗口间的转角
    threshold_rad = math.radians(angle_threshold_deg)
    corners = [deduped[0]]  # 首点必取

    half = window_size
    for i in range(half, len(deduped) - half):
        p_curr = deduped[i]

        # 前窗口平均方向 (进入方向)
        prev_sum_x, prev_sum_y = 0.0, 0.0
        prev_count = 0
        for k in range(max(0, i - half), i):
            if k + 1 <= i:
                vx = deduped[k + 1][0] - deduped[k][0]
                vy = deduped[k + 1][1] - deduped[k][1]
                prev_sum_x += vx
                prev_sum_y += vy
                prev_count += 1
        if prev_count == 0:
            continue
        v_in = (prev_sum_x / prev_count, prev_sum_y / prev_count)

        # 后窗口平均方向 (离开方向)
        next_sum_x, next_sum_y = 0.0, 0.0
        next_count = 0
        for k in range(i, min(len(deduped) - 1, i + half)):
            vx = deduped[k + 1][0] - deduped[k][0]
            vy = deduped[k + 1][1] - deduped[k][1]
            next_sum_x += vx
            next_sum_y += vy
            next_count += 1
        if next_count == 0:
            continue
        v_out = (next_sum_x / next_count, next_sum_y / next_count)

        len_in = math.hypot(*v_in)
        len_out = math.hypot(*v_out)
        if len_in < 1e-9 or len_out < 1e-9:
            continue

        dot = v_in[0] * v_out[0] + v_in[1] * v_out[1]
        cos_angle = max(-1.0, min(1.0, dot / (len_in * len_out)))
        angle = math.acos(cos_angle)

        if angle > threshold_rad:
            corners.append(p_curr)

    corners.append(deduped[-1])  # 末点必取
    return corners


# ============================================================
# 3. 我方 JSON 解析
# ============================================================

def extract_cmp_points(json_path):
    """
    从本算法 JSON 中提取 CMP 点序列和错误信息。
    返回 ([(x, y), ...], error_strings[])
    """
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    points = []
    errors = []
    for item in data:
        tag = item.get('tag', '')
        if tag == 'CMP' and 'x' in item and 'y' in item:
            interp = item.get('interp', '')
            if interp != 'G00':  # 跳过 G00 定位移动，FANUC 仿真起点不同无法比对
                points.append((item['x'], item['y']))
        elif tag == 'META':
            errs = item.get('errors', [])
            if errs:
                errors = errs

    return points, errors


# ============================================================
# 4. 拐点匹配
# ============================================================

def match_corners(our_points, fanuc_corners, dist_tolerance):
    """
    我方每个 CMP 点在 FANUC 拐点中找最近距离。
    返回 list of dict: {"idx", "our", "fanuc_nearest", "dist", "ok"}
    """
    results = []
    for idx, op in enumerate(our_points):
        best_dist = float('inf')
        best_pt = None
        for fp in fanuc_corners:
            d = math.hypot(op[0] - fp[0], op[1] - fp[1])
            if d < best_dist:
                best_dist = d
                best_pt = fp
        results.append({
            'idx': idx,
            'our': list(op),
            'fanuc_nearest': list(best_pt) if best_pt else None,
            'dist': round(best_dist, 6),
            'ok': best_dist <= dist_tolerance
        })
    return results


# ============================================================
# 5. FANUC alarm 文件解析
# ============================================================

def load_fanuc_alarms(fanuc_base, param_dir):
    """读取 _alarm.txt，返回 {(tc, D半径), ...} 报警集合"""
    path = os.path.join(fanuc_base, param_dir, '_alarm.txt')
    alarms = set()
    if not os.path.exists(path):
        return alarms
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            # 格式: "TC-012.nc\tD24.5\t起刀即干涉报警"
            parts = line.split('\t')
            if len(parts) >= 2:
                tc = parts[0].replace('.nc', '')
                d = parts[1]
                alarms.add((tc, d))
    return alarms


# ============================================================
# 6. 单用例对比
# ============================================================

def compare_one_case(fanuc_csv_path, our_json_path, fanuc_alarms,
                     angle_threshold, dist_tolerance, tc, radius_key):
    """
    对比单个用例。返回结果dict或None（跳过）。
    """
    # 读取我方数据
    if not os.path.exists(our_json_path):
        return None  # 我们没这个用例，跳过

    our_points, our_errors = extract_cmp_points(our_json_path)
    has_our_error = len(our_errors) > 0

    # 读取 FANUC 数据
    if not os.path.exists(fanuc_csv_path):
        # FANUC 没有这个文件（可能仿真超时被跳过，params.json done<total）
        return None

    fanuc_corners = detect_corners(fanuc_csv_path, angle_threshold)

    fanuc_alarmed = (tc, radius_key) in fanuc_alarms

    # 报警处理
    if fanuc_alarmed and has_our_error and not our_points:
        # 双方都报警且无路径点 → 起刀即干涉一致
        return {
            'tc': tc,
            'radius': radius_key,
            'result': 'SKIP',
            'reason': '双方报警(起刀即干涉)',
            'our_points': 0,
            'fanuc_corners': len(fanuc_corners),
            'diffs': []
        }

    if fanuc_alarmed and not has_our_error:
        return {
            'tc': tc,
            'radius': radius_key,
            'result': 'FAIL',
            'reason': 'FANUC报警但本算法未报警',
            'our_points': len(our_points),
            'fanuc_corners': len(fanuc_corners),
            'diffs': []
        }

    if not fanuc_alarmed and has_our_error:
        return {
            'tc': tc,
            'radius': radius_key,
            'result': 'FAIL',
            'reason': '本算法报警但FANUC未报警',
            'our_points': len(our_points),
            'fanuc_corners': len(fanuc_corners),
            'diffs': []
        }

    # 双方都有路径点 → 拐点匹配
    match_results = match_corners(our_points, fanuc_corners, dist_tolerance)

    if len(our_points) == 0 and len(fanuc_corners) == 0:
        return {
            'tc': tc,
            'radius': radius_key,
            'result': 'PASS',
            'reason': '双方均无路径点',
            'our_points': 0,
            'fanuc_corners': 0,
            'diffs': []
        }

    diffs = [m for m in match_results if not m['ok']]
    all_ok = len(diffs) == 0

    # 检查拐点数量差异
    if len(our_points) != len(fanuc_corners):
        # 数量不一致但所有点都匹配上了 → 仍算 PASS（对方多出额外的非拐点段端点）
        # 有未匹配点 → FAIL
        pass  # diffs 已经反映了真实情况

    return {
        'tc': tc,
        'radius': radius_key,
        'result': 'PASS' if all_ok else 'FAIL',
        'reason': '' if all_ok else f'{len(diffs)}/{len(our_points)} 拐点不匹配',
        'our_points': len(our_points),
        'fanuc_corners': len(fanuc_corners),
        'diffs': diffs
    }


# ============================================================
# 7. 主流程
# ============================================================

def find_radius_files(case_dir):
    """列出某个 TC 目录下所有 Dx.xx.csv/json 文件，返回 {半径key: 文件名}"""
    result = {}
    for f in os.listdir(case_dir):
        if f.startswith('D') and not f.startswith('D0.'):
            # D0.0.csv, D0.00.json 等
            pass
        # 统一按 D 前缀识别
        stem, ext = os.path.splitext(f)
        if stem.startswith('D'):
            result[stem] = f
    return result


def parse_radius_key(filename):
    """D0.0.csv → D0.0, D0.00.json → D0.0 (规范化两位小数)"""
    stem = os.path.splitext(filename)[0]  # D0.0 或 D0.00
    # 解析数值
    num_str = stem[1:]  # 去掉 D
    val = float(num_str)
    return f"D{val:.1f}" if val == int(val) else f"D{val:.2f}"


def main():
    parser = argparse.ArgumentParser(description='FANUC vs 本算法 刀补路径对比')
    parser.add_argument('--angle-threshold', type=float, default=2.0,
                        help='拐点检测最小转角（度），默认 2.0')
    parser.add_argument('--dist-tolerance', type=float, default=0.01,
                        help='匹配容差（mm），默认 0.01')
    parser.add_argument('--html', action='store_true',
                        help='生成 HTML 可视化报告')
    args = parser.parse_args()

    # 路径
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base = os.path.join(script_dir, '测试结果')
    fanuc_base = os.path.join(base, 'FANUC结果')
    our_base = os.path.join(base, '本算法结果')

    if not os.path.exists(fanuc_base):
        print(f"错误: FANUC结果 目录不存在: {fanuc_base}")
        sys.exit(1)
    if not os.path.exists(our_base):
        print(f"错误: 本算法结果 目录不存在: {our_base}")
        sys.exit(1)

    # 获取双方参数组
    fanuc_params = sorted(os.listdir(fanuc_base))
    our_params = set(os.listdir(our_base))

    # 总计
    total_pass = 0
    total_fail = 0
    total_skip = 0
    all_details = []  # 用于 JSON 报告

    # 多遍处理：先按 FANUC 参数组扫描
    param_count = 0
    for fanuc_dir in fanuc_params:
        param_count += 1
        t_param_start = time.time()
        fanuc_param_path = os.path.join(fanuc_base, fanuc_dir)
        if not os.path.isdir(fanuc_param_path):
            continue

        our_dir = fanuc_to_ours(fanuc_dir)
        our_param_path = os.path.join(our_base, our_dir)
        if our_dir not in our_params:
            print(f"跳过 {fanuc_dir}: 本算法无对应参数组 {our_dir}")
            continue

        # 加载 FANUC 报警列表
        fanuc_alarms = load_fanuc_alarms(fanuc_base, fanuc_dir)

        # 遍历 TC 用例
        tc_list = sorted([d for d in os.listdir(fanuc_param_path)
                          if os.path.isdir(os.path.join(fanuc_param_path, d))])

        param_pass = 0
        param_fail = 0
        param_skip = 0
        param_fails = []
        case_count = 0

        for tc in tc_list:
            fanuc_case_dir = os.path.join(fanuc_param_path, tc)
            our_case_dir = os.path.join(our_param_path, tc)

            # 获取 FANUC CSV 文件和我们的 JSON 文件
            fanuc_files = [f for f in os.listdir(fanuc_case_dir) if f.endswith('.csv')]
            our_files = [f for f in os.listdir(our_case_dir) if f.endswith('.json')]

            # 建立半径 → 文件映射
            fanuc_map = {}
            for f in fanuc_files:
                key = parse_radius_key(f)
                fanuc_map[key] = f

            our_map = {}
            for f in our_files:
                key = parse_radius_key(f)
                our_map[key] = f

            # 只对比 FANUC 有的半径
            for radius_key in sorted(fanuc_map.keys()):
                fanuc_csv = os.path.join(fanuc_case_dir, fanuc_map[radius_key])
                our_json_key = radius_key  # 本算法的命名可能略有不同（D0.0 vs D0.00）
                if our_json_key not in our_map:
                    # 尝试在our_map中匹配
                    our_json = os.path.join(our_case_dir, our_map.get(our_json_key, ''))
                else:
                    our_json = os.path.join(our_case_dir, our_map[our_json_key])

                if not os.path.exists(our_json):
                    continue

                case_count += 1
                result = compare_one_case(
                    fanuc_csv, our_json, fanuc_alarms,
                    args.angle_threshold, args.dist_tolerance,
                    tc, radius_key
                )

                if result is None:
                    continue

                result['param'] = fanuc_dir
                all_details.append(result)

                if result['result'] == 'PASS':
                    param_pass += 1
                elif result['result'] == 'SKIP':
                    param_skip += 1
                else:
                    param_fail += 1
                    # 精简版放入 param_fails（不含完整 diffs 详情）
                    param_fails.append({
                        'tc': tc, 'radius': radius_key,
                        'reason': result['reason'],
                        'our': result['our_points'],
                        'fanuc': result['fanuc_corners'],
                        'diffs': result['diffs']
                    })

                # 每100个用例输出进度
                if case_count % 100 == 0:
                    elapsed = time.time() - t_param_start
                    sys.stderr.write(f"\r  [{fanuc_dir}] {case_count} cases, {elapsed:.1f}s ...")
                    sys.stderr.flush()

        print(f"{fanuc_dir}: PASS={param_pass}, FAIL={param_fail}, SKIP={param_skip}  [{time.time()-t_param_start:.1f}s]")
        total_pass += param_pass
        total_fail += param_fail
        total_skip += param_skip

        if param_fails:
            for f in param_fails[:5]:  # 最多打印前5个失败
                print(f"  [{f['tc']} {f['radius']}] {f['reason']}")
            if len(param_fails) > 5:
                print(f"  ... 还有 {len(param_fails) - 5} 个失败，详见报告")

    total = total_pass + total_fail + total_skip
    print(f"\n{'='*60}")
    print(f"总计: TOTAL={total}, PASS={total_pass}, FAIL={total_fail}, SKIP={total_skip}")
    if total > 0:
        print(f"通过率: {total_pass/total*100:.1f}%")

    # 输出 JSON 报告
    report_path = os.path.join(script_dir, 'compare_report.json')
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(all_details, f, ensure_ascii=False, indent=2)
    print(f"\n详细报告已保存: {report_path}")

    # 可选 HTML 报告
    if args.html:
        generate_html(all_details, args.angle_threshold, args.dist_tolerance, script_dir)


# ============================================================
# 8. HTML 可视化报告
# ============================================================

def generate_html(all_details, angle_threshold, dist_tolerance, script_dir):
    """生成独立 HTML 报告，内嵌 Canvas 绘图。"""

    # 按参数组分组
    from collections import defaultdict
    by_param = defaultdict(list)
    for d in all_details:
        by_param[d['param']].append(d)

    param_sections = []
    for param in sorted(by_param.keys()):
        cases = by_param[param]
        fails = [c for c in cases if c['result'] == 'FAIL']
        passes = [c for c in cases if c['result'] == 'PASS']
        skips = [c for c in cases if c['result'] == 'SKIP']
        param_sections.append({
            'param': param,
            'total': len(cases),
            'pass': len(passes),
            'fail': len(fails),
            'skip': len(skips),
            'fails': fails,
            'cases': cases
        })

    # 统计总计
    all_fails = [d for d in all_details if d['result'] == 'FAIL']

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>FANUC 对比报告</title>
<style>
body {{ font-family: -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f8f9fa; }}
h1 {{ color: #333; }}
.summary {{ display: flex; gap: 20px; margin: 20px 0; }}
.card {{ background: white; border-radius: 8px; padding: 16px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); flex: 1; text-align: center; }}
.card.pass {{ border-left: 4px solid #28a745; }}
.card.fail {{ border-left: 4px solid #dc3545; }}
.card.skip {{ border-left: 4px solid #ffc107; }}
.card .num {{ font-size: 36px; font-weight: bold; }}
.card .label {{ color: #666; font-size: 14px; }}
.param-group {{ background: white; border-radius: 8px; padding: 16px 24px; margin: 16px 0; box-shadow: 0 1px 3px rgba(0,0,0,.1); }}
.param-group h3 {{ margin-top: 0; }}
.fail-table {{ width: 100%; border-collapse: collapse; margin-top: 10px; }}
.fail-table th, .fail-table td {{ border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; }}
.fail-table th {{ background: #f1f3f5; }}
.fail-row {{ background: #fff5f5; }}
.diff-detail {{ font-size: 12px; color: #888; }}
.config {{ color: #888; font-size: 13px; margin-bottom: 20px; }}
.plot-area {{ margin: 10px 0; }}
</style>
</head>
<body>
<h1>FANUC vs 本算法 刀补对比报告</h1>
<div class="config">
    拐点检测转角阈值: {angle_threshold}° | 匹配容差: {dist_tolerance}mm
</div>

<div class="summary">
    <div class="card pass"><div class="num">{sum(s['pass'] for s in param_sections)}</div><div class="label">通过</div></div>
    <div class="card fail"><div class="num">{sum(s['fail'] for s in param_sections)}</div><div class="label">失败</div></div>
    <div class="card skip"><div class="num">{sum(s['skip'] for s in param_sections)}</div><div class="label">跳过(报警)</div></div>
</div>
"""

    for sec in param_sections:
        bg = '#fff5f5' if sec['fail'] > 0 else '#f0fff4'
        html += f"""
<div class="param-group" style="border-left: 4px solid {'#dc3545' if sec['fail'] > 0 else '#28a745'}">
    <h3>{sec['param']} <span style="font-weight:normal;font-size:14px;color:#666">PASS={sec['pass']} FAIL={sec['fail']} SKIP={sec['skip']}</span></h3>
"""
        if sec['fails']:
            html += """<table class="fail-table">
    <tr><th>用例</th><th>半径</th><th>原因</th><th>我方拐点数</th><th>FANUC拐点数</th><th>差异详情</th></tr>"""
            for f in sec['fails']:
                diff_strs = []
                for d in f.get('diffs', []):
                    diff_strs.append(
                        f"#{d['idx']} 我方({d['our'][0]:.4f},{d['our'][1]:.4f}) "
                        f"→ 最近({d['fanuc_nearest'][0]:.4f},{d['fanuc_nearest'][1]:.4f}) "
                        f"距离={d['dist']:.4f}mm"
                    )
                diff_html = '<br>'.join(diff_strs[:10])
                if len(diff_strs) > 10:
                    diff_html += f'<br>... 还有 {len(diff_strs) - 10} 处差异'
                html += f"""<tr class="fail-row">
    <td>{f['tc']}</td><td>{f['radius']}</td><td>{f['reason']}</td>
    <td>{f['our_points']}</td><td>{f['fanuc_corners']}</td>
    <td class="diff-detail">{diff_html}</td></tr>"""
            html += "</table>"
        html += "</div>\n"

    html += "</body></html>"

    report_html = os.path.join(script_dir, 'compare_report.html')
    with open(report_html, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"HTML 报告已保存: {report_html}")


if __name__ == '__main__':
    main()
