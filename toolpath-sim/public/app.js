// ─── PathRenderer: Canvas 2D rendering engine ───
// ─── Error codes ───
const ERROR_NAMES = {
  0: 'Exception',
  53: 'CompExceedRadius',
  54: 'CompNoIntersection',
  55: 'CompLineCheckFail',
  56: 'CompCircleCheckFail',
  57: 'CompBufferHinder',
  58: 'CanNotCalToolCompensation',
  61: 'EntryWithArc',
  62: 'ExitWithArc',
};

class PathRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rawData = [];        // RAW path points (3D x/y/z + plane)
    this.cmpData = [];        // CMP path points (3D x/y/z + rx/ry/rz + avoid)
    this.segments = [];       // parsed segment list
    this.currentStep = -1;
    this.hoveredPt = null;   // {x, y, data} for tooltip
    this.highlightRawIdxs = new Set();   // 行→段 联动高亮：RAW 段索引集合（点击 NC 行设置）
    // 3D 正交相机：屏幕轴四元数轨道旋转 + 缩放 + 平移
    //   q: 世界→相机 的旋转四元数（绕屏幕竖直/水平轴增量旋转，模拟"拨动画布"）
    //   scale: 像素/单位  panX/panY: 屏幕平移
    //   viewMode: 'free' 自由视角(q) | 'xy'|'xz'|'yz' 轴对齐平面视图
    this.camera = { q: { w: 1, x: 0, y: 0, z: 0 }, scale: 1, panX: 0, panY: 0, viewMode: 'free' };
    this.viewPresets = {
      iso:   { q: PathRenderer._isoQuat(), viewMode: 'free' },   // 等轴测 (≈35.26°, 45°)
      xy:    { q: null, viewMode: 'xy' },                    // 俯视 X/Y：画(x,y)
      xz:    { q: null, viewMode: 'xz' },                    // 从 +Y 看 X/Z：画(x,z)
      yz:    { q: null, viewMode: 'yz' },                    // 从 +X 看 Y/Z：画(y,z)
      front: { q: null, viewMode: 'xz' },                    // 前视图（同 xz）
      top:   { q: null, viewMode: 'xy' },                    // 俯视图（同 xy）
    };
    this.options = {
      showRaw: true,
      showCmp: true,
      showLabels: true,
      showGrid: true,
      showTool: false,
      showVectors: true,
    };
    this.toolPos = null;
    this.toolRadius = 0;  // 0 = 自动从 D slider 取
    this.dragging = null; // null | {mode:'rotate'|'pan', ...}
    this._setupCanvas();
    this._setupEvents();
    this.resize();
  }

  _setupCanvas() {
    this.ctx.imageSmoothingEnabled = false;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * devicePixelRatio;
    this.canvas.height = rect.height * devicePixelRatio;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(devicePixelRatio, devicePixelRatio);
    this.render();
  }

  _setupEvents() {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.scale *= delta;
      this.camera.scale = Math.max(0.01, Math.min(200, this.camera.scale));
      this.render();
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.shiftKey) {
        // 左键（无 Shift）→ 平移
        this.dragging = { mode: 'pan', startX: e.clientX, startY: e.clientY,
                          panX: this.camera.panX, panY: this.camera.panY };
      } else if (e.button === 0 && e.shiftKey) {
        // Shift+左键 → 旋转（拖拽跟随：基于按下时的初始姿态 + 当前位移重算）
        this.dragging = { mode: 'rotate', startX: e.clientX, startY: e.clientY,
                          baseQ: { ...this.camera.q }, baseScale: this.camera.scale };
      } else if (e.button === 2) {
        // 右键 → 旋转（同上）
        this.dragging = { mode: 'rotate', startX: e.clientX, startY: e.clientY,
                          baseQ: { ...this.camera.q }, baseScale: this.camera.scale };
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.dragging.startX;
        const dy = e.clientY - this.dragging.startY;
        if (this.dragging.mode === 'rotate') {
          this._orbit(dx, dy);
        } else {
          this.camera.panX = this.dragging.panX + dx;
          this.camera.panY = this.dragging.panY + dy;
        }
        this.render();
      } else {
        this._checkHover(e);
      }
    });

    window.addEventListener('mouseup', () => { this.dragging = null; });

    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('resize', () => this.resize());
  }

  // ─── 屏幕轴轨道旋转（四元数） ───
  // 世界→相机 用四元数 q 表示；每次拨动在"屏幕坐标系"里旋转：
  //   水平拨动 dx → 绕屏幕竖直轴旋转（内容左右转）
  //   竖直拨动 dy → 绕屏幕水平轴旋转（看到顶部/底部）
  static _quatMul(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    };
  }
  static _axisQuat(ax, ay, az, ang) {
    const h = ang / 2, s = Math.sin(h);
    return { w: Math.cos(h), x: ax * s, y: ay * s, z: az * s };
  }
  static _quatRotate(q, p) {
    // p 为纯向量四元数 {w:0, x,y,z}
    const qc = { w: q.w, x: -q.x, y: -q.y, z: -q.z };
    const r = PathRenderer._quatMul(PathRenderer._quatMul(q, p), qc);
    return { x: r.x, y: r.y, z: r.z };
  }
  // 等轴测初始视角：先绕屏幕竖直轴转 45°，再绕屏幕水平轴抬 ~35.26°
  static _isoQuat() {
    let q = { w: 1, x: 0, y: 0, z: 0 };
    q = PathRenderer._quatMul(PathRenderer._axisQuat(0, 1, 0, -0.785), q);   // 绕屏幕Y 转 -45°
    q = PathRenderer._quatMul(PathRenderer._axisQuat(1, 0, 0, -0.615), q);   // 绕屏幕X 抬 -35.26°
    return q;
  }

  // 设置预设视图
  setView(name) {
    const p = this.viewPresets[name];
    if (p) {
      this.camera.q = p.q ? { ...p.q } : { w: 1, x: 0, y: 0, z: 0 };
      this.camera.viewMode = p.viewMode;
      this.camera.panX = 0;
      this.camera.panY = 0;
      this.render();
    }
  }

  // "拨动画面"式自由旋转（屏幕轴轨道）：内容跟随鼠标移动方向
  //  水平拨动 dx>0（右滑）→ 绕屏幕竖直轴转 -dx*k → 内容向右转
  //  水平拨动 dx<0（左滑）→ 绕屏幕竖直轴转 + → 内容向左转
  //  竖直拨动 dy<0（上滑）→ 绕屏幕水平轴转 -dy*k → 看到模型底部
  //  竖直拨动 dy>0（下滑）→ 看到模型顶部
  // 屏幕轴旋转在"屏幕坐标系"里做增量，竖直方向的点也会随水平拨动横移，
  // 手感像拨动真实物体（Trackball），不像旧版只绕世界 Y 轴转。
  // 拖拽跟随式旋转：基于"按下时的初始姿态 baseQ" + "当前位移 dx/dy" 重建，
  // 而不是基于当前累积姿态做增量。这样鼠标往左拖多少就转多少，
  // 往回拖就原样退回（方向会反转），不会越拖越过头。
  _orbit(dx, dy) {
    const k = 0.01;
    const base = this.dragging ? this.dragging.baseQ : this.camera.q;
    let q = base;
    // 水平位移 → 绕屏幕竖直轴；竖直位移 → 绕屏幕水平轴（都基于起始姿态）
    q = PathRenderer._quatMul(PathRenderer._axisQuat(0, 1, 0, -dx * k), q);
    q = PathRenderer._quatMul(PathRenderer._axisQuat(1, 0, 0, -dy * k), q);
    this.camera.q = q;
    // 自由旋转时退出轴对齐平面视图
    this.camera.viewMode = 'free';
    this.render();
  }

  // ─── 3D 正交投影 ───
  // viewMode 决定坐标轴：
  //   'xy': 画 (x,y)  —— 俯视，X右 Y上（G17 默认）
  //   'xz': 画 (z,x)  —— G18 ZX 平面：Z右 X上（横轴 Z、纵轴 X）
  //   'yz': 画 (y,z)  —— 从 +X 看，Y右 Z上（G19）
  //   'free': 自由旋转视角 —— 世界点经四元数 q（屏幕轴轨道）旋转到相机系
  project(wx, wy, wz) {
    const c = this.camera;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const cx = rect.width / 2 + c.panX;
    const cy = rect.height / 2 + c.panY;

    let sx, sy2;
    if (c.viewMode === 'xy') {
      sx = wx; sy2 = wy;
    } else if (c.viewMode === 'xz') {
      sx = wz; sy2 = wx;   // G18 ZX：横轴 Z、纵轴 X
    } else if (c.viewMode === 'yz') {
      sx = wy; sy2 = wz;
    } else {
      // free：屏幕轴轨道旋转 —— 世界点经四元数 q 旋转到相机系
      const r = PathRenderer._quatRotate(c.q, { w: 0, x: wx, y: wy, z: wz });
      sx = r.x;
      sy2 = r.y;
    }

    return {
      x: sx * c.scale + cx,
      y: -(sy2 * c.scale) + cy
    };
  }

  // 世界坐标 → 屏幕坐标（兼容旧接口名，参数带 z）
  worldToScreen(wx, wy, wz) {
    return this.project(wx, wy, wz);
  }

  // ─── render ───
  render() {
    const ctx = this.ctx;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const w = rect.width, h = rect.height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    if (this.options.showGrid) this._drawGrid3D(w, h);
    this._drawAxes3D(w, h);

    // Draw paths with step highlighting
    const activeRawIdxs = new Set();
    if (this.toolPath && this.toolPath[this.currentStep])
      activeRawIdxs.add(this.toolPath[this.currentStep].rawIdx);
    for (const i of this.highlightRawIdxs) activeRawIdxs.add(i);
    if (this.options.showRaw) this._drawPathSegments(this.segments, '#2196F3', 2.5, [], activeRawIdxs);
    if (this.options.showCmp) this._drawCmpSegments('#F44336', 2.5, [6, 4]);

    if (this.options.showLabels) this._drawLabels();
    if (this.options.showTool && this.toolPos) this._drawTool(this.toolPos.x, this.toolPos.y, this.toolPos.z);
    if (this.hoveredPt) this._drawTooltip(this.hoveredPt);

    ctx.restore();
  }

  // 3D 网格：在 X/Y 平面（z=0）绘制网格
  _drawGrid3D(w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = '#313244';
    ctx.lineWidth = 0.5;
    const gridSize = 10;
    const ext = 200;  // 网格半范围

    for (let gx = -ext; gx <= ext; gx += gridSize) {
      const a = this.project(gx, -ext, 0);
      const b = this.project(gx, ext, 0);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let gy = -ext; gy <= ext; gy += gridSize) {
      const a = this.project(-ext, gy, 0);
      const b = this.project(ext, gy, 0);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  // 3D 坐标轴：X(红) Y(绿) Z(蓝)，各画到 (0,0,0) → 轴端点
  _drawAxes3D(w, h) {
    const ctx = this.ctx;
    const len = 40;
    const axes = [
      { dir: 'X', end: [len, 0, 0], color: '#f38ba8' },
      { dir: 'Y', end: [0, len, 0], color: '#a6e3a1' },
      { dir: 'Z', end: [0, 0, len], color: '#89b4fa' },
    ];
    const origin = this.project(0, 0, 0);
    for (const ax of axes) {
      const p = this.project(ax.end[0], ax.end[1], ax.end[2]);
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      // 轴标签
      ctx.fillStyle = ax.color;
      ctx.font = 'bold 13px monospace';
      ctx.fillText(ax.dir, p.x + 4, p.y - 4);
    }
  }

  _drawPathSegments(segments, color, lineWidth, dash, activeRawIdxs) {
    const ctx = this.ctx;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.interp === 'G00') continue;
      const isActive = activeRawIdxs.has(i);
      ctx.strokeStyle = isActive ? '#ffd700' : color;
      ctx.lineWidth = isActive ? lineWidth * 2 : lineWidth;
      ctx.setLineDash(isActive ? [] : dash);

      const from = this.project(seg.sx, seg.sy, seg.sz);
      const to = this.project(seg.ex, seg.ey, seg.ez);

      if (seg.interp === 'G02' || seg.interp === 'G03' || seg.interp === 'G02.5' || seg.interp === 'G03.5') {
        this._drawArc3D(seg, isActive ? '#ffd700' : color, ctx.lineWidth);
      } else {
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }

      // Active segment markers
      if (isActive) {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ffd700';
        ctx.beginPath(); ctx.arc(from.x, from.y, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ffd700'; ctx.beginPath(); ctx.arc(from.x, from.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.setLineDash([]);
  }

  // 3D 圆弧：在段所在平面内采样圆弧点，映射回 3D 后投影连线
  // seg: {sx,sy,sz, ex,ey,ez, cx,cy,cz, plane, interp}
  _drawArc3D(seg, color, lineWidth) {
    if (seg.cx === undefined) return;
    const ctx = this.ctx;
    // 在平面内做 2D 圆弧 → 再投影
    // 先按 plane 提取平面坐标
    const pl = seg.plane !== undefined ? seg.plane : 0;
    // 平面内二维坐标轴对：G17=X/Y, G18=Z/X, G19=Y/Z（与后端 planeCode 一致）
    const toPlane2D = (px, py, pz) => {
      if (pl === 1) return { u: pz, v: px };  // G18: (z,x)
      if (pl === 2) return { u: py, v: pz };  // G19: (y,z)
      return { u: px, v: py };                 // G17: (x,y)
    };
    // 段所在平面高度（中间轴坐标）优先取圆心的中间轴：圆心是圆弧所在平面的锚点，
    // 弧端点在容差内可能与其有微小差异，用圆心保证整段弧在同一平面、与直线不脱开
    const mid = pl === 1 ? seg.cy : (pl === 2 ? seg.cx : seg.cz);   // G17 中间轴 z, G18 中间轴 y, G19 中间轴 x
    const to3D = (u, v) => {
      if (pl === 1) return { x: v, y: mid, z: u };  // G18: (z→u, x→v)，中间轴 y 用圆心 y
      if (pl === 2) return { x: mid, y: u, z: v };  // G19: (y→u, z→v)，中间轴 x 用圆心 x
      return { x: u, y: v, z: mid };                 // G17: (x→u, y→v)，中间轴 z 用圆心 z
    };

    const s = toPlane2D(seg.sx, seg.sy, seg.sz);
    const e = toPlane2D(seg.ex, seg.ey, seg.ez);
    const c = toPlane2D(seg.cx, seg.cy, seg.cz);

    const r = Math.hypot(s.u - c.u, s.v - c.v);
    if (r < 1e-9) return;
    const aStart = Math.atan2(s.v - c.v, s.u - c.u);
    const aEnd = Math.atan2(e.v - c.v, e.u - c.u);

    // 方向：G02/G02.5=顺时针，G03/G03.5=逆时针。
    // 平面坐标 (u,v) 中 aStart/aEnd 由 atan2 计算（v 向上，数学逆时针为正）。
    // 以 ccw = (aEnd - aStart) 归一到 [0,2π) 为"逆时针弧"：逆时针取 ccw，顺时针取 ccw-2π（顺时针减角）。
    // 各平面轴对 G17=(x,y)、G18=(z,x)、G19=(y,z) 都是右手系（从法向看），
    // 物理顺/逆时针 = 数学顺/逆时针，统一用同一逻辑，无需按平面特判。
    const raw = aEnd - aStart;
    const cw = seg.interp === 'G02' || seg.interp === 'G02.5';
    const isScrew = seg.interp === 'G02.5' || seg.interp === 'G03.5';
    // 螺旋：轴向增量 = 终点中间轴 - 起点中间轴（补偿段起点/终点中间轴真实值）
    // 若终点中间轴缺失，退化为螺距 screw（round的轴向增量），否则用端点真实差保证首尾闭合
    const midStart = seg.sy !== undefined ? (pl === 1 ? seg.sy : (pl === 2 ? seg.sx : seg.sz)) : mid;
    const midEnd   = seg.ey !== undefined ? (pl === 1 ? seg.ey : (pl === 2 ? seg.ex : seg.ez)) : mid;
    const screw = isScrew ? (midEnd - midStart) : 0;
    let sweep;
    if (Math.abs(raw) < 1e-9) {
      sweep = cw ? -2 * Math.PI : 2 * Math.PI;        // 整圆（起点=终点）
    } else {
      const ccw = ((raw % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
      sweep = cw ? ccw - 2 * Math.PI : ccw;
    }
    // 保留 G02/G03 指定方向，不强制选劣弧（避免优弧被压成反向劣弧）

    const N = 48;
    ctx.beginPath();
    const p0 = to3D(s.u, s.v);
    let prev = this.project(p0.x, p0.y, p0.z);
    ctx.moveTo(prev.x, prev.y);
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const a = aStart + sweep * t;
      const u = c.u + r * Math.cos(a);
      const v = c.v + r * Math.sin(a);
      // 螺旋：中间轴沿弧线性抬升 mid → mid+screw，使轴向随弧长连续变化
      const pm = screw !== 0 ? mid + screw * t : mid;
      let p;
      if (pl === 1) p = { x: v, y: pm, z: u };  // G18: (z→u, x→v)，中间轴 y 线性抬升
      else if (pl === 2) p = { x: pm, y: u, z: v };  // G19: 中间轴 x 线性抬升
      else p = { x: u, y: v, z: pm };                 // G17: 中间轴 z 线性抬升
      const sp = this.project(p.x, p.y, p.z);
      ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();
  }

  _drawCmpSegments(color, lineWidth, dash) {
    const ctx = this.ctx;
    const pts = this.cmpData;
    if (!pts || pts.length < 2) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);

    for (let j = 1; j < pts.length; j++) {
      const prev = pts[j - 1];
      const cur = pts[j];
      const from = this.project(prev.x, prev.y, prev.z);
      const to = this.project(cur.x, cur.y, cur.z);
      if (cur.interp === 'G02' || cur.interp === 'G03' || cur.interp === 'G02.5' || cur.interp === 'G03.5') {
        this._drawArc3D({
          sx: prev.x, sy: prev.y, sz: prev.z,
          ex: cur.x, ey: cur.y, ez: cur.z,
          cx: cur.cx, cy: cur.cy, cz: cur.cz,
          plane: cur.plane, interp: cur.interp, screw: cur.screw || 0
        }, color, ctx.lineWidth);
      } else {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }

      // Draw avoidance vector arrow: RAW(rx,ry,rz) → CMP(x,y,z)
      if (this.options.showVectors && cur.rx !== undefined) {
        const raw = this.project(cur.rx, cur.ry, cur.rz);
        const avoid = cur.avoid;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = avoid ? '#e6a817' : '#ff6655';
        ctx.lineWidth = avoid ? 2.0 : 1.5;
        ctx.beginPath();
        ctx.moveTo(raw.x, raw.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        // arrow head
        const dx = to.x - raw.x, dy = to.y - raw.y;
        const len = Math.hypot(dx, dy);
        if (len > 4) {
          const ux = dx / len, uy = dy / len;
          const ah = 6;
          ctx.setLineDash([]);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.moveTo(to.x, to.y);
          ctx.lineTo(to.x - ux * ah + uy * 3, to.y - uy * ah - ux * 3);
          ctx.lineTo(to.x - ux * ah - uy * 3, to.y - uy * ah + ux * 3);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.setLineDash([]);
  }

  _drawLabels() {
    const ctx = this.ctx;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';

    for (let i = 0; i < this.rawData.length; i++) {
      const pt = this.rawData[i];
      const sp = this.project(pt.x, pt.y, pt.z);
      ctx.fillStyle = '#6c7086';
      ctx.fillText(`R${i}:(${pt.x},${pt.y},${pt.z})`, sp.x, sp.y - 10);
    }

    // CMP (compensated) path labels
    if (this.cmpData) {
      for (let i = 0; i < this.cmpData.length; i++) {
        const pt = this.cmpData[i];
        const sp = this.project(pt.x, pt.y, pt.z);
        ctx.fillStyle = pt.avoid ? '#e6a817' : '#F44336';
        ctx.fillText(`${pt.avoid ? 'A' : 'C'}${i}:(${pt.x.toFixed(1)},${pt.y.toFixed(1)},${pt.z.toFixed(1)})`, sp.x, sp.y + 18);
      }
    }

    // Draw circle centers for arc segments
    for (const seg of this.segments) {
      if ((seg.interp === 'G02' || seg.interp === 'G03' || seg.interp === 'G02.5' || seg.interp === 'G03.5') && seg.cx !== undefined) {
        const sp = this.project(seg.cx, seg.cy, seg.cz);
        ctx.strokeStyle = '#f9e2af';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#f9e2af'; ctx.font = '10px monospace';
        ctx.fillText(`C(${seg.cx},${seg.cy},${seg.cz})`, sp.x, sp.y + 18);
      }
    }
  }

  _drawTooltip(hovered) {
    const ctx = this.ctx;
    const sp = this.project(hovered.x, hovered.y, hovered.z);
    const d = hovered.data;
    const lines = [];
    if (d.tag === 'CMP') {
      lines.push(`CMP ${d.interp}`);
      lines.push(`(${d.x},${d.y},${d.z})`);
      if (d.rx !== undefined)
        lines.push(`RAW(${d.rx},${d.ry},${d.rz})`);
      if (d.avoid) lines.push('⚠ fromAvoid');
    } else {
      lines.push(`RAW ${d.interp}`);
      lines.push(`(${d.x},${d.y},${d.z})`);
    }

    const fontSize = 11;
    ctx.font = `${fontSize}px monospace`;
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
    const th = lines.length * (fontSize + 2);
    const pad = 6;
    const bx = sp.x + 12, by = sp.y - th - pad - 2;

    ctx.fillStyle = 'rgba(30,30,46,0.92)';
    ctx.strokeStyle = '#6c7086';
    ctx.lineWidth = 1;
    // Manual rounded rect
    const r = 4, x0 = bx - pad, y0 = by - pad, w = tw + pad * 2, h = th + pad * 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x0 + w - r, y0);
    ctx.arcTo(x0 + w, y0, x0 + w, y0 + r, r);
    ctx.lineTo(x0 + w, y0 + h - r);
    ctx.arcTo(x0 + w, y0 + h, x0 + w - r, y0 + h, r);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.arcTo(x0, y0 + h, x0, y0 + h - r, r);
    ctx.lineTo(x0, y0 + r);
    ctx.arcTo(x0, y0, x0 + r, y0, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#cdd6f4';
    lines.forEach((l, i) => {
      ctx.fillText(l, bx, by + fontSize + i * (fontSize + 2));
    });
  }

  _checkHover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hitRadius = 12;
    this.hoveredPt = null;

    // Check CMP points
    for (const pt of this.cmpData) {
      const sp = this.project(pt.x, pt.y, pt.z);
      if (Math.hypot(mx - sp.x, my - sp.y) < hitRadius) {
        this.hoveredPt = { x: pt.x, y: pt.y, z: pt.z, data: pt };
        this.render();
        return;
      }
    }
    // Check RAW points
    for (const pt of this.rawData) {
      const sp = this.project(pt.x, pt.y, pt.z);
      if (Math.hypot(mx - sp.x, my - sp.y) < hitRadius) {
        this.hoveredPt = { x: pt.x, y: pt.y, z: pt.z, data: pt };
        this.render();
        return;
      }
    }
    this.render();
  }

  _drawTool(x, y, z) {
    const ctx = this.ctx;
    const sp = this.project(x, y, z);
    const r = (this.toolRadius || window.app?.currentD || 6) * this.camera.scale;
    ctx.strokeStyle = '#a6e3a1';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, Math.max(r, 6), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(166, 227, 161, 0.15)';
    ctx.fill();
  }

  loadData(rawJson) {
    const parsed = DataManager.parse(rawJson);
    this.rawData = parsed.rawData;
    this.cmpData = parsed.cmpData;
    this.segments = parsed.segments;
    this.toolPath = parsed.toolPath;       // 刀具动画路径：所有CMP点
    this.highlightRawIdxs = new Set();
    this.currentStep = this.toolPath.length > 0 ? 0 : -1;
    this.toolPos = this.toolPath.length > 0
      ? { x: this.toolPath[0].x, y: this.toolPath[0].y, z: this.toolPath[0].z } : null;
    this.render();
  }

  clearHighlight() {
    this.highlightRawIdxs = new Set();
    this.render();
  }

  resetView() {
    this.camera = { q: PathRenderer._isoQuat(), scale: 1, panX: 0, panY: 0, viewMode: 'free' };
    this._syncViewButtons(null);
    this.render();
  }

  // 同步视图按钮高亮
  _syncViewButtons(name) {
    document.querySelectorAll('.view-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === name);
    });
  }
}

// ─── DataManager: parse C++ output into structured path data ───
class DataManager {
  static parse(rawJson) {
    const rawData = [];
    const cmpData = [];
    const segments = [];
    const segList = [];       // 全量段列表（含 G00、不去重），供侧栏展示

    for (const pt of rawJson) {
      if (pt.tag === 'RAW') {
        rawData.push({
          x: pt.x, y: pt.y, z: pt.z || 0,
          interp: pt.interp, cx: pt.cx, cy: pt.cy, cz: pt.cz || 0,
          plane: pt.plane, screw: pt.screw || 0, line: pt.line, tag: 'RAW'
        });
      } else if (pt.tag === 'CMP') {
        cmpData.push({
          x: pt.x, y: pt.y, z: pt.z || 0,
          interp: pt.interp, cx: pt.cx, cy: pt.cy, cz: pt.cz || 0,
          rx: pt.rx, ry: pt.ry, rz: pt.rz || 0,
          avoid: pt.avoid || false, plane: pt.plane, screw: pt.screw || 0,
          line: pt.line, tag: 'CMP'
        });
      }
    }

    // Build segments from rawData for step playback, attach CMP index range
    // 同时记录 终点位置 → segments 索引，供 toolPath.rawIdx 精确映射
    let prevKey = null;
    let cmpIdx = 0;
    let prev3D = { x: 0, y: 0, z: 0 };
    const posToSegIdx = new Map();
    for (const pt of rawData) {
      const key = `${pt.x},${pt.y},${pt.z}`;
      if (key === prevKey) continue;
      prevKey = key;
      const cmpStart = cmpIdx;
      while (cmpIdx < cmpData.length &&
             cmpData[cmpIdx].rx === pt.x && cmpData[cmpIdx].ry === pt.y &&
             cmpData[cmpIdx].rz === pt.z)
        cmpIdx++;
      segments.push({
        sx: prev3D.x, sy: prev3D.y, sz: prev3D.z,
        ex: pt.x, ey: pt.y, ez: pt.z,
        interp: pt.interp, cx: pt.cx, cy: pt.cy, cz: pt.cz,
        plane: pt.plane, screw: pt.screw || 0, line: pt.line,
        cmpStart, cmpEnd: cmpIdx - 1,
      });
      posToSegIdx.set(key, segments.length - 1);
      prev3D = pt;
    }

    // Build toolPath: CMP points (skip G00). rawIdx = 终点位置→segments 索引
    //（不用"新 key 递增计数"：坍缩/中间行会让 rx 去重序列与 rawData 错位）
    const toolPath = [];
    for (const pt of cmpData) {
      if (pt.interp === 'G00') continue;
      const key = `${pt.rx},${pt.ry},${pt.rz}`;
      toolPath.push({ ...pt, rawIdx: posToSegIdx.has(key) ? posToSegIdx.get(key) : -1 });
    }

    return { rawData, cmpData, segments, toolPath };
  }
}

// ─── StepController: step playback logic ───
class StepController {
  constructor(renderer, onUpdate) {
    this.renderer = renderer;
    this.onUpdate = onUpdate;
    this.playing = false;
    this.animId = null;
    this.lastStepTime = 0;
    this.stepInterval = 800; // ms between steps
  }

  get totalSteps() { return this.renderer.toolPath.length; }
  get currentStep() { return this.renderer.currentStep; }
  set currentStep(n) {
    this.renderer.currentStep = Math.max(0, Math.min(n, this.totalSteps - 1));
    this._syncToolPos();
    this.renderer.render();
    if (this.onUpdate) this.onUpdate();
  }

  _syncToolPos() {
    const pt = this.renderer.toolPath[this.renderer.currentStep];
    if (pt) {
      this.renderer.toolPos = { x: pt.x, y: pt.y, z: pt.z };
    }
  }

  first() { this.currentStep = 0; }
  prev() { this.currentStep = this.currentStep - 1; }
  next() { this.currentStep = this.currentStep + 1; }
  last() { this.currentStep = this.totalSteps - 1; }

  play() {
    if (this.playing || this.totalSteps <= 0) return;
    if (this.currentStep >= this.totalSteps - 1) this.currentStep = 0;
    this.playing = true;
    this.lastStepTime = performance.now();
    this._tick(performance.now());
  }

  pause() {
    this.playing = false;
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
  }

  stop() {
    this.pause();
    this.currentStep = 0;
  }

  _tick(now) {
    if (!this.playing) return;
    if (now - this.lastStepTime >= this.stepInterval) {
      this.lastStepTime = now;
      if (this.currentStep < this.totalSteps - 1) {
        this.currentStep = this.currentStep + 1;
      } else {
        this.pause();
        return;
      }
    }
    this.animId = requestAnimationFrame((t) => this._tick(t));
  }
}

// ─── App: main application controller ───
class App {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.renderer = new PathRenderer(this.canvas);
    this.stepper = new StepController(this.renderer, () => this._updateUI());
    this.currentFile = '';
    this.currentD = 6.0;
    this.currentCNV = 0;
    this.currentCAV = 0;
    this.currentNAA = 0;
    this.currentSUP = 0;
    this.currentSUV = 0;
    this.currentCCC = 0;
    this.currentLA = 8;
    this.lineToStep = null;    // Map: NC 行号 → toolPath 索引范围 [first, last]
    this._codeLineEls = [];    // 右侧代码面板行 DOM
    this._setupSidebar();
    this._setupStepper();
    this._loadFileList();
  }

  _setupSidebar() {
    // Sidebar toggle
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
      setTimeout(() => this.renderer.resize(), 250);
    });

    // File select
    document.getElementById('file-select').addEventListener('change', (e) => {
      if (e.target.value) this.loadFile(e.target.value);
    });

    // D slider（粗调）+ 数值输入框（精确输入，支持小半径）
    const dSlider = document.getElementById('d-slider');
    const dInput  = document.getElementById('d-input');
    const syncD = () => {
      document.getElementById('d-value').textContent = this.currentD.toFixed(3);
    };
    dSlider.addEventListener('input', (e) => {
      this.currentD = parseFloat(e.target.value);
      dInput.value = this.currentD.toFixed(3);
      syncD();
    });
    dSlider.addEventListener('change', () => {
      if (this.currentFile) this.calculate();
    });
    dInput.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) {
        this.currentD = v;
        syncD();
      }
    });
    dInput.addEventListener('change', () => {
      const v = parseFloat(dInput.value);
      if (!isNaN(v) && v >= -30 && v <= 30) {
        this.currentD = v;
        dInput.value = v.toFixed(3);
        syncD();
        if (this.currentFile) this.calculate();
      }
    });

    // CNV select
    document.getElementById('cnv-select').addEventListener('change', (e) => {
      this.currentCNV = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // CAV select
    document.getElementById('cav-select').addEventListener('change', (e) => {
      this.currentCAV = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // NAA select
    document.getElementById('naa-select').addEventListener('change', (e) => {
      this.currentNAA = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // SUP select
    document.getElementById('sup-select').addEventListener('change', (e) => {
      this.currentSUP = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // SUV select
    document.getElementById('suv-select').addEventListener('change', (e) => {
      this.currentSUV = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // CCC select
    document.getElementById('ccc-select').addEventListener('change', (e) => {
      this.currentCCC = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // lookAheadSegments select
    document.getElementById('la-select').addEventListener('change', (e) => {
      this.currentLA = parseInt(e.target.value);
      if (this.currentFile) this.calculate();
    });

    // View controls
    document.getElementById('chk-raw').addEventListener('change', (e) => {
      this.renderer.options.showRaw = e.target.checked;
      this.renderer.render();
    });
    document.getElementById('chk-cmp').addEventListener('change', (e) => {
      this.renderer.options.showCmp = e.target.checked;
      this.renderer.render();
    });
    document.getElementById('chk-labels').addEventListener('change', (e) => {
      this.renderer.options.showLabels = e.target.checked;
      this.renderer.render();
    });
    document.getElementById('chk-grid').addEventListener('change', (e) => {
      this.renderer.options.showGrid = e.target.checked;
      this.renderer.render();
    });
    document.getElementById('chk-tool').addEventListener('change', (e) => {
      this.renderer.options.showTool = e.target.checked;
      this.renderer.render();
    });
    document.getElementById('chk-vectors').addEventListener('change', (e) => {
      this.renderer.options.showVectors = e.target.checked;
      this.renderer.render();
    });
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      this.stepper.stop();
      this.renderer.resetView();
      this._updateUI();
    });

    // 3D 视图切换按钮
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.renderer.setView(btn.dataset.view);
        this.renderer._syncViewButtons(btn.dataset.view);
      });
    });

    // Upload zone
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => { uploadZone.classList.remove('dragover'); });
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) this._uploadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) this._uploadFile(fileInput.files[0]);
    });
  }

  _setupStepper() {
    document.querySelectorAll('.step-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'play') { this.stepper.play(); }
        else if (action === 'pause') { this.stepper.pause(); }
        else if (action === 'stop') { this.stepper.stop(); this._updateUI(); }
        else if (action === 'first') { this.stepper.first(); this._updateUI(); }
        else if (action === 'prev') { this.stepper.prev(); this._updateUI(); }
        else if (action === 'next') { this.stepper.next(); this._updateUI(); }
        // 手动步进：清除"点击行"的整段高亮，回到单步高亮
        this.renderer.clearHighlight();
      });
    });
  }

  async _loadFileList() {
    try {
      const res = await fetch('/api/ncfiles');
      const files = await res.json();
      const sel = document.getElementById('file-select');
      sel.innerHTML = '<option value="">选择 NC 文件...</option>' +
        files.map(f => `<option value="${f}">${f}</option>`).join('');
    } catch (err) {
      console.error('Failed to load file list:', err);
    }
  }

  async loadFile(filename) {
    this.currentFile = filename;
    document.getElementById('file-select').value = filename;
    await this._loadFileContent(filename);
    await this.calculate();
  }

  // ─── 右侧程序文件面板 ───
  async _loadFileContent(filename) {
    const codeContent = document.getElementById('code-content');
    document.getElementById('code-filename').textContent = filename;
    try {
      const res = await fetch(`/api/ncfiles/${encodeURIComponent(filename)}/content`);
      if (!res.ok) {
        if (res.status === 404) {
          // server.js 新增了内容 API：旧服务器没有此路由
          throw new Error('服务器版本过旧（无 /api/ncfiles/:name/content 路由）—— 请重启服务器：Ctrl+C 停止后重新执行 start_sim.sh');
        }
        throw new Error(await res.text());
      }
      const data = await res.json();
      this._renderCodePanel(data.content);
    } catch (err) {
      codeContent.innerHTML = `<div class="code-empty">加载文件内容失败: ${err.message}</div>`;
    }
  }

  _renderCodePanel(content) {
    const container = document.getElementById('code-content');
    // 兼容 CRLF / LF
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // 去掉结尾空行（文件末尾换行产生的空串）
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    container.innerHTML = '';
    this._codeLineEls = [];
    lines.forEach((text, idx) => {
      const n = idx + 1;
      const div = document.createElement('div');
      div.className = 'code-line no-move';
      div.dataset.line = String(n);
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = n;
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = text;
      div.appendChild(ln);
      div.appendChild(txt);
      div.addEventListener('click', () => this._gotoLine(n));
      container.appendChild(div);
      this._codeLineEls.push(div);
    });
  }

  // 计算完成后：标记哪些行有移动（可点击），并建立 行号→段 映射
  _markCodeLines() {
    this.lineToStep = new Map();
    if (this.renderer.toolPath) {
      this.renderer.toolPath.forEach((pt, i) => {
        if (pt.line === undefined || pt.line === null) return;
        const r = this.lineToStep.get(pt.line);
        if (r) r[1] = i; else this.lineToStep.set(pt.line, [i, i]);
      });
    }
    this._codeLineEls.forEach(el => {
      const n = parseInt(el.dataset.line);
      const has = this.lineToStep.has(n);
      el.classList.toggle('has-move', !!has);
      el.classList.toggle('no-move', !has);
    });
  }

  // 点击 NC 行 → 高亮图像中对应段（segments 中该行的所有段）
  _gotoLine(n) {
    const rawSet = new Set();
    this.renderer.segments.forEach((seg, i) => {
      if (seg.line === n && seg.interp !== 'G00') rawSet.add(i);
    });
    if (rawSet.size === 0) return;   // 无移动行
    this.renderer.highlightRawIdxs = rawSet;
    const r = this.lineToStep && this.lineToStep.get(n);
    if (r) this.stepper.currentStep = r[0];
    this._updateUI();
  }

  // 同步右侧代码面板：当前步对应行高亮
  _syncCodeHighlight() {
    const curPt = this.renderer.toolPath[this.renderer.currentStep];
    this._codeLineEls.forEach(el => {
      const n = parseInt(el.dataset.line);
      const active = curPt && curPt.line === n;
      el.classList.toggle('active', !!active);
      el.querySelector('.ln').classList.toggle('active-ln', !!active);
    });
    if (curPt && curPt.line) {
      const el = document.querySelector(`.code-line[data-line="${curPt.line}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  async calculate() {
    if (!this.currentFile) return;
    document.getElementById('error-status').textContent = '计算中...';
    try {
      const res = await fetch('/api/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: this.currentFile, D: this.currentD, cnv: this.currentCNV, cav: this.currentCAV, naa: this.currentNAA, entrySUP: this.currentSUP, entrySUV: this.currentSUV, cornerCCC: this.currentCCC, lookAheadSegments: this.currentLA })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      // Extract last element if it's META
      let metaErr = null;
      const last = data[data.length - 1];
      if (last && last.tag === 'META') {
        metaErr = last;
        data.pop();
      }

      this.renderer.loadData(data);
      this.stepper.stop();
      this._buildSegmentList();
      this._markCodeLines();
      this._updateUI();
      this._updateErrors(metaErr);
    } catch (err) {
      console.error('Calculate error:', err);
      document.getElementById('error-status').textContent = '计算失败 ✗';
    }
  }

  async _uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      await this._loadFileList();
      this.loadFile(result.filename);
    } catch (err) {
      console.error('Upload error:', err);
    }
  }

  _buildSegmentList() {
    const container = document.getElementById('segment-list');
    container.innerHTML = '';
    this.renderer.toolPath.forEach((pt, i) => {
      const div = document.createElement('div');
      div.className = 'seg-item';
      const avoidMark = pt.avoid ? ' ⚠' : '';
      div.textContent = `${i + 1}:${avoidMark} ${pt.interp} (${pt.x},${pt.y},${pt.z})`;
      div.addEventListener('click', () => {
        this.renderer.clearHighlight();
        this.stepper.currentStep = i;
        this._updateUI();
      });
      container.appendChild(div);
    });
  }

  _updateErrors(meta) {
    const statusEl = document.getElementById('error-status');
    const listEl = document.getElementById('error-list');

    if (!meta || !meta.errors || meta.errors.length === 0) {
      statusEl.textContent = '无错误';
      statusEl.style.color = '#a6e3a1';
      listEl.innerHTML = '';
      return;
    }

    statusEl.textContent = `检测到 ${meta.errors.length} 个错误`;
    statusEl.style.color = '#f38ba8';

    let html = '';
    for (const codeStr of meta.errors) {
      const code = parseInt(codeStr);
      const name = ERROR_NAMES[code] || `Error(${code})`;
      html += `<div class="err-item">⚠ <b>${name}</b> (code=${code})</div>`;
    }
    if (meta.errorStr) {
      html += `<div class="err-detail">${meta.errorStr}</div>`;
    }
    listEl.innerHTML = html;
  }

  _updateUI() {
    const pt = this.renderer.toolPath[this.renderer.currentStep];
    document.getElementById('step-indicator').textContent =
      `段 ${this.renderer.currentStep + 1} / ${this.renderer.toolPath.length}`;

    if (pt) {
      document.getElementById('info-coords').textContent = `(${pt.x}, ${pt.y}, ${pt.z})`;
      document.getElementById('info-interp').textContent = pt.interp;
      const prev = this.renderer.currentStep > 0 ? this.renderer.toolPath[this.renderer.currentStep - 1] : pt;
      const len = Math.hypot(pt.x - prev.x, pt.y - prev.y, pt.z - prev.z);
      document.getElementById('info-length').textContent = len.toFixed(3);
    }
    document.getElementById('info-total').textContent = this.renderer.toolPath.length;

    // Update segment list highlight
    document.querySelectorAll('.seg-item').forEach((el, i) => {
      el.classList.toggle('active', i === this.renderer.currentStep);
      if (i === this.renderer.currentStep) el.scrollIntoView({ block: 'nearest' });
    });

    // 右侧代码面板：当前行高亮
    this._syncCodeHighlight();
  }
}

// ─── Start ───
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
