// ══════════════════════════════════════════════════════
//  bufferHinderCheck 辅助函数单元测试
// ══════════════════════════════════════════════════════

#include <QVector2D>
#include <QDebug>
#include <cmath>
#include "../src/tool/intersection.h"

// ── 辅助函数（从 ncinterpreter_p.cpp 复制，最小依赖） ──

static ITSStraight calcOffsetLine(const QVector2D &prevPos, const QVector2D &curPos, double offset)
{
    ITSStraight raw(prevPos, curPos);
    raw.leftMove(offset);
    return raw;
}

static ITSArc calcOffsetArc(const QVector2D &prevPos, const QVector2D &curPos,
                            const QVector2D &center, bool clockwise, double offset)
{
    ITSArc raw(prevPos, curPos, center, clockwise);
    raw.leftMove(offset);
    return raw;
}

static bool isOppositeDir(const QVector2D &prevPos, const QVector2D &curPos,
                          const QVector2D &offsetVec)
{
    QVector2D rawDir = curPos - prevPos;
    if (rawDir.isNull()) return false;
    double dot = QVector2D::dotProduct(rawDir, offsetVec);
    return dot <= 0;
}

enum class ToolDir { Left, Right };

static bool isIntersectOnWrongSide(const QVector2D &prevPos, const QVector2D &curPos,
                                   const QVector2D &intersectPos, ToolDir direction)
{
    QVector2D dir = curPos - prevPos;
    if (dir.isNull()) return false;
    double cross = dir.x() * (intersectPos.y() - prevPos.y())
                 - dir.y() * (intersectPos.x() - prevPos.x());
    if (direction == ToolDir::Left)
        return cross <= 0;
    else
        return cross >= 0;
}

// ── 测试框架 ──

static int testsPassed = 0;
static int testsFailed = 0;

#define TEST(name, expr) do { \
    if (!(expr)) { \
        qDebug() << "FAIL:" << name; \
        testsFailed++; \
    } else { \
        testsPassed++; \
    } \
} while(0)

#define TEST_NEAR(name, val, expected, eps) \
    TEST(name, qAbs((val) - (expected)) < (eps))

// ── 测试用例 ──

void test_calcOffsetLine()
{
    // 水平线向右(0,0)→(10,0)，左偏+5 → 整体上移5
    ITSStraight r = calcOffsetLine(QVector2D(0,0), QVector2D(10,0), 5);
    TEST_NEAR("line: begin y", r.begin().y(), 5.0, 0.001);
    TEST_NEAR("line: end y",   r.end().y(),   5.0, 0.001);
    TEST_NEAR("line: begin x", r.begin().x(), 0.0, 0.001);
    TEST_NEAR("line: end x",   r.end().x(),  10.0, 0.001);

    // 右偏（负值）→ 整体下移5
    ITSStraight r2 = calcOffsetLine(QVector2D(0,0), QVector2D(10,0), -5);
    TEST_NEAR("line neg: begin y", r2.begin().y(), -5.0, 0.001);
    TEST_NEAR("line neg: end y",   r2.end().y(),   -5.0, 0.001);

    // 垂直线向上(0,0)→(0,10)，左偏+5 → 整体左移5（沿路径方向左侧）
    ITSStraight r3 = calcOffsetLine(QVector2D(0,0), QVector2D(0,10), 5);
    TEST_NEAR("line vert: begin x", r3.begin().x(), -5.0, 0.001);
    TEST_NEAR("line vert: end x",   r3.end().x(),   -5.0, 0.001);
}

void test_isOppositeDir()
{
    // 原始方向：右 → (10,0)
    QVector2D prev(0,0), cur(10,0);

    TEST("opposite: same dir",       !isOppositeDir(prev, cur, QVector2D(5,0)));
    TEST("opposite: 45 deg",         !isOppositeDir(prev, cur, QVector2D(5,5)));
    TEST("opposite: 90 deg up",      isOppositeDir(prev, cur, QVector2D(0,5)));
    TEST("opposite: 90 deg down",    isOppositeDir(prev, cur, QVector2D(0,-5)));
    TEST("opposite: 135 deg",        isOppositeDir(prev, cur, QVector2D(-5,5)));
    TEST("opposite: 180 deg",        isOppositeDir(prev, cur, QVector2D(-5,0)));

    // 原始方向：上 → (0,10)
    QVector2D prevV(0,0), curV(0,10);
    TEST("opposite vert: same",      !isOppositeDir(prevV, curV, QVector2D(0,5)));
    TEST("opposite vert: 90 right",  isOppositeDir(prevV, curV, QVector2D(5,0)));
    TEST("opposite vert: 180 down",  isOppositeDir(prevV, curV, QVector2D(0,-5)));
}

