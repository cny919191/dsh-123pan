// winutil.hpp - Windows 小工具：UTF-8/UTF-16 转换、控制台 UTF-8 输出、DPAPI 加解密
#pragma once

#include <string>

namespace winx {

// UTF-8 -> UTF-16
std::wstring widen(const std::string& s);
// UTF-16 -> UTF-8
std::string narrow(const std::wstring& s);

// 让控制台/管道按 UTF-8 输出（设置 CP_UTF8，并确保 stdout 为二进制安全）
void setupConsoleUtf8();

// 读环境变量（UTF-8）；不存在返回空
std::string getEnvUtf8(const std::string& name);

// 当前用户的 LOCALAPPDATA（UTF-8）；失败返回空
std::string localAppData();
// 当前用户的 APPDATA（UTF-8）；失败返回空
std::string appData();

// 递归创建目录（UTF-8 路径）。已存在也算成功。
bool ensureDir(const std::string& utf8Dir);

// 文件是否存在（UTF-8 路径）
bool fileExists(const std::string& utf8Path);

// DPAPI 加密 -> base64；失败返回空串
std::string dpapiProtect(const std::string& plain, const std::wstring& entropy);
// base64 -> DPAPI 解密；失败返回空串
std::string dpapiUnprotect(const std::string& b64, const std::wstring& entropy);

// 写文件（UTF-8 路径），成功返回 true
bool writeFileUtf8(const std::string& utf8Path, const std::string& data);
// 读文件（UTF-8 路径）
bool readFileUtf8(const std::string& utf8Path, std::string& out);

}  // namespace winx
