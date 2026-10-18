// http.cpp - HTTPS/HTTP 客户端实现
//
// 说明：123 云盘的 API 走 HTTPS，但下载直链是 http 明文 CDN，
// 所以传输层用一个小抽象 Conn 同时支持 TLS 与明文。
#include "http.hpp"

#include "winutil.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincrypt.h>

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509_vfy.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>

namespace netx {

namespace {

std::once_flag g_initOnce;
bool g_initOk = false;
std::string g_initErr;

// 把 Windows 系统根证书载入 OpenSSL 证书库。
// 受限令牌（低完整性）下 CertOpenSystemStore 会失败（err=5），
// 所以显式用 CertOpenStore 指定 LOCAL_MACHINE|ROOT，实测可用。
int loadWindowsRoots(X509_STORE* store) {
  int added = 0;
  HCERTSTORE h = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
                               CERT_SYSTEM_STORE_LOCAL_MACHINE | CERT_STORE_OPEN_EXISTING_FLAG, L"ROOT");
  if (!h) return -1;
  PCCERT_CONTEXT ctx = nullptr;
  while ((ctx = CertEnumCertificatesInStore(h, ctx)) != nullptr) {
    const unsigned char* p = ctx->pbCertEncoded;
    X509* x = d2i_X509(nullptr, &p, (long)ctx->cbCertEncoded);
    if (x) {
      if (X509_STORE_add_cert(store, x)) added++;
      else ERR_clear_error();  // 重复证书
      X509_free(x);
    }
  }
  CertCloseStore(h, 0);
  return added;
}

void doInit() {
  WSADATA w;
  if (WSAStartup(MAKEWORD(2, 2), &w) != 0) {
    g_initErr = "WSAStartup failed";
    return;
  }
  OPENSSL_init_ssl(0, nullptr);
  // 清掉可能指向开发机 msys2 目录的环境变量
  _putenv("SSL_CERT_FILE=");
  _putenv("SSL_CERT_DIR=");
  g_initOk = true;
}

std::string lower(std::string s) {
  for (auto& c : s) c = (char)tolower((unsigned char)c);
  return s;
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) a++;
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) b--;
  return s.substr(a, b - a);
}

// 一条已连接的传输通道（TLS 或明文）
struct Conn {
  SOCKET sock = INVALID_SOCKET;
  SSL_CTX* ctx = nullptr;
  SSL* ssl = nullptr;
  bool tls = false;
  bool broken = false;
  std::string err;

  ~Conn() { close(); }

  bool open(const std::string& host, int port, bool useTls, int timeoutSec) {
    tls = useTls;
    struct addrinfo hints {};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo* ai = nullptr;
    std::string portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &ai) != 0) {
      err = "dns failed: " + host;
      return false;
    }
    for (struct addrinfo* p = ai; p; p = p->ai_next) {
      SOCKET s = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
      if (s == INVALID_SOCKET) continue;
      DWORD tv = (DWORD)timeoutSec * 1000;
      setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
      setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));
      if (connect(s, p->ai_addr, (int)p->ai_addrlen) == 0) { sock = s; break; }
      closesocket(s);
    }
    freeaddrinfo(ai);
    if (sock == INVALID_SOCKET) {
      err = "connect failed: " + host;
      return false;
    }
    if (!tls) return true;

    ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) {
      err = "SSL_CTX_new failed";
      return false;
    }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nullptr);
    if (loadWindowsRoots(SSL_CTX_get_cert_store(ctx)) <= 0) {
      SSL_CTX_set_default_verify_paths(ctx);
    }
    ssl = SSL_new(ctx);
    SSL_set_tlsext_host_name(ssl, host.c_str());
    SSL_set1_host(ssl, host.c_str());
    SSL_set_fd(ssl, (int)sock);
    if (SSL_connect(ssl) != 1) {
      long vr = SSL_get_verify_result(ssl);
      err = std::string("tls handshake failed: ") + X509_verify_cert_error_string(vr);
      return false;
    }
    return true;
  }

  bool sendAll(const char* data, size_t len) {
    size_t off = 0;
    while (off < len) {
      size_t chunk = std::min<size_t>(len - off, 0x7fffffff);
      int n = tls ? SSL_write(ssl, data + off, (int)chunk)
                  : ::send(sock, data + off, (int)chunk, 0);
      if (n <= 0) {
        broken = true;
        return false;
      }
      off += (size_t)n;
    }
    return true;
  }

  // 返回读取字节数；0 表示对端关闭；<0 表示错误
  int read(char* buf, int cap) {
    if (tls) {
      int n = SSL_read(ssl, buf, cap);
      if (n <= 0) {
        int e = SSL_get_error(ssl, n);
        if (e == SSL_ERROR_ZERO_RETURN) return 0;
        return -1;
      }
      return n;
    }
    int n = ::recv(sock, buf, cap, 0);
    if (n == 0) return 0;
    if (n < 0) return -1;
    return n;
  }

  void close() {
    if (ssl) {
      SSL_shutdown(ssl);
      SSL_free(ssl);
      ssl = nullptr;
    }
    if (ctx) {
      SSL_CTX_free(ctx);
      ctx = nullptr;
    }
    if (sock != INVALID_SOCKET) {
      closesocket(sock);
      sock = INVALID_SOCKET;
    }
  }
};

