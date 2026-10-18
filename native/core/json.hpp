// json.hpp - 极简 JSON（解析 / 构造 / 序列化），供 123pan-core 使用
// 只依赖 C++17 标准库；字符串一律 UTF-8。
#pragma once

#include <cstdint>
#include <cstdio>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace jsonx {

struct JVal {
  enum Type { Nul, Bool, Num, Str, Arr, Obj };
  Type type = Nul;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<JVal> arr;
  std::vector<std::pair<std::string, JVal>> obj;

  JVal() = default;
  static JVal null() { return JVal(); }
  static JVal of(bool v) { JVal j; j.type = Bool; j.b = v; return j; }
  static JVal of(double v) { JVal j; j.type = Num; j.num = v; return j; }
  static JVal of(int v) { return of((double)v); }
  static JVal of(long long v) { return of((double)v); }
  static JVal of(unsigned long long v) { return of((double)v); }
  static JVal of(const std::string& v) { JVal j; j.type = Str; j.str = v; return j; }
  static JVal of(const char* v) { return of(std::string(v ? v : "")); }
  static JVal array() { JVal j; j.type = Arr; return j; }
  static JVal object() { JVal j; j.type = Obj; return j; }

  bool isNull() const { return type == Nul; }
  bool isObj() const { return type == Obj; }
  bool isArr() const { return type == Arr; }
  bool isStr() const { return type == Str; }
  bool isNum() const { return type == Num; }
  bool isBool() const { return type == Bool; }

  // ---- 对象访问 ----
  const JVal* find(const std::string& k) const {
    if (type != Obj) return nullptr;
    for (auto& kv : obj) if (kv.first == k) return &kv.second;
    return nullptr;
  }
  JVal* find(const std::string& k) {
    if (type != Obj) return nullptr;
    for (auto& kv : obj) if (kv.first == k) return &kv.second;
    return nullptr;
  }
  JVal& set(const std::string& k, JVal v) {
    if (type != Obj) { type = Obj; }
    for (auto& kv : obj) if (kv.first == k) { kv.second = std::move(v); return kv.second; }
    obj.emplace_back(k, std::move(v));
    return obj.back().second;
  }
  JVal& operator[](const std::string& k) {
    if (type != Obj) { type = Obj; obj.clear(); }
    for (auto& kv : obj) if (kv.first == k) return kv.second;
    obj.emplace_back(k, JVal());
    return obj.back().second;
  }
  JVal& push(JVal v) {
    if (type != Arr) { type = Arr; arr.clear(); }
    arr.push_back(std::move(v));
    return arr.back();
  }

  // ---- 带默认值的取值 ----
  std::string strOr(const std::string& k, const std::string& d = "") const {
    const JVal* v = find(k);
    return (v && v->type == Str) ? v->str : d;
  }
  double numOr(const std::string& k, double d = 0) const {
    const JVal* v = find(k);
    if (!v) return d;
    if (v->type == Num) return v->num;
    if (v->type == Str) { try { return std::stod(v->str); } catch (...) { return d; } }
    if (v->type == Bool) return v->b ? 1 : 0;
    return d;
  }
  long long intOr(const std::string& k, long long d = 0) const {
    double v = numOr(k, (double)d);
    if (!std::isfinite(v)) return d;
    return (long long)llround(v);
  }
  bool boolOr(const std::string& k, bool d = false) const {
    const JVal* v = find(k);
    if (!v) return d;
    if (v->type == Bool) return v->b;
    if (v->type == Num) return v->num != 0;
    if (v->type == Str) return v->str == "true" || v->str == "1";
    return d;
  }

  std::string dump() const {
    std::string out;
    out.reserve(256);
    writeTo(out);
    return out;
  }

  void writeTo(std::string& out) const {
    switch (type) {
      case Nul: out += "null"; break;
      case Bool: out += (b ? "true" : "false"); break;
      case Num: writeNum(out, num); break;
      case Str: writeStr(out, str); break;
      case Arr: {
        out += '[';
        for (size_t i = 0; i < arr.size(); i++) { if (i) out += ','; arr[i].writeTo(out); }
        out += ']';
        break;
      }
      case Obj: {
        out += '{';
        for (size_t i = 0; i < obj.size(); i++) {
          if (i) out += ',';
          writeStr(out, obj[i].first);
          out += ':';
          obj[i].second.writeTo(out);
        }
        out += '}';
        break;
      }
    }
  }

  static void writeNum(std::string& out, double v) {
    if (!std::isfinite(v)) { out += "null"; return; }
    if (v == (double)(long long)v && std::fabs(v) < 9.0e15) {
      char buf[32];
      snprintf(buf, sizeof(buf), "%lld", (long long)v);
      out += buf;
    } else {
      char buf[40];
      snprintf(buf, sizeof(buf), "%.17g", v);
      out += buf;
    }
  }

