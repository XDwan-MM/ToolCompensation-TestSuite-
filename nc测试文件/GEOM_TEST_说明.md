# GEOM_TEST_*.nc — 几何相交检查分场景测试文件

10 个独立 NC 文件,每个覆盖一种场景。运行示例:

```bash
cd tools_test
# <D> 用各文件推荐值; geomCheck=1 开几何相交检测/避开, 0=关闭(对照)
./build/run_pmc_test nc测试文件/GEOM_TEST_1_line_cross.nc 8 0 1 1 0 0 0 8 out.json 1
```

网页端:选择对应文件,勾选"不相邻等距线几何相交检查",填推荐 D。

## 文件清单

| 文件 | 场景 | 推荐 D | 实测行为(cav=1 naa=1 geomCheck=1) |
|---|---|---|---|
| GEOM_TEST_1_line_cross.nc | 直线×直线: 不相邻段补偿路径交叉(方向检查盲区) | 8 | 检测+避开, errors=[] |
| GEOM_TEST_2_vshape.nc | V形折返内偏, 交点转角90°(危险边界) | 8 | 检测+避开(naa=1); naa=0 危险报警 |
| GEOM_TEST_3_arc_line.nc | 圆弧×直线交叉 + G41/G42交替 + 弧-弧外切 | 6 | 检测+避开, errors=[] |
| GEOM_TEST_4_entry_cut.nc | 起刀切入交叉(大D内偏, 落位点深入轮廓) | 16.5 | 避开; 收刀画圆225(既有) |
| GEOM_TEST_5_danger_angle.nc | 危险转角153°(外偏弧×直线) | -11 | naa=1 避开; naa=0 危险报警 |
| GEOM_TEST_6_chord_bridge.nc | 切弦/桥接(TC-025 原版), ccc=1 圆弧保持 | -16.5 | 桥接(切弧), errors 与 TC-025 原版一致 |
| GEOM_TEST_7_tangent.nc | 线-弧相切: 等距圆恒外切(接触不穿透) | 6 | 相切过滤, 不误报(几何命中0) |
| GEOM_TEST_8_ijk.nc | IJK 矢量偏置(补偿路径非等距线) | 8 | 几何检查排除 IJK 段, 无错 |
| GEOM_TEST_9_g18.nc | G18 平面(XZ)几何检查 | 8 | 同平面段对在 XZ 投影内检测+避开 |
| GEOM_TEST_10_spiral.nc | 螺旋插补 G02.5(平面投影判定) | 8 | 投影检测, 不误报 |
| GEOM_TEST_11_small_segments.nc | 密集小线段(CAM后处理, 段长~3mm) | 6 | 不误报, 正常走通 |
| GEOM_TEST_12_narrow_groove.nc | 小于刀具直径的凹槽(槽宽5<2D, 发那科6.7.5图a) | 6 | 方向检查避开失败+报警(既有) |
| GEOM_TEST_13_small_step.nc | 比刀具半径小的圆弧台阶(R=3<D, 发那科6.7.5图c) | 6 | 弧超限209报警(既有) |
| GEOM_TEST_14_closed_contour.nc | 封闭轮廓闭环(起点=终点) | 6 | **几何相交+避开** |
| GEOM_TEST_15_sharp_corner.nc | 30°锐角内角 | 6 | 不误报 |
| GEOM_TEST_16_pocket.nc | 窄U槽口袋内轮廓(槽宽8<2D) | 6 | **几何相交+避开**(经典瓶颈) |
| GEOM_TEST_17_g40_arc_exit.nc | G40圆弧收刀段 | 6 | G40EndWithArc 208报警(既有) |
| GEOM_TEST_18_suppress_m.nc | 刀补中M00抑制缓冲 | 6 | 抑制缓冲, 正常走通 |
| GEOM_TEST_19_full_circle.nc | 整圆G02 360° | 6 | 不误报 |

## 验证要点(每个文件)

1. **geomCheck 0 vs 1**:关闭时方向检查盲区不报,开启后几何相交被检测;
2. **cav=0**:检测到真实自交 → 225(CompBufferHinder),程序停止;
3. **cav=1 naa=1**:避开成功 → 输出路径在交点 P 处断开重建(tar 截断、sec 续走、中间段坍缩);
4. **cav=1 naa=0**:交点转角 ≥90°(GT2/GT5)→ 危险报警;
5. **圆弧保持**(GT6, ccc=1):避开后 CMP 弧点保持 G02/G03;
6. **相切不误报**(GT7):errors=[] 且无几何相交命中。

## 说明

- GT4/GT6 的 225 来自收刀段画圆检测(退刀距离 < |D|,既有行为),与 geomCheck 无关;
- GT5 的 -11 是负 D(等效右补偿),与 TC-021 验证值一致;
- 场景来源: 发那科 0i-MF 手册 6.7.5(凹槽/台阶)/6.7.6(干涉)/G40圆弧收刀;
  论文《一种适用于小线段的半径补偿干涉回避算法》(密集小线段);
  Autodesk Fusion 论坛(CAM密集点刀补干涉报警);
  CDON 瓶颈识别(窄槽/口袋);
- GT11/15/18/19 验证"不误报"; GT12/13/17 验证既有报警(方向检查/弧超限/G40圆弧);
  GT14/16 是新增的几何相交检测+避开场景;
- tools_test 在 .gitignore 中,本组文件只作本地测试用。
