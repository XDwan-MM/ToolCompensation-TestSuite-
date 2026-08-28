#!/usr/bin/env python3
"""
pmc_data 轨迹可视化工具
用法: python3 plot_pmc.py <json_file> [nc_file]
  json_file: 点数据文件
  nc_file: 可选的 NC 程序文件，显示在图的右侧
"""

import json
import sys
import math
import matplotlib.pyplot as plt
from matplotlib.patches import Arc
from collections import OrderedDict

def read_nc_file(path):
    try:
        with open(path, 'r') as f:
            return f.read()
    except:
        return ""

def plot_pmc_data(data, nc_code="", title="PMC Trajectory"):
    has_nc = bool(nc_code)

    if has_nc:
        fig = plt.figure(figsize=(18, 9))
        ax = fig.add_subplot(1, 2, 1)
    else:
        fig, ax = plt.subplots(figsize=(14, 9))

    if not data:
        print("No data to plot")
        return

    groups = OrderedDict()
    for p in data:
        tag = p.get("tag", "RAW")
        if tag not in groups:
            groups[tag] = []
        groups[tag].append(p)

    style_map = {
        "RAW": {"color": "#2196F3", "ls": "-",  "label": "Raw Path", "arrow": True,  "zorder": 2},
        "CMP": {"color": "#F44336", "ls": "--", "label": "Comp Path", "arrow": False, "zorder": 3},
    }
    default_style = {"color": "#9E9E9E", "ls": ":", "label": "Other", "arrow": False, "zorder": 1}

    all_x, all_y = [], []
    first_tag = list(groups.keys())[0] if groups else "RAW"

    for tag, pts in groups.items():
        style = style_map.get(tag, default_style)
        color = style["color"]
        ls = style["ls"]
        draw_arrow = style["arrow"]
        zorder = style["zorder"]

        for i in range(len(pts)):
            pt = pts[i]
            interp = pt.get("interp", "G00")
            x, y = pt["x"], pt["y"]
            all_x.append(x); all_y.append(y)

            if i > 0:
                prev = pts[i-1]
                px, py = prev["x"], prev["y"]

                if interp in ("G01", "G00"):
                    linestyle = ":" if interp == "G00" else ls
                    linewidth = 1.5 if interp == "G00" else 2.5
                    alpha = 0.5 if interp == "G00" else 0.85
                    ax.plot([px, x], [py, y], color=color, linestyle=linestyle,
                            linewidth=linewidth, alpha=alpha, zorder=zorder,
                            label=style["label"] if i == 1 and tag == first_tag else "")
                    if draw_arrow and interp != "G00":
                        dx, dy = x - px, y - py
                        if math.hypot(dx, dy) > 0:
                            ax.annotate("", xy=(x, y), xytext=(px, py),
                                       arrowprops=dict(arrowstyle="->", color=color, lw=1.5))

                elif interp in ("G02", "G03"):
                    cx = pt.get("cx", 0); cy = pt.get("cy", 0)
                    r = math.hypot(px - cx, py - cy)
                    if r < 0.001: continue
                    sa = math.degrees(math.atan2(py - cy, px - cx))
                    ea = math.degrees(math.atan2(y - cy, x - cx))
                    if interp == "G02":
                        if sa <= ea: sa += 360
                    else:
                        if ea <= sa: ea += 360
                    arc = Arc((cx, cy), 2*r, 2*r, angle=0,
                             theta1=min(sa, ea), theta2=max(sa, ea),
                             color=color, linestyle=ls, linewidth=2.5, alpha=0.85, zorder=zorder)
                    ax.add_patch(arc)
                    ax.plot(cx, cy, "+", color=color, markersize=8, mew=2, zorder=zorder)

            ax.plot(x, y, "o", color=color, markersize=5, zorder=10)
            offsets = [(12, 8), (-12, 8), (12, -8), (-12, -8)]
            offset = offsets[i % 4]
            label = f"P{i}: ({x:.1f}, {y:.1f})"
            if tag != first_tag:
                label += f" [{tag}]"
            bbox = dict(boxstyle="round,pad=0.2", facecolor="white", alpha=0.8, edgecolor=color)
            ax.annotate(label, (x, y), textcoords="offset points",
                       xytext=offset, fontsize=7, bbox=bbox,
                       arrowprops=dict(arrowstyle="->", color=color, lw=0.5), zorder=11)

    # 图例
    handles = []
    for tag in groups:
        s = style_map.get(tag, default_style)
        handles.append(plt.Line2D([0], [0], color=s["color"], linestyle=s["ls"],
                                  linewidth=2.5, label=s["label"]))
    ax.legend(handles=handles, loc="upper left", fontsize=10)
    ax.grid(True, alpha=0.2)
    ax.set_aspect("equal")
    ax.set_xlabel("X"); ax.set_ylabel("Y")
    ax.set_title(title)

    if all_x and all_y:
        margin = max(max(all_x)-min(all_x), max(all_y)-min(all_y)) * 0.2 + 5
        ax.set_xlim(min(all_x)-margin, max(all_x)+margin)
        ax.set_ylim(min(all_y)-margin, max(all_y)+margin)

    # NC 代码显示
    if has_nc:
        ax2 = fig.add_subplot(1, 2, 2)
        ax2.axis("off")
        lines = nc_code.strip().split('\n')
        display_lines = []
        for line in lines:
            line = line.rstrip()
            if line:
                display_lines.append(line)
        nc_text = '\n'.join(display_lines)
        ax2.text(0, 0.95, nc_text, fontfamily='monospace', fontsize=8,
                verticalalignment='top', transform=ax2.transAxes,
                bbox=dict(boxstyle="round", facecolor='#f5f5f5', alpha=0.9))

    plt.tight_layout()
    output_file = "pmc_trajectory.png"
    plt.savefig(output_file, dpi=150)
    print(f"Saved: {output_file}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 plot_pmc.py <json_file> [nc_file]")
        sys.exit(1)

    with open(sys.argv[1], "r") as f:
        data = json.load(f)

    nc_code = read_nc_file(sys.argv[2]) if len(sys.argv) > 2 else ""
    plot_pmc_data(data, nc_code, title=f"PMC: {sys.argv[1]}")
