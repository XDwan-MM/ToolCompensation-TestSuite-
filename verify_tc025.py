#!/usr/bin/env python3
"""TC-025 切弦桥接验证：切弦指标 + 断弧扫描 + errors"""
import json, subprocess, math, sys

NC = 'nc测试文件/TC-025.nc'
L10_CENTER = (50.0, -10.0)   # L10 弧心
L10_R = 10.0                 # L10 弧半径
CUT_TOL = 0.1                # 工具边沿距弧心允许的容差

def run(D):
    subprocess.run(['./build/run_pmc_test', NC, str(D), '0', '1', '1', '0', '0', '0', '8', '/tmp/s.json'],
                   capture_output=True)
    return json.load(open('/tmp/s.json'))

def scan(D):
    d = run(D)
    meta = [x for x in d if x.get('tag') == 'META'][0]
    pts = [(p['x'], p['y'], p.get('interp'), p.get('cx'), p.get('cy')) for p in d if p.get('tag') == 'CMP']
    # 1) 切弦指标：CMP 工具中心路径到 L10 弧心的最小距离 - |D| 应 >= L10_R。
    #    圆弧段按实际圆弧采样（弦必在圆内，线性采样会误报切弦）；直线段线性采样。
    dmin = 1e9
    for i in range(len(pts) - 1):
        x1, y1, _, _, _ = pts[i]
        x2, y2, ip2, cx2, cy2 = pts[i + 1]   # 段类型由终点决定（弧段终点带圆心）
        if ip2 in ('G02', 'G03') and cx2 is not None:
            # 沿圆弧采样（两点的圆心角，按时钟方向展开）
            a1 = math.atan2(y1 - cy2, x1 - cx2); a2 = math.atan2(y2 - cy2, x2 - cx2)
            da = a2 - a1
            if ip2 == 'G02':  # 顺时针
                while da > 0: da -= 2 * math.pi
            else:             # 逆时针
                while da < 0: da += 2 * math.pi
            n = max(2, int(abs(da) / 0.02))
            for k in range(n + 1):
                a = a1 + da * k / n
                x = cx2 + math.cos(a) * math.hypot(x1 - cx2, y1 - cy2)
                y = cy2 + math.sin(a) * math.hypot(x1 - cx2, y1 - cy2)
                dmin = min(dmin, math.hypot(x - L10_CENTER[0], y - L10_CENTER[1]))
        else:
            for t in range(0, 101):
                x = x1 + (x2 - x1) * t / 100; y = y1 + (y2 - y1) * t / 100
                dmin = min(dmin, math.hypot(x - L10_CENTER[0], y - L10_CENTER[1]))
    edge = dmin - abs(D)
    cut_ok = edge >= L10_R - CUT_TOL
    # 2) 断弧扫描：相邻弧点半径差（只统计相邻的弧点对，端点用各自圆心判断）
    prev = None; bad_arc = 0; n_arc = 0
    for p in d:
        if p.get('tag') == 'CMP' and p.get('cx') is not None and prev:
            n_arc += 1
            if abs(math.hypot(prev[0] - p['cx'], prev[1] - p['cy'])
                   - math.hypot(p['x'] - p['cx'], p['y'] - p['cy'])) > 0.5:
                bad_arc += 1
        if p.get('tag') == 'CMP':
            prev = (p['x'], p['y'])
    errs = meta['errors']
    # 225 = 收刀段终点画圆检测报警（发那科语义：|D|>收刀段退刀量时收刀路径必然切弧，宁停勿错，预期行为）
    errs_ok = not errs or set(errs) <= {'225'}
    return dmin, edge, cut_ok, bad_arc, n_arc, errs, errs_ok

if __name__ == '__main__':
    Ds = [-4, -5, -5.5, -6, -7, -8, -9, -10, -10.5, -11, -12, -12.5, -13, -14, -15,
          -16, -16.5, -17, -17.5, -18, -19, -19.5, -20, -21, -22, -23, -24, -25]
    fails = 0
    print(f"{'D':>7} {'中心距min':>10} {'边沿距':>9} {'切弦':>5} {'断弧':>4} {'errors':>10}")
    for D in Ds:
        dmin, edge, ok, bad, n_arc, errs, errs_ok = scan(D)
        flag = '' if (ok and bad == 0 and errs_ok) else '  <<< FAIL'
        if flag: fails += 1
        print(f"{D:>7} {dmin:10.3f} {edge:9.3f} {('OK' if ok else 'CUT'):>5} {bad:>3}/{n_arc} {str(errs):>10}{flag}")
    print(f"\nFAIL count = {fails}")
    sys.exit(1 if fails else 0)
