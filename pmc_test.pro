QT += gui
QT -= core

CONFIG += qt console warn_on debug
CONFIG -= app_bundle

TEMPLATE = app

TARGET = run_pmc_test
DESTDIR = build
OBJECTS_DIR = build/obj
MOC_DIR = build/moc

SOURCES += \
    run_pmc_test.cpp \
    $$PWD/../src/ncinterpreter_p.cpp \
    $$PWD/../src/ncinterpreter.cpp \
    $$PWD/../src/ncitpunit.cpp \
    $$PWD/../src/ncitpunitcomp.cpp \
    $$PWD/../src/ncitpfilemanager.cpp \
    $$PWD/../src/ncitpvariable.cpp \
    $$PWD/../src/ncitplexical.cpp \
    $$PWD/../src/ncitpapi.cpp \
    $$PWD/../src/ncitpbuffer.cpp \
    $$PWD/../src/coordinate.cpp \
    $$PWD/../src/global.cpp \
    $$PWD/../src/grammer/grammartree.cpp \
    $$PWD/../src/grammer/grammarinterpretationvisitor.cpp \
    $$PWD/../src/grammer/grammertreevisitor.cpp \
    $$PWD/../src/grammer/jumpvisitor.cpp \
    $$PWD/../src/grammer/assignmentvisitor.cpp \
    $$PWD/../src/grammer/nccompiler.cpp \
    $$PWD/../src/grammer/node.cpp \
    $$PWD/../src/grammer/operationvisitor.cpp \
    $$PWD/../src/grammer/searchvisitor.cpp \
    $$PWD/../src/grammer/lexicalerrorvisitor.cpp \
    $$PWD/../src/grammer/realtimevarvisitor.cpp \
    $$PWD/../src/tool/intersection.cpp \
    $$PWD/../src/tool/equationsolver.cpp \
    $$PWD/../src/tool/vector.cpp \
    $$PWD/../src/tool/analysis.cpp \
    $$PWD/../src/tool/radiuscompensation.cpp \
    $$PWD/../src/tool/planemapper.cpp

HEADERS += \
    $$PWD/../include/ncinterpreter.h \
    $$PWD/../include/itpparam_p.h \
    $$PWD/../include/itpparam.h \
    $$PWD/../include/ncitperrortype.h \
    $$PWD/../include/motiondata.h \
    $$PWD/../include/ParserState.h \
    $$PWD/../src/ncinterpreter_p.h \
    $$PWD/../src/ncitpunit.h \
    $$PWD/../src/ncitpunitcomp.h \
    $$PWD/../src/ncitpbuffer.h \
    $$PWD/../src/ncitpfilemanager.h \
    $$PWD/../src/ncitpvariable.h \
    $$PWD/../src/ncitplexical.h \
    $$PWD/../api/ncitpapi.h \
    $$PWD/../include/coordinate.h \
    $$PWD/../src/global.h \
    $$PWD/../src/grammer/grammartree.h \
    $$PWD/../src/grammer/grammarinterpretationvisitor.h \
    $$PWD/../src/grammer/grammertreevisitor.h \
    $$PWD/../src/grammer/jumpvisitor.h \
    $$PWD/../src/grammer/assignmentvisitor.h \
    $$PWD/../src/grammer/nccompiler.h \
    $$PWD/../src/grammer/node.h \
    $$PWD/../src/grammer/operationvisitor.h \
    $$PWD/../src/grammer/searchvisitor.h \
    $$PWD/../src/grammer/lexicalerrorvisitor.h \
    $$PWD/../src/grammer/realtimevarvisitor.h \
    $$PWD/../src/tool/intersection.h \
    $$PWD/../src/tool/equationsolver.h \
    $$PWD/../src/tool/vector.h \
    $$PWD/../src/tool/analysis.h \
    $$PWD/../src/tool/radiuscompensation.h \
    $$PWD/../src/tool/planemapper.h \
    $$PWD/../src/tool/coordinatevec.h

INCLUDEPATH += \
    $$PWD/../src \
    $$PWD/../include \
    $$PWD/../api \
    $$PWD/../src/grammer \
    $$PWD/../src/tool \
    $$PWD/../src/grammer