// 读响应头，rest 为已读到的 body 前缀
bool readHead(Conn& c, std::string& head, std::string& rest) {
  char buf[4096];
  size_t scanned = 0;
  while (true) {
    int n = c.read(buf, (int)sizeof(buf));
    if (n <= 0) return false;
    head.append(buf, (size_t)n);
    size_t from = scanned > 3 ? scanned - 3 : 0;
    size_t pos = head.find("\r\n\r\n", from);
    if (pos != std::string::npos) {
      rest = head.substr(pos + 4);
      head.resize(pos);
      return true;
    }
    if (head.size() > 1024 * 1024) return false;
    scanned = head.size();
  }
}

void parseHead(const std::string& head, HttpResponse& res) {
  size_t p = head.find("\r\n");
  std::string statusLine = head.substr(0, p == std::string::npos ? head.size() : p);
  int code = 0;
  if (sscanf(statusLine.c_str(), "HTTP/%*d.%*d %d", &code) == 1) res.status = code;
  size_t cur = (p == std::string::npos) ? head.size() : p + 2;
  while (cur < head.size()) {
    size_t e = head.find("\r\n", cur);
    std::string line = head.substr(cur, e == std::string::npos ? std::string::npos : e - cur);
    size_t colon = line.find(':');
    if (colon != std::string::npos) {
      res.headers[lower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1));
    }
    if (e == std::string::npos) break;
    cur = e + 2;
  }
}

// 逐块读取 chunked 正文，回调写出去
bool streamChunked(Conn& c, const std::string& prefix,
                   const std::function<bool(const char*, size_t)>& sink, std::string& err) {
  std::string buf = prefix;
  size_t pos = 0;
  char tmp[16384];
  while (true) {
    size_t eol;
    while ((eol = buf.find("\r\n", pos)) == std::string::npos) {
      int n = c.read(tmp, (int)sizeof(tmp));
      if (n <= 0) { err = "chunked: closed in size line"; return false; }
      buf.append(tmp, (size_t)n);
    }
    std::string sizeLine = buf.substr(pos, eol - pos);
    size_t semi = sizeLine.find(';');
    if (semi != std::string::npos) sizeLine.resize(semi);
    unsigned long long chunkLen = 0;
    try {
      chunkLen = std::stoull(sizeLine, nullptr, 16);
    } catch (...) {
      err = "chunked: bad size";
      return false;
    }
    pos = eol + 2;
    if (chunkLen == 0) return true;
    while (buf.size() < pos + chunkLen + 2) {
      int n = c.read(tmp, (int)sizeof(tmp));
      if (n <= 0) { err = "chunked: closed in data"; return false; }
      buf.append(tmp, (size_t)n);
    }
    if (!sink(buf.data() + pos, (size_t)chunkLen)) {
      err = "sink failed";
      return false;
    }
    pos += (size_t)chunkLen + 2;
    if (pos > (1 << 20)) {
      buf.erase(0, pos);
      pos = 0;
    }
  }
}