void test_isIntersectOnWrongSide()
{
    // 水平路径 (0,0)→(10,0)
    QVector2D prev(0,0), cur(10,0);

    // G41 左补：交点在上方(左侧) → 正确
    TEST("h G41 above correct",  !isIntersectOnWrongSide(prev,cur,QVector2D(5,5), ToolDir::Left));
    // G41 左补：交点在下方(右侧) → 错误
    TEST("h G41 below wrong",     isIntersectOnWrongSide(prev,cur,QVector2D(5,-5), ToolDir::Left));
    // G42 右补：交点在下方(右侧) → 正确
    TEST("h G42 below correct",  !isIntersectOnWrongSide(prev,cur,QVector2D(5,-5), ToolDir::Right));
    // G42 右补：交点在上方(左侧) → 错误
    TEST("h G42 above wrong",     isIntersectOnWrongSide(prev,cur,QVector2D(5,5), ToolDir::Right));
}

void test_calcOffsetArc()
{
    // 圆弧 (0,0)→(10,0)，圆心(5,5)，逆时针
    // 起点到圆心距离 = sqrt(5²+5²) = 7.07
    ITSArc raw(QVector2D(0,0), QVector2D(10,0), QVector2D(5,5), false);
    double origR = (raw.begin() - raw.center()).length();

    // 左偏+5：逆时针圆弧，起点向圆心移动 → 半径减小
    ITSArc r = calcOffsetArc(QVector2D(0,0), QVector2D(10,0), QVector2D(5,5), false, 5);
    double newR = (r.begin() - r.center()).length();
    TEST_NEAR("arc: radius offset left (ccw decreases)", newR, origR - 5.0, 0.001);
    TEST("arc: center unchanged",
         qAbs(r.center().x()-5.0)<0.001 && qAbs(r.center().y()-5.0)<0.001);

    // 右偏-3：逆时针圆弧，起点远离圆心 → 半径增大
    ITSArc r2 = calcOffsetArc(QVector2D(0,0), QVector2D(10,0), QVector2D(5,5), false, -3);
    double newR2 = (r2.begin() - r2.center()).length();
    TEST_NEAR("arc: radius offset right (ccw increases)", newR2, origR + 3.0, 0.001);
}

void test_intersection()
{
    // 两直线相交
    ITSStraight l1(QVector2D(0,0), QVector2D(10,0));
    ITSStraight l2(QVector2D(5,-5), QVector2D(5,5));
    Intersection inter(l1, l2);
    TEST("inter ss: valid", inter.valid());
    if (inter.valid()) {
        TEST_NEAR("inter ss: x", inter.result().x(), 5.0, 0.001);
        TEST_NEAR("inter ss: y", inter.result().y(), 0.0, 0.001);
    }

    // 平行线 → 无交点
    ITSStraight p1(QVector2D(0,0), QVector2D(10,0));
    ITSStraight p2(QVector2D(0,5), QVector2D(10,5));
    TEST("inter para: not valid", !Intersection(p1, p2).valid());

    // 直线与圆弧
    ITSStraight l3(QVector2D(0,0), QVector2D(10,0));
    ITSArc a(QVector2D(0,0), QVector2D(10,0), QVector2D(5,5), false);
    Intersection interArc(l3, a);
    TEST("inter line-arc: valid", interArc.valid());
    // 可能返回 (0,0) 首尾相接或 (5,0) 直线交点，只要有效就算过
    // 验证交点在直线 y=0 上
    if (interArc.valid()) {
        TEST_NEAR("inter line-arc: on line y=0", interArc.result().y(), 0.0, 0.001);
    }

    // 偏移后的直线与直线求交（模拟间隙矢量法）
    // 原始路径 (0,0)→(10,0) 左偏5, 另一条 (5,0)→(5,10) 左偏5
    ITSStraight off1 = calcOffsetLine(QVector2D(0,0), QVector2D(10,0), 5);
    ITSStraight off2 = calcOffsetLine(QVector2D(5,0), QVector2D(5,10), 5);
    Intersection interOff(off1, off2);
    TEST("inter offset lines: valid", interOff.valid());
    if (interOff.valid()) {
        qDebug() << "Offset lines intersect at:" << interOff.result();
    }
}

// ── 主函数 ──

int main()
{
    qDebug() << "=== bufferHinderCheck 辅助函数单元测试 ===";

    test_calcOffsetLine();
    test_isOppositeDir();
    test_isIntersectOnWrongSide();
    test_calcOffsetArc();
    test_intersection();

    qDebug() << "";
    qDebug() << "通过:" << testsPassed << "/ 失败:" << testsFailed;

    return testsFailed > 0 ? 1 : 0;
}
