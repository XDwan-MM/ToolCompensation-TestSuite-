#!/bin/bash
#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. 编译 C++ 测试程序
echo "=== Building C++ binary ==="
cd "$DIR"
qmake pmc_test.pro && make -j$(nproc)

# 2. 安装前端依赖（首次运行）
if [ ! -d "$DIR/toolpath-sim/node_modules" ]; then
    echo "=== Installing npm dependencies ==="
    cd "$DIR/toolpath-sim"
    npm install
fi

# 3. 启动 Web 服务
echo "=== Starting Web UI ==="
cd "$DIR/toolpath-sim"
npm start