// 逐块读取定长/直到关闭，回调写出去
bool streamPlain(Conn& c, const std::string& prefix, long long contentLen,
                 const std::function<bool(const char*, size_t)>& sink, std::string& err) {
  long long got = 0;
  if (!prefix.empty()) {
    if (!sink(prefix.data(), prefix.size())) { err = "sink failed"; return false; }
    got += (long long)prefix.size();
  }
  char tmp[65536];
  while (contentLen < 0 || got < contentLen) {
    int n = c.read(tmp, (int)sizeof(tmp));
    if (n <= 0) break;
    long long want = contentLen < 0 ? n : std::min<long long>(n, contentLen - got);
    if (want > 0 && !sink(tmp, (size_t)want)) { err = "sink failed"; return false; }
    got += want;
  }
  return true;
}

// 发起一次请求（不跟随重定向）
HttpResponse doRequest(const std::string& method, const std::string& url,
                       const std::vector<std::string>& headers, const std::string& body,
                       int timeoutSec) {
  HttpResponse res;
  std::string host, path;
  int port = 443;
  bool tls = true;
  if (!splitUrl(url, host, port, path, tls)) {
    res.error = "bad url: " + url;
    return res;
  }
  Conn c;
  if (!c.open(host, port, tls, timeoutSec)) {
    res.error = c.err;
    return res;
  }

  std::string req;
  req.reserve(512 + body.size());
  req += method + " " + path + " HTTP/1.1\r\n";
  req += "Host: " + host + (((tls && port == 443) || (!tls && port == 80)) ? "" : (":" + std::to_string(port))) + "\r\n";
  bool hasUA = false, hasAccept = false, hasConn = false;
  for (auto& h : headers) {
    std::string lh = lower(h);
    if (lh.rfind("user-agent:", 0) == 0) hasUA = true;
    if (lh.rfind("accept:", 0) == 0) hasAccept = true;
    if (lh.rfind("connection:", 0) == 0) hasConn = true;
    req += h + "\r\n";
  }
  if (!hasUA) req += "User-Agent: dsh-123pan/1.0\r\n";
  if (!hasAccept) req += "Accept: */*\r\n";
  if (!hasConn) req += "Connection: close\r\n";
  if (!body.empty() || method == "POST" || method == "PUT") {
    req += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  }
  req += "\r\n";
  req += body;

  if (!c.sendAll(req.data(), req.size())) {
    res.error = "send failed";
    return res;
  }

  std::string head, rest;
  if (!readHead(c, head, rest)) {
    res.error = "read headers failed";
    return res;
  }
  parseHead(head, res);

  // 注意：123 的下载 CDN 会同时返回 Content-Length 与 Transfer-Encoding: chunked，
  // 而正文其实是定长的（不是 chunked）。所以有 Content-Length 时一律按定长读。
  long long contentLen = -1;
  std::string cl = res.header("content-length");
  if (!cl.empty()) {
    try { contentLen = std::stoll(cl); } catch (...) {}
  }
  bool chunked = contentLen < 0 && lower(res.header("transfer-encoding")).find("chunked") != std::string::npos;

  std::string err;
  bool ok;
  // API 响应都是小 JSON；给个上限，避免异常服务端把内存吃干
  const size_t kMaxApiBody = 32u * 1024 * 1024;
  bool overflow = false;
  auto append = [&](const char* p, size_t n) {
    if (res.body.size() + n > kMaxApiBody) {
      overflow = true;
      return false;
    }
    res.body.append(p, n);
    return true;
  };
  if (chunked) {
    ok = streamChunked(c, rest, append, err);
  } else {
    ok = streamPlain(c, rest, contentLen, append, err);
  }
  if (overflow) {
    res.error = "响应体超过 32MB 上限";
    return res;
  }
  if (!ok) res.error = err;
  return res;
}

}  // namespace

