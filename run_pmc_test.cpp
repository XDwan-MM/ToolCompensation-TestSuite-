// ══════════════════════════════════════════════════════
//  端到端 PMC 输出测试 — 原始路径 + 补偿路径 JSON
// ══════════════════════════════════════════════════════

#include <QDebug>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include "ncinterpreter_p.h"
#include "ncitperrortype.h"
#include "planemapper.h"

// 把 pmc_plane 转成数字平面码（与 Current_Plane/pmc_plane 枚举值一致：0=XY 1=XZ 2=YZ）
static int planeCode(pmc_plane plane)
{
    switch (plane) {
        case PMC_PLANE_XY: return 0;
        case PMC_PLANE_XZ: return 1;
        case PMC_PLANE_YZ: return 2;
    }
    return 0;
}

static bool isArcInterp(pmc_interp interp)
{
    return interp == PMC_G02 || interp == PMC_G03 ||
           interp == PMC_G02_5 || interp == PMC_G03_5;
}

static const char *interpName(pmc_interp interp)
{
    switch (interp) {
        case PMC_G00: return "G00";
        case PMC_G01: return "G01";
        case PMC_G02: return "G02";
        case PMC_G03: return "G03";
        case PMC_G02_5: return "G02.5";
        case PMC_G03_5: return "G03.5";
        default: break;
    }
    return "G00";
}

static void addPoint(QJsonArray &arr, const pmc_data &p, const QString &tag, int lineNum)
{
    QJsonObject pt;
    // 输出完整 3D 物理坐标，前端按 plane 选轴显示
    pt["x"] = p.position.x;
    pt["y"] = p.position.y;
    pt["z"] = p.position.z;
    pt["plane"] = planeCode(p.plane);
    pt["interp"] = interpName(p.interp);
    pt["line"] = lineNum;   // 所属 NC 文件行号（1-based），供前端 行↔图像段 联动
    if (isArcInterp(p.interp)) {
        // 圆弧/螺旋圆心 3D 物理坐标
        pt["cx"] = p.circle_center.x_coc;
        pt["cy"] = p.circle_center.y_coc;
        pt["cz"] = p.circle_center.z_coc;
        if (p.interp == PMC_G02_5 || p.interp == PMC_G03_5)
            pt["screw"] = p.screw_offset;   // 螺旋螺距（轴向增量），供前端绘制螺旋
    }
    pt["tag"] = tag;
    arr.append(pt);
}

