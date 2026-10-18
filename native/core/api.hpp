// api.hpp - 123 云盘 API 客户端（内部 REST，Bearer JWT）
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "json.hpp"

namespace pan123 {

struct ApiError {
  int code = 0;
  std::string message;
  std::string traceId;
  bool ok() const { return code == 0; }
};

struct Session {
  std::string token;    // 纯 JWT，不含 "Bearer "
  std::string expire;   // ISO8601
  long long uid = 0;
  std::string nickname;
  std::string passport;
};

// 会话存储：DPAPI 加密后落盘。路径为空则用默认位置。
class SessionStore {
 public:
  explicit SessionStore(std::string path) : path_(std::move(path)) {}
  static std::string defaultPath();
  bool save(const Session& s, std::string& err);
  bool load(Session& s);
  bool clear();
  const std::string& path() const { return path_; }

 private:
  std::string path_;
};

using ProgressFn = std::function<void(double fraction, const std::string& stage)>;

class Client {
 public:
  explicit Client(Session sess) : sess_(std::move(sess)) {}
  const Session& session() const { return sess_; }
  Session& session() { return sess_; }

  // 底层调用；成功时 out 为 data 节点
  bool call(const std::string& path, const std::string& method, const jsonx::JVal* body,
            const std::string& query, jsonx::JVal& out, ApiError& err);

  // 登录（手机号/邮箱 + 密码）。成功后填充 sess_。
  static bool login(const std::string& account, const std::string& password, bool isMail, Session& out,
                    ApiError& err);

  bool userInfo(jsonx::JVal& out, ApiError& err);
  bool listFiles(long long parentId, int limit, const std::string& next, bool trashed,
                 const std::string& search, jsonx::JVal& out, ApiError& err);
  bool mkdir(long long parentId, const std::string& name, long long& newId, ApiError& err);
  bool uploadFile(const std::string& localPath, long long parentId, const std::string& remoteName,
                  int concurrency, const ProgressFn& progress, jsonx::JVal& out, ApiError& err);
  bool downloadFile(long long fileId, const std::string& outPath, const ProgressFn& progress,
                    long long& bytes, ApiError& err);
  bool trash(const std::vector<long long>& ids, ApiError& err);
  bool purge(const std::vector<long long>& ids, ApiError& err);
  bool rename(long long fileId, const std::string& newName, ApiError& err);
  bool move(const std::vector<long long>& ids, long long toParent, ApiError& err);
  bool directUrl(long long fileId, std::string& url, ApiError& err);
  bool refreshToken(ApiError& err);

 private:
  Session sess_;
};

// 工具
std::string formatBytes(long long n);
bool parseIds(const std::string& csv, std::vector<long long>& out);

}  // namespace pan123