bool globalInit(std::string& err) {
  std::call_once(g_initOnce, doInit);
  if (!g_initOk) {
    err = g_initErr.empty() ? "network init failed" : g_initErr;
    return false;
  }
  return true;
}

HttpResponse request(const std::string& method, const std::string& url,
                     const std::vector<std::string>& headers, const std::string& body,
                     int followRedirects, int timeoutSec) {
  std::string err;
  if (!globalInit(err)) {
    HttpResponse r;
    r.error = err;
    return r;
  }
  std::string curUrl = url;
  std::string curMethod = method;
  std::string curBody = body;
  for (int hop = 0; hop <= followRedirects; hop++) {
    HttpResponse r = doRequest(curMethod, curUrl, headers, curBody, timeoutSec);
    if (!r.error.empty()) return r;
    bool redirect = (r.status == 301 || r.status == 302 || r.status == 303 || r.status == 307 || r.status == 308);
    std::string loc = r.header("location");
    if (redirect && !loc.empty() && hop < followRedirects) {
      if (loc.rfind("http://", 0) != 0 && loc.rfind("https://", 0) != 0) {
        std::string h, p;
        int port;
        bool tls;
        if (splitUrl(curUrl, h, port, p, tls)) {
          std::string base = std::string(tls ? "https://" : "http://") + h +
                             (((tls && port == 443) || (!tls && port == 80)) ? "" : (":" + std::to_string(port)));
          loc = base + ((loc.empty() || loc[0] != '/') ? "/" : "") + loc;
        }
      }
      curUrl = loc;
      if (r.status == 303 || ((r.status == 301 || r.status == 302) && curMethod == "POST")) {
        curMethod = "GET";
        curBody.clear();
      }
      continue;
    }
    return r;
  }
  HttpResponse r;
  r.error = "too many redirects";
  return r;
}

HttpResponse downloadToFile(const std::string& url, const std::string& outPath,
                            const std::vector<std::string>& headers, long long* written,
                            int timeoutSec) {
  if (written) *written = 0;
  HttpResponse res;
  std::string err;
  if (!globalInit(err)) {
    res.error = err;
    return res;
  }

  // 手动跟随重定向（最多 5 跳），最终响应才落盘
  std::string curUrl = url;
  for (int hop = 0; hop <= 5; hop++) {
    std::string host, path;
    int port = 443;
    bool tls = true;
    if (!splitUrl(curUrl, host, port, path, tls)) {
      res.error = "bad url";
      return res;
    }
    Conn c;
    if (!c.open(host, port, tls, timeoutSec)) {
      res.error = c.err;
      return res;
    }
    std::string req;
    req += "GET " + path + " HTTP/1.1\r\n";
    req += "Host: " + host + (((tls && port == 443) || (!tls && port == 80)) ? "" : (":" + std::to_string(port))) + "\r\n";
    req += "User-Agent: dsh-123pan/1.0\r\nAccept: */*\r\nConnection: close\r\n";
    for (auto& h : headers) req += h + "\r\n";
    req += "\r\n";
    if (!c.sendAll(req.data(), req.size())) {
      res.error = "send failed";
      return res;
    }
    std::string head, rest;
    if (!readHead(c, head, rest)) {
      res.error = "read headers failed";
      return res;
    }
    parseHead(head, res);
    std::string loc = res.header("location");
    bool redirect = (res.status == 301 || res.status == 302 || res.status == 303 || res.status == 307 ||
                     res.status == 308);
    if (redirect && !loc.empty() && hop < 5) {
      if (loc.rfind("http://", 0) != 0 && loc.rfind("https://", 0) != 0) {
        std::string base = std::string(tls ? "https://" : "http://") + host +
                           (((tls && port == 443) || (!tls && port == 80)) ? "" : (":" + std::to_string(port)));
        loc = base + ((loc.empty() || loc[0] != '/') ? "/" : "") + loc;
      }
      curUrl = loc;
      continue;
    }

    FILE* f = _wfopen(winx::widen(outPath).c_str(), L"wb");
    if (!f) {
      res.error = "cannot open output file: " + outPath;
      return res;
    }
    long long total = 0;
    auto sink = [&](const char* p, size_t n) {
      size_t w = fwrite(p, 1, n, f);
      total += (long long)w;
      return w == n;
    };
    long long contentLen = -1;
    std::string cl = res.header("content-length");
    if (!cl.empty()) {
      try { contentLen = std::stoll(cl); } catch (...) {}
    }
    bool chunked = contentLen < 0 && lower(res.header("transfer-encoding")).find("chunked") != std::string::npos;
    std::string serr;
    bool ok = chunked ? streamChunked(c, rest, sink, serr) : streamPlain(c, rest, contentLen, sink, serr);
    fclose(f);
    if (!ok) {
      res.error = serr;
      return res;
    }
    if (written) *written = total;
    return res;
  }
  res.error = "too many redirects";
  return res;
}

