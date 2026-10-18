// winutil.cpp - Windows 小工具实现
#include "winutil.hpp"

#include <windows.h>
#include <wincrypt.h>
#include <shlobj.h>

#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <vector>

namespace winx {

std::wstring widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}

std::string narrow(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

void setupConsoleUtf8() {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
  // stdout 以二进制方式写出，避免 \n 被翻译成 \r\n 破坏 JSON 长度
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
}

namespace {
// 用 Known Folder API 取路径，避免依赖可能被沙箱裁剪的环境变量
std::string knownFolder(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  HRESULT hr = SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p);
  std::string out;
  if (SUCCEEDED(hr) && p) out = narrow(p);
  if (p) CoTaskMemFree(p);
  return out;
}

const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string b64encode(const std::string& in) {
  std::string out;
  out.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  while (i + 2 < in.size()) {
    unsigned v = ((unsigned char)in[i] << 16) | ((unsigned char)in[i + 1] << 8) | (unsigned char)in[i + 2];
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += kB64[(v >> 6) & 63];
    out += kB64[v & 63];
    i += 3;
  }
  if (i + 1 == in.size()) {
    unsigned v = ((unsigned char)in[i] << 16);
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += "==";
  } else if (i + 2 == in.size()) {
    unsigned v = ((unsigned char)in[i] << 16) | ((unsigned char)in[i + 1] << 8);
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += kB64[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

bool b64decode(const std::string& in, std::string& out) {
  out.clear();
  unsigned buf = 0;
  int bits = 0;
  for (char c : in) {
    if (c == '=' || c == '\r' || c == '\n' || c == ' ') continue;
    int v = b64val(c);
    if (v < 0) return false;
    buf = (buf << 6) | (unsigned)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += (char)((buf >> bits) & 0xFF);
    }
  }
  return true;
}
}  // namespace

std::string getEnvUtf8(const std::string& name) {
  std::wstring wname = widen(name);
  DWORD n = GetEnvironmentVariableW(wname.c_str(), nullptr, 0);
  if (n == 0) return std::string();
  std::wstring buf;
  buf.resize((size_t)n);
  DWORD got = GetEnvironmentVariableW(wname.c_str(), &buf[0], n);
  if (got == 0 || got >= n) return std::string();
  buf.resize(got);
  return narrow(buf);
}

std::string localAppData() { return knownFolder(FOLDERID_LocalAppData); }
std::string appData() { return knownFolder(FOLDERID_RoamingAppData); }

bool ensureDir(const std::string& utf8Dir) {
  if (utf8Dir.empty()) return false;
  std::wstring w = widen(utf8Dir);
  // 逐级创建
  for (size_t i = 1; i <= w.size(); i++) {
    if (i == w.size() || w[i] == L'\\' || w[i] == L'/') {
      std::wstring sub = w.substr(0, i);
      if (sub.size() >= 2 && sub[1] == L':') continue;  // 盘符
      DWORD attr = GetFileAttributesW(sub.c_str());
      if (attr == INVALID_FILE_ATTRIBUTES) {
        if (!CreateDirectoryW(sub.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
      } else if (!(attr & FILE_ATTRIBUTE_DIRECTORY)) {
        return false;
      }
    }
  }
  return true;
}

bool fileExists(const std::string& utf8Path) {
  DWORD attr = GetFileAttributesW(widen(utf8Path).c_str());
  return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

std::string dpapiProtect(const std::string& plain, const std::wstring& entropy) {
  DATA_BLOB in{(DWORD)plain.size(), (BYTE*)(plain.empty() ? (BYTE*)"" : (BYTE*)plain.data())};
  DATA_BLOB ent{(DWORD)(entropy.size() * sizeof(wchar_t)), (BYTE*)entropy.data()};
  DATA_BLOB out{};
  if (!CryptProtectData(&in, L"dsh-123pan", entropy.empty() ? nullptr : &ent, nullptr, nullptr,
                        CRYPTPROTECT_UI_FORBIDDEN, &out)) {
    return std::string();
  }
  std::string raw((char*)out.pbData, out.cbData);
  LocalFree(out.pbData);
  return b64encode(raw);
}

std::string dpapiUnprotect(const std::string& b64, const std::wstring& entropy) {
  std::string raw;
  if (!b64decode(b64, raw) || raw.empty()) return std::string();
  DATA_BLOB in{(DWORD)raw.size(), (BYTE*)raw.data()};
  DATA_BLOB ent{(DWORD)(entropy.size() * sizeof(wchar_t)), (BYTE*)entropy.data()};
  DATA_BLOB out{};
  if (!CryptUnprotectData(&in, nullptr, entropy.empty() ? nullptr : &ent, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &out)) {
    return std::string();
  }
  std::string plain((char*)out.pbData, out.cbData);
  LocalFree(out.pbData);
  return plain;
}

bool writeFileUtf8(const std::string& utf8Path, const std::string& data) {
  FILE* f = _wfopen(widen(utf8Path).c_str(), L"wb");
  if (!f) return false;
  size_t n = fwrite(data.data(), 1, data.size(), f);
  fclose(f);
  return n == data.size();
}

bool readFileUtf8(const std::string& utf8Path, std::string& out) {
  FILE* f = _wfopen(widen(utf8Path).c_str(), L"rb");
  if (!f) return false;
  out.clear();
  char buf[8192];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
  fclose(f);
  return true;
}

}  // namespace winx
