// api.cpp - 123 云盘 API 实现
#include "api.hpp"

#include <algorithm>
#include <map>
#include <windows.h>

#include <cstdio>
#include <cstring>
#include <thread>

#include "http.hpp"
#include "winutil.hpp"

namespace pan123 {

namespace {
const char* kApiBase = "https://api.123278.com";
const char* kLoginBase = "https://login.123pan.com";
const char* kAppVersion = "3.2.7";
const char* kUA = "123pan/3.2.7";

std::vector<std::string> authHeaders(const std::string& token, bool json) {
  std::vector<std::string> h;
  h.push_back("Authorization: Bearer " + token);
  h.push_back("platform: pc");
  h.push_back("app-version: 3.2.7");
  h.push_back("Accept: application/json");
  h.push_back(std::string("User-Agent: ") + kUA);
  h.push_back("Origin: https://yun.123pan.cn");
  h.push_back("Referer: https://yun.123pan.cn/");
  if (json) h.push_back("Content-Type: application/json");
  return h;
}

// 去掉可能存在的 "Bearer " 前缀
std::string stripBearer(std::string t) {
  while (!t.empty() && (t.back() == '\r' || t.back() == '\n' || t.back() == ' ')) t.pop_back();
  size_t i = 0;
  while (i < t.size() && (t[i] == ' ' || t[i] == '\t')) i++;
  t = t.substr(i);
  if (t.size() > 7 && (t.compare(0, 7, "Bearer ") == 0 || t.compare(0, 7, "bearer ") == 0)) t = t.substr(7);
  return t;
}

// 从信封里取 data / 错误
bool unwrap(const netx::HttpResponse& r, jsonx::JVal& out, ApiError& err) {
  if (!r.error.empty()) {
    err.code = -100;
    err.message = r.error;
    return false;
  }
  jsonx::JVal root;
  if (!jsonx::parse(r.body, root) || !root.isObj()) {
    err.code = r.status;
    err.message = "unexpected response: " + r.body.substr(0, 200);
    return false;
  }
  int code = (int)root.intOr("code", -1);
  err.traceId = root.strOr("trace_id");
  if (code != 0) {
    err.code = code;
    err.message = root.strOr("message", "unknown error");
    if (err.message.empty()) err.message = "code " + std::to_string(code);
    return false;
  }
  const jsonx::JVal* d = root.find("data");
  out = d ? *d : jsonx::JVal::object();
  return true;
}

std::string joinPath(const std::string& base, const std::string& path) { return base + path; }

}  // namespace

std::string formatBytes(long long n) {
  const char* units[] = {"B", "KB", "MB", "GB", "TB"};
  double v = (double)n;
  int u = 0;
  while (v >= 1024.0 && u < 4) {
    v /= 1024.0;
    u++;
  }
  char buf[64];
  if (u == 0) snprintf(buf, sizeof(buf), "%lld B", n);
  else snprintf(buf, sizeof(buf), "%.2f %s", v, units[u]);
  return buf;
}

bool parseIds(const std::string& csv, std::vector<long long>& out) {
  out.clear();
  std::string cur;
  for (size_t i = 0; i <= csv.size(); i++) {
    char c = i < csv.size() ? csv[i] : ',';
    if (c == ',' || c == ' ' || c == ';' || c == '\t') {
      if (!cur.empty()) {
        try {
          out.push_back(std::stoll(cur));
        } catch (...) {
          return false;
        }
        cur.clear();
      }
    } else {
      cur += c;
    }
  }
  return !out.empty();
}

// ---------------- SessionStore ----------------

std::string SessionStore::defaultPath() {
  // 1) 显式环境变量：宿主插件用它指向自己可写的目录（沙箱工作区里 LOCALAPPDATA 可能不可写）
  std::string env = winx::getEnvUtf8("DSH_123PAN_STORE");
  if (!env.empty()) return env;
  // 2) 用户 LOCALAPPDATA
  std::string base = winx::localAppData();
  if (base.empty()) base = winx::appData();
  if (base.empty()) return std::string();
  return base + "\\dsh-123pan\\session.dat";
}

bool SessionStore::save(const Session& s, std::string& err) {
  if (path_.empty()) {
    err = "no session path";
    return false;
  }
  size_t slash = path_.find_last_of("\\/");
  if (slash != std::string::npos && !winx::ensureDir(path_.substr(0, slash))) {
    err = "cannot create directory for session file";
    return false;
  }
  jsonx::JVal j = jsonx::JVal::object();
  j.set("token", jsonx::JVal::of(s.token));
  j.set("expire", jsonx::JVal::of(s.expire));
  j.set("uid", jsonx::JVal::of((long long)s.uid));
  j.set("nickname", jsonx::JVal::of(s.nickname));
  j.set("passport", jsonx::JVal::of(s.passport));
  std::string enc = winx::dpapiProtect(j.dump(), L"dsh-123pan/session");
  if (enc.empty()) {
    err = "DPAPI protect failed";
    return false;
  }
  if (!winx::writeFileUtf8(path_, enc)) {
    err = "cannot write session file";
    return false;
  }
  return true;
}

bool SessionStore::load(Session& s) {
  std::string enc;
  if (!winx::readFileUtf8(path_, enc) || enc.empty()) return false;
  std::string plain = winx::dpapiUnprotect(enc, L"dsh-123pan/session");
  if (plain.empty()) return false;
  jsonx::JVal j;
  if (!jsonx::parse(plain, j) || !j.isObj()) return false;
  s.token = j.strOr("token");
  s.expire = j.strOr("expire");
  s.uid = j.intOr("uid");
  s.nickname = j.strOr("nickname");
  s.passport = j.strOr("passport");
  return !s.token.empty();
}

bool SessionStore::clear() {
  if (path_.empty()) return false;
  return DeleteFileW(winx::widen(path_).c_str()) != 0;
}

// ---------------- Client ----------------

bool Client::call(const std::string& path, const std::string& method, const jsonx::JVal* body,
                  const std::string& query, jsonx::JVal& out, ApiError& err) {
  std::string url = joinPath(kApiBase, path);
  if (!query.empty()) url += (url.find('?') == std::string::npos ? "?" : "&") + query;
  std::string payload;
  if (body) payload = body->dump();
  netx::HttpResponse r = netx::request(method, url, authHeaders(sess_.token, body != nullptr), payload, 3, 120);
  return unwrap(r, out, err);
}

bool Client::login(const std::string& account, const std::string& password, bool isMail, Session& out,
                   ApiError& err) {
  std::string acc = account;
  // 去空白
  while (!acc.empty() && (acc.front() == ' ' || acc.front() == '\t')) acc.erase(acc.begin());
  while (!acc.empty() && (acc.back() == ' ' || acc.back() == '\t' || acc.back() == '\r')) acc.pop_back();

  jsonx::JVal body = jsonx::JVal::object();
  if (isMail) {
    body.set("mail", jsonx::JVal::of(acc));
    body.set("password", jsonx::JVal::of(password));
    body.set("type", jsonx::JVal::of(2));
  } else {
    body.set("passport", jsonx::JVal::of(acc));
    body.set("password", jsonx::JVal::of(password));
    body.set("remember", jsonx::JVal::of(true));
    body.set("type", jsonx::JVal::of(1));
  }

  std::vector<std::string> h;
  h.push_back("origin: https://yun.123pan.com");
  h.push_back("referer: https://yun.123pan.com/");
  h.push_back("user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-123pan/1.0");
  h.push_back("platform: web");
  h.push_back("app-version: 3");
  h.push_back("Accept: application/json");
  h.push_back("Content-Type: application/json");

  netx::HttpResponse r = netx::request("POST", joinPath(kLoginBase, "/api/user/sign_in"), h, body.dump(), 3, 60);
  if (!r.error.empty()) {
    err.code = -100;
    err.message = r.error;
    return false;
  }
  jsonx::JVal root;
  if (!jsonx::parse(r.body, root) || !root.isObj()) {
    err.code = r.status;
    err.message = "unexpected login response";
    return false;
  }
  int code = (int)root.intOr("code", -1);
  err.traceId = root.strOr("trace_id");
  if (code != 0 && code != 200) {
    err.code = code;
    err.message = root.strOr("message", "login failed");
    return false;
  }
  const jsonx::JVal* d = root.find("data");
  if (!d || !d->isObj()) {
    err.code = code;
    err.message = "login response missing data";
    return false;
  }
  out.token = stripBearer(d->strOr("token"));
  out.expire = d->strOr("expire");
  if (out.token.empty()) {
    err.code = code;
    err.message = "login response missing token";
    return false;
  }
  out.passport = acc;
  err.code = 0;
  err.message.clear();
  return true;
}

bool Client::userInfo(jsonx::JVal& out, ApiError& err) {
  // 用 web 平台头取完整信息（含容量）；失败则退回 pc 头
  std::vector<std::string> h;
  h.push_back("Authorization: Bearer " + sess_.token);
  h.push_back("platform: web");
  h.push_back("app-version: 3");
  h.push_back("Accept: application/json");
  h.push_back("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-123pan/1.0");
  netx::HttpResponse r = netx::request("GET", joinPath(kApiBase, "/api/user/info"), h, std::string(), 3, 30);
  if (unwrap(r, out, err)) return true;
  // 回退到 pc 头
  return call("/api/user/info", "GET", nullptr, "", out, err);
}

bool Client::listFiles(long long parentId, int limit, const std::string& next, bool trashed,
                       const std::string& search, jsonx::JVal& out, ApiError& err) {
  std::string q;
  q += "driveId=0";
  q += "&parentFileId=" + std::to_string(parentId);
  q += "&limit=" + std::to_string(limit <= 0 ? 100 : limit);
  q += "&type=0";
  q += "&orderBy=file_id";
  q += "&orderDirection=desc";
  q += std::string("&trashed=") + (trashed ? "true" : "false");
  q += "&searchData=" + netx::urlEncode(search);
  if (!next.empty() && next != "-1") q += "&next=" + netx::urlEncode(next);
  return call("/api/file/list/new", "GET", nullptr, q, out, err);
}

bool Client::mkdir(long long parentId, const std::string& name, long long& newId, ApiError& err) {
  jsonx::JVal body = jsonx::JVal::object();
  body.set("driveId", jsonx::JVal::of(0));
  body.set("parentFileId", jsonx::JVal::of((long long)parentId));
  body.set("filename", jsonx::JVal::of(name));
  body.set("type", jsonx::JVal::of(1));
  body.set("size", jsonx::JVal::of(0));
  body.set("etag", jsonx::JVal::of(""));
  body.set("duplicate", jsonx::JVal::of(1));
  jsonx::JVal out;
  if (!call("/api/file/upload_request", "POST", &body, "", out, err)) return false;
  const jsonx::JVal* info = out.find("Info");
  newId = info ? info->intOr("FileId", out.intOr("FileId", 0)) : out.intOr("FileId", 0);
  return true;
}

bool Client::uploadFile(const std::string& localPath, long long parentId, const std::string& remoteName,
                        int concurrency, const ProgressFn& progress, jsonx::JVal& out, ApiError& err) {
  (void)concurrency;  // 顺序分片即可，避免触发风控
  if (!winx::fileExists(localPath)) {
    err.code = -2;
    err.message = "local file not found: " + localPath;
    return false;
  }
  // 文件大小
  WIN32_FILE_ATTRIBUTE_DATA fad;
  if (!GetFileAttributesExW(winx::widen(localPath).c_str(), GetFileExInfoStandard, &fad)) {
    err.code = -2;
    err.message = "cannot stat local file";
    return false;
  }
  long long size = ((long long)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;

  std::string name = remoteName;
  if (name.empty()) {
    size_t slash = localPath.find_last_of("\\/");
    name = slash == std::string::npos ? localPath : localPath.substr(slash + 1);
  }

  if (progress) progress(0.02, "计算 MD5");
  std::string etag = netx::md5File(localPath);
  if (etag.empty()) {
    err.code = -3;
    err.message = "cannot compute md5";
    return false;
  }

  if (progress) progress(0.05, "申请上传");
  jsonx::JVal req = jsonx::JVal::object();
  req.set("driveId", jsonx::JVal::of(0));
  req.set("parentFileId", jsonx::JVal::of((long long)parentId));
  req.set("filename", jsonx::JVal::of(name));
  req.set("type", jsonx::JVal::of(0));
  req.set("size", jsonx::JVal::of((long long)size));
  req.set("etag", jsonx::JVal::of(etag));
  req.set("duplicate", jsonx::JVal::of(1));
  jsonx::JVal up;
  if (!call("/api/file/upload_request", "POST", &req, "", up, err)) return false;

  if (up.boolOr("Reuse")) {
    // 秒传
    const jsonx::JVal* info = up.find("Info");
    out = info ? *info : up;
    out.set("reused", jsonx::JVal::of(true));
    if (progress) progress(1.0, "秒传完成");
    return true;
  }

  long long fid = up.intOr("FileId");
  std::string key = up.strOr("Key");
  std::string bucket = up.strOr("Bucket");
  std::string uploadId = up.strOr("UploadId");
  std::string node = up.strOr("StorageNode");
  long long slice = up.intOr("SliceSize", 16777216);
  if (slice <= 0) slice = 16777216;
  // 防御服务端返回异常分片大小：上限 64MB，避免一次申请巨量内存
  if (slice > 64LL * 1024 * 1024) slice = 64LL * 1024 * 1024;
  if (slice < 1024 * 1024) slice = 1024 * 1024;
  if (fid == 0 || key.empty() || uploadId.empty()) {
    err.code = -4;
    err.message = "upload_request returned incomplete data";
    return false;
  }

  // 分片数（最后一片可以更小）
  long long chunkCountLL = (size + slice - 1) / slice;
  if (chunkCountLL <= 0) chunkCountLL = 1;
  // S3 分片上限 10000；超了就放大分片，避免被服务端拒绝
  if (chunkCountLL > 10000) {
    slice = (size + 9999) / 10000;
    if (slice < 1024 * 1024) slice = 1024 * 1024;
    chunkCountLL = (size + slice - 1) / slice;
  }
  int chunkCount = (int)chunkCountLL;
  bool multipart = chunkCount > 1;

  // 取预签名 URL：
  //   单分片 -> s3_upload_object/auth + {driveId,fileId,uploadId,bucket,key,storageNode,partNumber}
  //   多分片 -> s3_repare_upload_parts_batch + {bucket,key,partNumberStart,partNumberEnd,uploadId,StorageNode}
  // 注意多分片接口的 StorageNode 是首字母大写，且没有 driveId/fileId；
  // 实测传小写或加 driveId 会返回「非法请求」。
  std::map<int, std::string> urls;
  if (!multipart) {
    jsonx::JVal auth = jsonx::JVal::object();
    auth.set("driveId", jsonx::JVal::of(0));
    auth.set("fileId", jsonx::JVal::of((long long)fid));
    auth.set("uploadId", jsonx::JVal::of(uploadId));
    auth.set("bucket", jsonx::JVal::of(bucket));
    auth.set("key", jsonx::JVal::of(key));
    auth.set("storageNode", jsonx::JVal::of(node));
    auth.set("partNumber", jsonx::JVal::of(1));
    jsonx::JVal authOut;
    if (!call("/api/file/s3_upload_object/auth", "POST", &auth, "", authOut, err)) return false;
    const jsonx::JVal* list = authOut.find("presignedUrls");
    if (list && list->isObj()) {
      const jsonx::JVal* one = list->find("1");
      if (one && one->isStr()) urls[1] = one->str;
    }
    if (urls.empty()) {
      err.code = -5;
      err.message = "presigned url missing";
      return false;
    }
  } else {
    if (progress) progress(0.06, "申请分片地址");
    jsonx::JVal pre = jsonx::JVal::object();
    pre.set("bucket", jsonx::JVal::of(bucket));
    pre.set("key", jsonx::JVal::of(key));
    pre.set("partNumberStart", jsonx::JVal::of(1));
    pre.set("partNumberEnd", jsonx::JVal::of((long long)(chunkCount + 1)));
    pre.set("uploadId", jsonx::JVal::of(uploadId));
    pre.set("StorageNode", jsonx::JVal::of(node));
    jsonx::JVal preOut;
    if (!call("/api/file/s3_repare_upload_parts_batch", "POST", &pre, "", preOut, err)) return false;
    const jsonx::JVal* list = preOut.find("presignedUrls");
    if (list && list->isObj()) {
      for (auto& kv : list->obj) {
        if (!kv.second.isStr()) continue;
        try {
          urls[std::stoi(kv.first)] = kv.second.str;
        } catch (...) {
        }
      }
    }
    if ((int)urls.size() < chunkCount) {
      err.code = -5;
      err.message = "presigned urls incomplete (" + std::to_string(urls.size()) + "/" + std::to_string(chunkCount) + ")";
      return false;
    }
  }

  FILE* f = _wfopen(winx::widen(localPath).c_str(), L"rb");
  if (!f) {
    err.code = -2;
    err.message = "cannot open local file";
    return false;
  }
  std::vector<char> buf((size_t)slice);
  long long sent = 0;
  bool failed = false;
  for (int part = 1; part <= chunkCount; part++) {
    size_t want = (size_t)std::min<long long>(slice, size - sent);
    size_t got = fread(buf.data(), 1, want, f);
    if (got != want) {
      err.code = -2;
      err.message = "read local file failed";
      failed = true;
      break;
    }
    auto it = urls.find(part);
    if (it == urls.end()) {
      err.code = -5;
      err.message = "presigned url missing for part " + std::to_string(part);
      failed = true;
      break;
    }
    std::vector<std::string> ph;
    ph.push_back("Content-Type: application/octet-stream");
    ph.push_back("User-Agent: dsh-123pan/1.0");
    std::string chunk(buf.data(), got);
    netx::HttpResponse pr = netx::request("PUT", it->second, ph, chunk, 0, 600);
    if (!pr.error.empty() || pr.status < 200 || pr.status >= 300) {
      err.code = pr.status ? pr.status : -6;
      err.message = pr.error.empty() ? ("part upload http " + std::to_string(pr.status)) : pr.error;
      failed = true;
      break;
    }
    sent += (long long)got;
    if (progress) {
      double frac = 0.10 + 0.85 * ((double)sent / (double)(size > 0 ? size : 1));
      progress(frac, "上传 " + formatBytes(sent) + " / " + formatBytes(size));
    }
  }
  fclose(f);
  if (failed) return false;

  if (progress) progress(0.97, "提交完成");
  // 完成接口：单分片用小写 storageNode（实测），多分片用大写 StorageNode + fileSize + isMultipart
  jsonx::JVal done = jsonx::JVal::object();
  done.set("bucket", jsonx::JVal::of(bucket));
  done.set("fileId", jsonx::JVal::of((long long)fid));
  done.set("key", jsonx::JVal::of(key));
  done.set("uploadId", jsonx::JVal::of(uploadId));
  if (multipart) {
    done.set("StorageNode", jsonx::JVal::of(node));
    done.set("fileSize", jsonx::JVal::of((long long)size));
    done.set("isMultipart", jsonx::JVal::of(true));
  } else {
    done.set("driveId", jsonx::JVal::of(0));
    done.set("storageNode", jsonx::JVal::of(node));
  }
  jsonx::JVal doneOut;
  if (!call("/api/file/upload_complete/v2", "POST", &done, "", doneOut, err)) return false;
  const jsonx::JVal* info = doneOut.find("file_info");
  out = info ? *info : doneOut;
  if (progress) progress(1.0, "完成");
  return true;
}

bool Client::directUrl(long long fileId, std::string& url, ApiError& err) {
  jsonx::JVal out;
  if (!call("/api/file/download", "GET", nullptr, "file_id=" + std::to_string(fileId), out, err)) return false;
  url = out.strOr("url");
  if (url.empty()) {
    // v2 兜底
    jsonx::JVal v2;
    if (call("/api/v2/file/download", "GET", nullptr, "file_id=" + std::to_string(fileId), v2, err)) {
      const jsonx::JVal* dl = v2.find("dispatchList");
      std::string prefix;
      if (dl && dl->isArr() && !dl->arr.empty()) prefix = dl->arr[0].strOr("prefix");
      std::string dp = v2.strOr("downloadPath");
      if (!prefix.empty() && !dp.empty()) url = prefix + dp;
    }
  }
  if (url.empty()) {
    if (err.code == 0) {
      err.code = -7;
      err.message = "download url not found";
    }
    return false;
  }
  return true;
}

bool Client::downloadFile(long long fileId, const std::string& outPath, const ProgressFn& progress,
                          long long& bytes, ApiError& err) {
  bytes = 0;
  std::string url;
  if (!directUrl(fileId, url, err)) return false;
  if (progress) progress(0.05, "连接下载节点");
  std::vector<std::string> h;
  h.push_back("User-Agent: 123pan/3.2.7");
  long long written = 0;
  netx::HttpResponse r = netx::downloadToFile(url, outPath, h, &written, 600);
  if (!r.error.empty()) {
    err.code = -8;
    err.message = r.error;
    return false;
  }
  if (r.status < 200 || r.status >= 300) {
    err.code = r.status;
    err.message = "download http " + std::to_string(r.status);
    return false;
  }
  bytes = written;
  if (progress) progress(1.0, "下载完成 " + formatBytes(written));
  return true;
}

bool Client::trash(const std::vector<long long>& ids, ApiError& err) {
  jsonx::JVal body = jsonx::JVal::object();
  body.set("RequestSource", jsonx::JVal());
  body.set("driveId", jsonx::JVal::of(0));
  body.set("event", jsonx::JVal::of("homeListFile"));
  jsonx::JVal list = jsonx::JVal::array();
  for (long long id : ids) {
    jsonx::JVal one = jsonx::JVal::object();
    one.set("FileId", jsonx::JVal::of((long long)id));
    list.push(one);
  }
  body.set("fileTrashInfoList", list);
  body.set("operatePlace", jsonx::JVal::of("home"));
  body.set("operation", jsonx::JVal::of(true));
  jsonx::JVal out;
  return call("/api/file/trash", "POST", &body, "", out, err);
}

bool Client::purge(const std::vector<long long>& ids, ApiError& err) {
  jsonx::JVal body = jsonx::JVal::object();
  body.set("RequestSource", jsonx::JVal());
  body.set("driveId", jsonx::JVal::of(0));
  body.set("event", jsonx::JVal::of("recycleRestore"));
  jsonx::JVal list = jsonx::JVal::array();
  for (long long id : ids) {
    jsonx::JVal one = jsonx::JVal::object();
    one.set("FileId", jsonx::JVal::of((long long)id));
    list.push(one);
  }
  body.set("fileTrashInfoList", list);
  body.set("operatePlace", jsonx::JVal::of("trash"));
  body.set("operation", jsonx::JVal::of(true));
  jsonx::JVal out;
  return call("/api/file/trash", "POST", &body, "", out, err);
}

bool Client::rename(long long fileId, const std::string& newName, ApiError& err) {
  jsonx::JVal body = jsonx::JVal::object();
  body.set("driveId", jsonx::JVal::of(0));
  body.set("fileId", jsonx::JVal::of((long long)fileId));
  body.set("fileName", jsonx::JVal::of(newName));
  jsonx::JVal out;
  return call("/api/file/rename", "POST", &body, "", out, err);
}

bool Client::move(const std::vector<long long>& ids, long long toParent, ApiError& err) {
  // 123pan 的 /api/file/mod_pid 要的是：
  //   {"fileIdList":[{"FileId":123}],"parentFileId":456}
  // （不是 fileIds / toParentFileId —— 写错时接口仍返回 code 0，但什么也不做）
  jsonx::JVal body = jsonx::JVal::object();
  jsonx::JVal arr = jsonx::JVal::array();
  for (long long id : ids) {
    jsonx::JVal item = jsonx::JVal::object();
    item.set("FileId", jsonx::JVal::of((long long)id));
    arr.push(item);
  }
  body.set("fileIdList", arr);
  body.set("parentFileId", jsonx::JVal::of((long long)toParent));
  jsonx::JVal out;
  return call("/api/file/mod_pid", "POST", &body, "", out, err);
}

bool Client::refreshToken(ApiError& err) {
  jsonx::JVal out;
  if (!call("/api/user/refresh_token", "GET", nullptr, "", out, err)) return false;
  std::string t = stripBearer(out.strOr("token"));
  if (t.empty()) {
    err.code = -9;
    err.message = "refresh_token returned empty token";
    return false;
  }
  sess_.token = t;
  sess_.expire = out.strOr("expire", sess_.expire);
  return true;
}

}  // namespace pan123
