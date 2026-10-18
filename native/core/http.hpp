// http.hpp - HTTPS 客户端（OpenSSL + WinSock），供 123pan-core 使用
// 支持：GET/POST/PUT、自定义头、302 跟随、chunked 解码、二进制体。
#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>

namespace netx {

struct HttpResponse {
  int status = 0;
  std::string body;
  std::map<std::string, std::string> headers;  // 键为小写
  std::string error;                           // 非空表示传输层失败

  bool ok() const { return error.empty() && status >= 200 && status < 300; }
  std::string header(const std::string& name) const {
    auto it = headers.find(name);
    return it == headers.end() ? std::string() : it->second;
  }
};

// 全局初始化（WSA + OpenSSL + 载入 Windows 根证书），幂等。
bool globalInit(std::string& err);

// 一次 HTTP 请求。headers 为 "Name: Value" 列表；followRedirects 默认 3 次。
HttpResponse request(const std::string& method, const std::string& url,
                     const std::vector<std::string>& headers, const std::string& body,
                     int followRedirects = 3, int timeoutSec = 60);

// 下载到文件（支持 302），返回响应状态与已写字节数。
HttpResponse downloadToFile(const std::string& url, const std::string& outPath,
                            const std::vector<std::string>& headers, long long* written,
                            int timeoutSec = 120);

// 文件 MD5（小写十六进制）。失败返回空串。
std::string md5File(const std::string& path);

// 字符串 MD5。
std::string md5Text(const std::string& text);

// 百分号编码（用于 query / path 段）。
std::string urlEncode(const std::string& s);

// 从 URL 中拆出 host / port / path。
bool splitUrl(const std::string& url, std::string& host, int& port, std::string& path, bool& tls);

}  // namespace netx