std::string md5File(const std::string& path) {
  FILE* f = _wfopen(winx::widen(path).c_str(), L"rb");
  if (!f) return "";
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  if (!ctx) { fclose(f); return ""; }
  EVP_DigestInit_ex(ctx, EVP_md5(), nullptr);
  std::vector<unsigned char> buf(1 << 20);
  while (true) {
    size_t n = fread(buf.data(), 1, buf.size(), f);
    if (n == 0) break;
    EVP_DigestUpdate(ctx, buf.data(), n);
  }
  fclose(f);
  unsigned char d[EVP_MAX_MD_SIZE];
  unsigned int dl = 0;
  EVP_DigestFinal_ex(ctx, d, &dl);
  EVP_MD_CTX_free(ctx);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.resize(dl * 2);
  for (unsigned i = 0; i < dl; i++) {
    out[i * 2] = hex[d[i] >> 4];
    out[i * 2 + 1] = hex[d[i] & 0xF];
  }
  return out;
}

std::string md5Text(const std::string& text) {
  unsigned char d[EVP_MAX_MD_SIZE];
  unsigned int dl = 0;
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  EVP_DigestInit_ex(ctx, EVP_md5(), nullptr);
  EVP_DigestUpdate(ctx, text.data(), text.size());
  EVP_DigestFinal_ex(ctx, d, &dl);
  EVP_MD_CTX_free(ctx);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.resize(dl * 2);
  for (unsigned i = 0; i < dl; i++) {
    out[i * 2] = hex[d[i] >> 4];
    out[i * 2 + 1] = hex[d[i] & 0xF];
  }
  return out;
}

std::string urlEncode(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  out.reserve(s.size() * 3);
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
        c == '.' || c == '~') {
      out += (char)c;
    } else {
      out += '%';
      out += hex[c >> 4];
      out += hex[c & 0xF];
    }
  }
  return out;
}

bool splitUrl(const std::string& url, std::string& host, int& port, std::string& path, bool& tls) {
  std::string u = url;
  tls = true;
  if (u.rfind("https://", 0) == 0) { u = u.substr(8); tls = true; }
  else if (u.rfind("http://", 0) == 0) { u = u.substr(7); tls = false; }
  else return false;
  size_t slash = u.find('/');
  std::string authority = slash == std::string::npos ? u : u.substr(0, slash);
  path = slash == std::string::npos ? "/" : u.substr(slash);
  port = tls ? 443 : 80;
  size_t colon = authority.rfind(':');
  if (colon != std::string::npos) {
    host = authority.substr(0, colon);
    try { port = std::stoi(authority.substr(colon + 1)); } catch (...) { return false; }
  } else {
    host = authority;
  }
  return !host.empty();
}

}  // namespace netx
