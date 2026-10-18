#!/bin/bash
# 构建 123pan-core.exe（静态链接，无外部依赖）
set -e
export PATH="/d/msys64/ucrt64/bin:$PATH"
g++ -O2 -std=c++17 -municode \
  -ffunction-sections -fdata-sections -Wl,--gc-sections \
  -static -static-libgcc -static-libstdc++ -s \
  main.cpp api.cpp http.cpp winutil.cpp \
  -o 123pan-core.exe \
  -lssl -lcrypto -lws2_32 -lcrypt32 -lshell32 -lole32 -luuid
echo "built: $(ls -la 123pan-core.exe)"