int main(int argc, char *argv[])
{
    if (argc < 2) {
        qDebug() << "用法: run_pmc_test <nc_file> [D] [cnv] [cav] [naa] [sup] [suv] [ccc] [la] [geomCheck] [output.json]";
        qDebug() << "       D:          刀补半径，默认 6.0";
        qDebug() << "       cnv:        干涉检查模式 0=FullCheck 1=ArcOnly 2=Disabled，默认 0";
        qDebug() << "       cav:        干涉检查动作 0=Alarm 1=Avoid，默认 0";
        qDebug() << "       naa:        危险/二次干涉 0=Alarm 1=Continue，默认 0";
        qDebug() << "       sup:        起刀类型低位(No.5003#0) 0/1，默认 0";
        qDebug() << "       suv:        起刀类型高位(No.5003#1) 0/1，默认 0";
        qDebug() << "       ccc:        外边拐角连接(No.19607#2) 0=直线 1=圆弧，默认 0";
        qDebug() << "       la:         预读段数 2~8，默认 8";
        qDebug() << "       geomCheck:  不相邻等距线几何相交检查 0=off 1=on，默认 0";
        qDebug() << "       output.json: 输出文件，默认 pmc_output.json（最后一个参数）";
        return 1;
    }

    QString ncFile  = argv[1];
    double  D       = (argc >= 3) ? atof(argv[2]) : 6.0;
    int     cnvVal  = (argc >= 4) ? atoi(argv[3]) : 0;
    int     cavVal  = (argc >= 5) ? atoi(argv[4]) : 0;
    int     naaVal  = (argc >= 6) ? atoi(argv[5]) : 0;
    int     supVal  = (argc >= 7) ? atoi(argv[6]) : 0;
    int     suvVal  = (argc >= 8) ? atoi(argv[7]) : 0;
    int     cccVal  = (argc >= 9) ? atoi(argv[8]) : 0;
    int     lookAheadSegments  = (argc >= 10) ? atoi(argv[9]) : 8;
    bool geomCheck = (argc >= 11) ? (atoi(argv[10]) != 0) : false;
    QString outFile = (argc >= 12) ? argv[11] : "pmc_output.json";

    NCInterpreter_p interpreter;
    ItpParam param;
    param.toolRadList = {0, D};
    param.cnv = static_cast<CNVMode>(cnvVal);
    param.cav = static_cast<CAVMode>(cavVal);
    param.naa = static_cast<NAAMode>(naaVal);
    param.sup = (supVal != 0);
    param.suv = (suvVal != 0);
    param.ccc = (cccVal != 0);
    param.geomCheck = geomCheck;
    if (lookAheadSegments >= 2 && lookAheadSegments <= 8)
        param.lookAheadSegments = lookAheadSegments;
    interpreter.setItpParam(param);

    if (!interpreter.start(ncFile)) {
        qDebug() << "无法打开文件:" << ncFile;
        return 1;
    }

    QJsonArray points;
    while (!interpreter.isOver())
    {
        interpreter.nextLine();
        // 与真实 motionData() 一致：首行有错误（报警行）时，机器不执行该行，
        // 不输出其运动数据，否则画图会比实际停止的行多画一行（报警行）
        if (interpreter.buffer().isEmpty() ||
            !interpreter.buffer().first().errorList().isEmpty())
            continue;
        // 当前行号（1-based）：rawData 与 compList 都来自这一行
        const int lineNum = interpreter.buffer().first().lineNumber() + 1;
        for (const auto &p : interpreter.rawData())
            addPoint(points, p, "RAW", lineNum);
        // 从 compList 输出 CMP，附带 fromAvoid 和 rawPos（编程点）
        // 补偿矢量 offsetVector 是"通用XY几何坐标"（G17=X/Y, G18=Z/X, G19=Y/Z），
        // 需按段所在平面映射回物理轴，得到正确的补偿后 3D 物理坐标
        //（与补偿层内部 generatePMCList 的 xyToPos 一致，见 ncitpunitcomp.cpp）
        if (interpreter.buffer().size() > 0)
        {
            const auto &compList = interpreter.buffer().first().compensetor().compList();
            for (const auto &series : compList)
            {
                // 段所在平面：从 pmc_data.plane（编译器 set 的 toMotion(plane)）
                const PlaneMapper pm(static_cast<Current_Plane>(series.pmc.plane));
                const double rx = series.pmc.position.x;
                const double ry = series.pmc.position.y;
                const double rz = series.pmc.position.z;
                const int pc = planeCode(series.pmc.plane);
                qDebug() << "[CMPOUT] line" << lineNum << "actCnt" << series.actionGroup.size() << "pmcInterp" << (int)series.pmc.interp;
                for (const auto &action : series.actionGroup)
                {
                    qDebug() << "[CMPACT] line" << lineNum << "aint" << (int)action.interp << "corner" << action.isCornerArc
                             << "off" << action.offsetVector.x() << action.offsetVector.y();
                    // 补偿后物理坐标 = 编程点物理坐标 + 几何偏移写回物理轴
                    pmc_pos compPos = series.pmc.position;
                    pm.xyToPos(action.offsetVector, compPos);
                    QJsonObject pt;
                    pt["x"] = compPos.x;
                    pt["y"] = compPos.y;
                    pt["z"] = compPos.z;
                    pt["rx"] = rx;
                    pt["ry"] = ry;
                    pt["rz"] = rz;
                    pt["plane"] = pc;
                    pt["interp"] = interpName(action.interp);
                    if (isArcInterp(action.interp)) {
                        // 转角过渡圆弧：圆心 = 当前段编程终点（与 generatePMCList 一致）
                        if (action.isCornerArc) {
                            pt["cx"] = rx;
                            pt["cy"] = ry;
                            pt["cz"] = rz;
                        } else {
                            pt["cx"] = series.pmc.circle_center.x_coc;
                            pt["cy"] = series.pmc.circle_center.y_coc;
                            pt["cz"] = series.pmc.circle_center.z_coc;
                        }
                        if (action.interp == PMC_G02_5 || action.interp == PMC_G03_5)
                            pt["screw"] = series.pmc.screw_offset;
                    }
                    pt["avoid"] = action.fromAvoid;
                    pt["line"] = lineNum;
                    pt["tag"] = "CMP";
                    points.append(pt);
                }
                if (series.actionGroup.isEmpty())
                {
                    QJsonObject pt;
                    pt["x"] = rx;
                    pt["y"] = ry;
                    pt["z"] = rz;
                    pt["rx"] = rx;
                    pt["ry"] = ry;
                    pt["rz"] = rz;
                    pt["plane"] = pc;
                    pt["interp"] = interpName(series.pmc.interp);
                    if (isArcInterp(series.pmc.interp)) {
                        pt["cx"] = series.pmc.circle_center.x_coc;
                        pt["cy"] = series.pmc.circle_center.y_coc;
                        pt["cz"] = series.pmc.circle_center.z_coc;
                        if (series.pmc.interp == PMC_G02_5 || series.pmc.interp == PMC_G03_5)
                            pt["screw"] = series.pmc.screw_offset;
                    }
                    pt["avoid"] = false;
                    pt["line"] = lineNum;
                    pt["tag"] = "CMP";
                    points.append(pt);
                }
            }
        }
    }

    // 在末尾附加错误信息
    QJsonObject errors;
    QJsonArray errList;
    for (auto e : interpreter.errorList())
    {
        errList.append(QString::number((int)e));
    }
    errors["errors"] = errList;
    errors["errorStr"] = interpreter.errorStr();
    errors["tag"] = "META";
    points.append(errors);

    QJsonDocument doc(points);
    QFile file(outFile);
    if (file.open(QIODevice::WriteOnly)) {
        file.write(doc.toJson(QJsonDocument::Indented));
        file.close();
        qDebug() << "已保存:" << outFile << points.size() << "个点";
    }

    return 0;
}
