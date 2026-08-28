#!/bin/bash
cd "$(dirname "$0")"
qmake pmc_test.pro && make -j$(nproc)