  static void writeStr(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
          if (c < 0x20) {
            char buf[8];
            snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
          } else {
            out += (char)c;  // UTF-8 原样输出
          }
      }
    }
    out += '"';
  }
};

// ---- 解析 ----
class Parser {
 public:
  explicit Parser(const std::string& s) : s_(s) {}

  bool parse(JVal& out) {
    skipWs();
    if (!parseValue(out)) return false;
    skipWs();
    return i_ >= s_.size();
  }

 private:
  const std::string& s_;
  size_t i_ = 0;

  void skipWs() {
    while (i_ < s_.size()) {
      char c = s_[i_];
      if (c == ' ' || c == '\t' || c == '\r' || c == '\n') i_++;
      else break;
    }
  }
  bool eat(char c) {
    if (i_ < s_.size() && s_[i_] == c) { i_++; return true; }
    return false;
  }
  bool literal(const char* lit) {
    size_t n = strlen_(lit);
    if (s_.compare(i_, n, lit) == 0) { i_ += n; return true; }
    return false;
  }
  static size_t strlen_(const char* p) { size_t n = 0; while (p[n]) n++; return n; }

  bool parseValue(JVal& out) {
    skipWs();
    if (i_ >= s_.size()) return false;
    char c = s_[i_];
    if (c == '{') return parseObj(out);
    if (c == '[') return parseArr(out);
    if (c == '"') { out.type = JVal::Str; return parseString(out.str); }
    if (c == 't') { if (!literal("true")) return false; out = JVal::of(true); return true; }
    if (c == 'f') { if (!literal("false")) return false; out = JVal::of(false); return true; }
    if (c == 'n') { if (!literal("null")) return false; out = JVal(); return true; }
    return parseNum(out);
  }

  bool parseObj(JVal& out) {
    out = JVal::object();
    if (!eat('{')) return false;
    skipWs();
    if (eat('}')) return true;
    while (true) {
      skipWs();
      std::string key;
      if (!parseString(key)) return false;
      skipWs();
      if (!eat(':')) return false;
      JVal v;
      if (!parseValue(v)) return false;
      out.obj.emplace_back(std::move(key), std::move(v));
      skipWs();
      if (eat(',')) continue;
      if (eat('}')) return true;
      return false;
    }
  }

  bool parseArr(JVal& out) {
    out = JVal::array();
    if (!eat('[')) return false;
    skipWs();
    if (eat(']')) return true;
    while (true) {
      JVal v;
      if (!parseValue(v)) return false;
      out.arr.push_back(std::move(v));
      skipWs();
      if (eat(',')) continue;
      if (eat(']')) return true;
      return false;
    }
  }

  static void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) {
      out += (char)(0xC0 | (cp >> 6));
      out += (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += (char)(0xE0 | (cp >> 12));
      out += (char)(0x80 | ((cp >> 6) & 0x3F));
      out += (char)(0x80 | (cp & 0x3F));
    } else {
      out += (char)(0xF0 | (cp >> 18));
      out += (char)(0x80 | ((cp >> 12) & 0x3F));
      out += (char)(0x80 | ((cp >> 6) & 0x3F));
      out += (char)(0x80 | (cp & 0x3F));
    }
  }

  bool parseHex4(unsigned& v) {
    if (i_ + 4 > s_.size()) return false;
    v = 0;
    for (int k = 0; k < 4; k++) {
      char c = s_[i_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
      else return false;
    }
    return true;
  }

  bool parseString(std::string& out) {
    if (!eat('"')) return false;
    out.clear();
    while (i_ < s_.size()) {
      unsigned char c = (unsigned char)s_[i_++];
      if (c == '"') return true;
      if (c != '\\') { out += (char)c; continue; }
      if (i_ >= s_.size()) return false;
      char e = s_[i_++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned cp = 0;
          if (!parseHex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
            size_t save = i_;
            i_ += 2;
            unsigned lo = 0;
            if (parseHex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            } else {
              i_ = save;
            }
          }
          appendUtf8(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }

  bool parseNum(JVal& out) {
    size_t start = i_;
    if (i_ < s_.size() && (s_[i_] == '-' || s_[i_] == '+')) i_++;
    bool any = false;
    while (i_ < s_.size() && (isdigit((unsigned char)s_[i_]) || s_[i_] == '.' || s_[i_] == 'e' || s_[i_] == 'E' ||
                              s_[i_] == '-' || s_[i_] == '+')) {
      i_++;
      any = true;
    }
    if (!any) return false;
    try {
      out = JVal::of(std::stod(s_.substr(start, i_ - start)));
      return true;
    } catch (...) {
      return false;
    }
  }
};

inline bool parse(const std::string& text, JVal& out) {
  Parser p(text);
  return p.parse(out);
}

}  // namespace jsonx
