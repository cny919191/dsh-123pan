// main.cpp - 123pan-core 命令行入口
// 输出协议：stdout 每行一个 JSON 对象（NDJSON）
//   {"type":"progress","fraction":0.42,"stage":"上传 12.0 MB / 30.0 MB"}
//   {"type":"result","ok":true,"data":{...}}
//   {"type":"result","ok":false,"error":{"code":401,"message":"未登录"}}
// 退出码：0 成功，1 业务失败，2 参数错误。
#include <string>
#include <vector>

#include <cstring>

#include "api.hpp"
#include "http.hpp"
#include "json.hpp"
#include "winutil.hpp"

namespace {

struct Args {
  std::vector<std::string> raw;  // 位置参数
  std::vector<std::pair<std::string, std::string>> opts;

  bool has(const std::string& k) const {
    for (auto& kv : opts) if (kv.first == k) return true;
    return false;
  }
  std::string get(const std::string& k, const std::string& d = "") const {
    for (auto& kv : opts) if (kv.first == k) return kv.second;
    return d;
  }
  long long getInt(const std::string& k, long long d = 0) const {
    std::string v = get(k);
    if (v.empty()) return d;
    try { return std::stoll(v); } catch (...) { return d; }
  }
};

// 输出目标：默认 stdout；给了 --ndjson <文件> 时追加写文件。
// 追加写文件是为了适配「不允许管道 stdio」的受限宿主：
// 宿主用 spawn(stdio:'ignore') 起进程，再轮询读这个 NDJSON 文件。
std::string g_outPath;

void emit(const jsonx::JVal& v) {
  std::string s = v.dump();
  s += '\n';
  if (!g_outPath.empty()) {
    FILE* f = _wfopen(winx::widen(g_outPath).c_str(), L"ab");
    if (f) {
      fwrite(s.data(), 1, s.size(), f);
      fclose(f);
      return;
    }
  }
  fwrite(s.data(), 1, s.size(), stdout);
  fflush(stdout);
}

void emitProgress(double frac, const std::string& stage) {
  jsonx::JVal j = jsonx::JVal::object();
  j.set("type", jsonx::JVal::of("progress"));
  j.set("fraction", jsonx::JVal::of(frac < 0 ? 0 : (frac > 1 ? 1 : frac)));
  j.set("stage", jsonx::JVal::of(stage));
  emit(j);
}

void emitOk(jsonx::JVal data) {
  jsonx::JVal j = jsonx::JVal::object();
  j.set("type", jsonx::JVal::of("result"));
  j.set("ok", jsonx::JVal::of(true));
  j.set("data", std::move(data));
  emit(j);
}

void emitErr(const pan123::ApiError& e) {
  jsonx::JVal err = jsonx::JVal::object();
  err.set("code", jsonx::JVal::of((long long)e.code));
  err.set("message", jsonx::JVal::of(e.message));
  if (!e.traceId.empty()) err.set("traceId", jsonx::JVal::of(e.traceId));
  jsonx::JVal j = jsonx::JVal::object();
  j.set("type", jsonx::JVal::of("result"));
  j.set("ok", jsonx::JVal::of(false));
  j.set("error", err);
  emit(j);
}

// 把 123 返回的 InfoList 精简成前端需要的字段
jsonx::JVal simplifyList(const jsonx::JVal& data) {
  jsonx::JVal out = jsonx::JVal::object();
  out.set("next", jsonx::JVal::of(data.strOr("Next", "-1")));
  out.set("total", jsonx::JVal::of((long long)data.intOr("Total")));
  out.set("len", jsonx::JVal::of((long long)data.intOr("Len")));
  jsonx::JVal arr = jsonx::JVal::array();
  const jsonx::JVal* list = data.find("InfoList");
  if (list && list->isArr()) {
    for (auto& it : list->arr) {
      jsonx::JVal one = jsonx::JVal::object();
      one.set("fileId", jsonx::JVal::of((long long)it.intOr("FileId")));
      one.set("name", jsonx::JVal::of(it.strOr("FileName")));
      one.set("type", jsonx::JVal::of((long long)it.intOr("Type")));
      one.set("size", jsonx::JVal::of((long long)it.intOr("Size")));
      one.set("etag", jsonx::JVal::of(it.strOr("Etag")));
      one.set("parentId", jsonx::JVal::of((long long)it.intOr("ParentFileId")));
      one.set("createAt", jsonx::JVal::of(it.strOr("CreateAt")));
      one.set("updateAt", jsonx::JVal::of(it.strOr("UpdateAt")));
      one.set("trashed", jsonx::JVal::of(it.boolOr("Trashed")));
      arr.push(one);
    }
  }
  out.set("items", arr);
  return out;
}

void usage() {
  const char* text =
      "123pan-core - 123 云盘命令行核心（供 dsh-123pan 插件调用）\n"
      "\n"
      "用法: 123pan-core <命令> [参数]\n"
      "\n"
      "命令:\n"
      "  status                              查看登录状态\n"
      "  login --account <账号> --password <密码> [--mail] [--save]\n"
      "  logout                              清除本地登录态\n"
      "  refresh                             刷新 token\n"
      "  list [--parent 0] [--limit 100] [--next <游标>] [--trashed] [--search <关键词>]\n"
      "  mkdir --name <目录名> [--parent 0]\n"
      "  upload --file <本地路径> [--parent 0] [--name <远端名>]\n"
      "  download --id <文件ID> --out <本地路径>\n"
      "  url --id <文件ID>                   取直链\n"
      "  rename --id <文件ID> --name <新名>\n"
      "  move --ids <id,id> --parent <目录ID>\n"
      "  trash --ids <id,id>                 移入回收站\n"
      "  purge --ids <id,id>                 从回收站彻底删除\n"
      "  version                             版本信息\n"
      "\n"
      "输出：stdout 为 NDJSON（progress / result 两种行）。\n";
  fwrite(text, 1, strlen(text), stdout);
}

bool loadSession(pan123::Session& s) {
  // 首选：宿主插件把 token 通过环境变量传进来（会话文件由 Node 侧持有，
  // 这样核心子进程即使处于受限令牌、写不了用户目录，也不影响使用）。
  std::string envToken = winx::getEnvUtf8("DSH_123PAN_TOKEN");
  if (!envToken.empty()) {
    s.token = envToken;
    s.nickname = winx::getEnvUtf8("DSH_123PAN_NICKNAME");
    s.passport = winx::getEnvUtf8("DSH_123PAN_PASSPORT");
    s.expire = winx::getEnvUtf8("DSH_123PAN_EXPIRE");
    std::string uid = winx::getEnvUtf8("DSH_123PAN_UID");
    if (!uid.empty()) {
      try {
        s.uid = std::stoll(uid);
      } catch (...) {
      }
    }
    return true;
  }
  // 兼容：命令行直接使用核心时，仍可读本地会话文件
  pan123::SessionStore store(pan123::SessionStore::defaultPath());
  return store.load(s);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  winx::setupConsoleUtf8();
  std::string netErr;
  if (!netx::globalInit(netErr)) {
    pan123::ApiError e;
    e.code = -100;
    e.message = "network init failed: " + netErr;
    emitErr(e);
    return 1;
  }

  Args a;
  for (int i = 1; i < argc; i++) {
    std::string arg = winx::narrow(argv[i]);
    if (arg.size() > 2 && arg[0] == '-' && arg[1] == '-') {
      std::string key = arg.substr(2);
      std::string val;
      size_t eq = key.find('=');
      if (eq != std::string::npos) {
        val = key.substr(eq + 1);
        key.resize(eq);
      } else if (i + 1 < argc) {
        std::string next = winx::narrow(argv[i + 1]);
        if (!(next.size() > 2 && next[0] == '-' && next[1] == '-')) {
          val = next;
          i++;
        }
      }
      a.opts.emplace_back(key, val);
      if (key == "ndjson" && !val.empty()) g_outPath = val;
    } else {
      a.raw.push_back(arg);
    }
  }

  if (!g_outPath.empty()) {
    // 每次运行前清空，防止残留上一次的结果行
    FILE* f = _wfopen(winx::widen(g_outPath).c_str(), L"wb");
    if (f) fclose(f);
  }

  if (a.raw.empty()) {
    usage();
    return 2;
  }
  const std::string cmd = a.raw[0];

  if (cmd == "version") {
    jsonx::JVal d = jsonx::JVal::object();
    d.set("core", jsonx::JVal::of("123pan-core/1.0.0"));
    d.set("apiVersion", jsonx::JVal::of("3.2.7"));
    emitOk(d);
    return 0;
  }

  // ---- 凭据加解密（供 Node 侧写会话文件用：受限环境里子进程可能写不了目标目录）----
  if (cmd == "protect" || cmd == "unprotect") {
    std::string text = a.get("text");
    if (text.empty()) {
      // 支持从文件读，避免命令行过长
      std::string file = a.get("file");
      if (!file.empty()) {
        std::string raw;
        if (!winx::readFileUtf8(file, raw)) {
          pan123::ApiError e;
          e.code = -1;
          e.message = "无法读取 --file";
          emitErr(e);
          return 2;
        }
        text = raw;
      }
    }
    if (text.empty()) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少 --text 或 --file";
      emitErr(e);
      return 2;
    }
    jsonx::JVal d = jsonx::JVal::object();
    if (cmd == "protect") {
      std::string out = winx::dpapiProtect(text, L"dsh-123pan/session");
      if (out.empty()) {
        pan123::ApiError e;
        e.code = -11;
        e.message = "DPAPI 加密失败";
        emitErr(e);
        return 1;
      }
      d.set("blob", jsonx::JVal::of(out));
    } else {
      std::string out = winx::dpapiUnprotect(text, L"dsh-123pan/session");
      if (out.empty()) {
        pan123::ApiError e;
        e.code = -12;
        e.message = "DPAPI 解密失败（会话文件可能损坏，或换过 Windows 用户）";
        emitErr(e);
        return 1;
      }
      d.set("text", jsonx::JVal::of(out));
    }
    emitOk(d);
    return 0;
  }

  // ---- 登录 ----
  if (cmd == "login") {
    std::string account = a.get("account");
    // 密码优先从环境变量读：命令行参数会出现在进程列表里
    std::string password = a.get("password");
    if (password.empty()) password = winx::getEnvUtf8("DSH_123PAN_PASSWORD");
    if (account.empty() && !a.get("mail").empty()) account = a.get("mail");
    if (account.empty() || password.empty()) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少账号或密码（--account / --password，或用 DSH_123PAN_PASSWORD 环境变量）";
      emitErr(e);
      return 2;
    }
    bool isMail = a.has("mail") || account.find('@') != std::string::npos;
    pan123::Session s;
    pan123::ApiError e;
    if (!pan123::Client::login(account, password, isMail, s, e)) {
      emitErr(e);
      return 1;
    }
    // 补全用户信息
    pan123::Client c(s);
    jsonx::JVal info;
    pan123::ApiError ie;
    if (c.userInfo(info, ie)) {
      s.uid = info.intOr("UID", 0);
      s.nickname = info.strOr("Nickname", account);
    } else {
      s.nickname = account;
    }
    if (a.has("save")) {
      pan123::SessionStore store(pan123::SessionStore::defaultPath());
      std::string serr;
      if (!store.save(s, serr)) {
        pan123::ApiError se;
        se.code = -10;
        se.message = "登录成功但保存失败: " + serr;
        emitErr(se);
        return 1;
      }
    }
    jsonx::JVal d = jsonx::JVal::object();
    d.set("token", jsonx::JVal::of(s.token));
    d.set("expire", jsonx::JVal::of(s.expire));
    d.set("uid", jsonx::JVal::of((long long)s.uid));
    d.set("nickname", jsonx::JVal::of(s.nickname));
    d.set("passport", jsonx::JVal::of(s.passport));
    d.set("saved", jsonx::JVal::of(a.has("save")));
    if (info.isObj()) {
      d.set("spaceUsed", jsonx::JVal::of((long long)info.intOr("SpaceUsed")));
      d.set("spaceTotal", jsonx::JVal::of((long long)info.intOr("SpacePermanentTotal")));
      d.set("vip", jsonx::JVal::of(info.boolOr("Vip")));
    }
    emitOk(d);
    return 0;
  }

  // ---- 登出 ----
  if (cmd == "logout") {
    pan123::SessionStore store(pan123::SessionStore::defaultPath());
    bool cleared = store.clear();
    jsonx::JVal d = jsonx::JVal::object();
    d.set("cleared", jsonx::JVal::of(cleared));
    emitOk(d);
    return 0;
  }

  // 其余命令都需要已保存的会话
  pan123::Session sess;
  if (!loadSession(sess)) {
    pan123::ApiError e;
    e.code = 401;
    e.message = "未登录：请先执行 login --account <账号> --password <密码> --save";
    emitErr(e);
    return 1;
  }
  pan123::Client client(sess);
  pan123::ApiError err;  // 业务错误

  // ---- 状态 ----
  if (cmd == "status") {
    jsonx::JVal info;
    if (!client.userInfo(info, err)) {
      // 401 之类：提示需要重新登录
      emitErr(err);
      return 1;
    }
    // 顺手刷新 token（有效期延长）。会话落盘由 Node 侧负责，
    // 这里只在结果里回传新 token，让宿主决定怎么写。
    client.refreshToken(err);
    jsonx::JVal d = jsonx::JVal::object();
    d.set("loggedIn", jsonx::JVal::of(true));
    d.set("uid", jsonx::JVal::of((long long)info.intOr("UID", sess.uid)));
    d.set("nickname", jsonx::JVal::of(info.strOr("Nickname", sess.nickname)));
    d.set("passport", jsonx::JVal::of(sess.passport));
    d.set("expire", jsonx::JVal::of(client.session().expire));
    d.set("spaceUsed", jsonx::JVal::of((long long)info.intOr("SpaceUsed")));
    d.set("spaceTotal", jsonx::JVal::of((long long)info.intOr("SpacePermanentTotal")));
    d.set("vip", jsonx::JVal::of(info.boolOr("Vip")));
    d.set("sessionFile", jsonx::JVal::of(pan123::SessionStore::defaultPath()));
    d.set("token", jsonx::JVal::of(client.session().token));
    emitOk(d);
    return 0;
  }

  if (cmd == "refresh") {
    if (!client.refreshToken(err)) {
      emitErr(err);
      return 1;
    }
    pan123::SessionStore store(pan123::SessionStore::defaultPath());
    std::string serr;
    store.save(client.session(), serr);
    jsonx::JVal d = jsonx::JVal::object();
    d.set("expire", jsonx::JVal::of(client.session().expire));
    emitOk(d);
    return 0;
  }

  if (cmd == "list") {
    jsonx::JVal data;
    if (!client.listFiles(a.getInt("parent", 0), (int)a.getInt("limit", 100), a.get("next"),
                          a.has("trashed"), a.get("search"), data, err)) {
      emitErr(err);
      return 1;
    }
    emitOk(simplifyList(data));
    return 0;
  }

  if (cmd == "mkdir") {
    std::string name = a.get("name");
    if (name.empty()) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少 --name";
      emitErr(e);
      return 2;
    }
    long long id = 0;
    if (!client.mkdir(a.getInt("parent", 0), name, id, err)) {
      emitErr(err);
      return 1;
    }
    jsonx::JVal d = jsonx::JVal::object();
    d.set("fileId", jsonx::JVal::of((long long)id));
    d.set("name", jsonx::JVal::of(name));
    emitOk(d);
    return 0;
  }

  if (cmd == "upload") {
    std::string file = a.get("file");
    if (file.empty()) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少 --file";
      emitErr(e);
      return 2;
    }
    jsonx::JVal out;
    auto progress = [](double f, const std::string& stage) { emitProgress(f, stage); };
    if (!client.uploadFile(file, a.getInt("parent", 0), a.get("name"), (int)a.getInt("concurrency", 2),
                           progress, out, err)) {
      emitErr(err);
      return 1;
    }
    jsonx::JVal d = jsonx::JVal::object();
    d.set("fileId", jsonx::JVal::of((long long)out.intOr("FileId")));
    d.set("name", jsonx::JVal::of(out.strOr("FileName")));
    d.set("size", jsonx::JVal::of((long long)out.intOr("Size")));
    d.set("etag", jsonx::JVal::of(out.strOr("Etag")));
    d.set("reused", jsonx::JVal::of(out.boolOr("reused")));
    emitOk(d);
    return 0;
  }

  if (cmd == "download") {
    long long id = a.getInt("id", 0);
    std::string outPath = a.get("out");
    if (id == 0 || outPath.empty()) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少 --id 或 --out";
      emitErr(e);
      return 2;
    }
    long long bytes = 0;
    auto progress = [](double f, const std::string& stage) { emitProgress(f, stage); };
    if (!client.downloadFile(id, outPath, progress, bytes, err)) {
      emitErr(err);
      return 1;
    }
    jsonx::JVal d = jsonx::JVal::object();
    d.set("fileId", jsonx::JVal::of((long long)id));
    d.set("path", jsonx::JVal::of(outPath));
    d.set("bytes", jsonx::JVal::of((long long)bytes));
    emitOk(d);
    return 0;
  }

  if (cmd == "url") {
    long long id = a.getInt("id", 0);
    if (id == 0) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少 --id";
      emitErr(e);
      return 2;
    }
    std::string url;
    if (!client.directUrl(id, url, err)) {
      emitErr(err);
      return 1;
    }
    jsonx::JVal d = jsonx::JVal::object();
    d.set("url", jsonx::JVal::of(url));
    emitOk(d);
    return 0;
  }

  if (cmd == "rename") {
    long long id = a.getInt("id", 0);
    std::string name = a.get("name");
    if (id == 0 || name.empty()) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少 --id 或 --name";
      emitErr(e);
      return 2;
    }
    if (!client.rename(id, name, err)) {
      emitErr(err);
      return 1;
    }
    emitOk(jsonx::JVal::object());
    return 0;
  }

  if (cmd == "move") {
    std::vector<long long> ids;
    if (!pan123::parseIds(a.get("ids"), ids)) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少或非法的 --ids";
      emitErr(e);
      return 2;
    }
    if (!client.move(ids, a.getInt("parent", 0), err)) {
      emitErr(err);
      return 1;
    }
    emitOk(jsonx::JVal::object());
    return 0;
  }

  if (cmd == "trash" || cmd == "purge") {
    std::vector<long long> ids;
    if (!pan123::parseIds(a.get("ids"), ids)) {
      pan123::ApiError e;
      e.code = -1;
      e.message = "缺少或非法的 --ids";
      emitErr(e);
      return 2;
    }
    bool ok = (cmd == "trash") ? client.trash(ids, err) : client.purge(ids, err);
    if (!ok) {
      emitErr(err);
      return 1;
    }
    jsonx::JVal d = jsonx::JVal::object();
    d.set("count", jsonx::JVal::of((long long)ids.size()));
    emitOk(d);
    return 0;
  }

  usage();
  return 2;
}
