# 生产环境的 MCP Auth——DCR、JWKS 轮换、在 iii 基元上做受众钉定的 token

> 第 16 课在内存里立起了 OAuth 2.1 状态机。到 2026 年，你交付给真实组织的每个 MCP server 都坐在生产鉴权之后：动态 client 注册（RFC 7591）、authorization-server 元数据发现（RFC 8414）、不会在凌晨三点把 token 校验搞崩的 JWKS 轮换，以及拒绝 confused-deputy 复用的受众钉定 token。本课把这一切都串在 iii 基元上——HTTP 和 cron 用 `iii.registerTrigger`、鉴权逻辑用 `iii.registerFunction`、缓存密钥用 `state::set/get`——这样鉴权表面就和引擎里其他每个工作负载一样可观测、可重启、可重放。

**类型：** Build
**语言：** Python（标准库，iii 基元为课程环境而 mock）
**前置要求：** 阶段 13 · 16（OAuth 2.1 状态机）、阶段 13 · 17（网关）
**预计时间：** ~90 分钟

## 学习目标

- 经由 RFC 8414 元数据发现一个 authorization server，并核实契约。
- 实现 RFC 7591 动态 client 注册，让 MCP client 无需管理员介入就能入册。
- 用一个 cron trigger 缓存并轮换 JWKS 密钥，让签名校验挺过密钥轮转。
- 用 RFC 8707 resource indicator 把 token 钉到单个 MCP resource 上，拒绝 confused-deputy 复用。
- 把每个端点和后台作业都串成 iii 基元——HTTP trigger、cron trigger、具名函数和 `state::*` 读取——这样一次重启就重建整个鉴权表面。
- 读一份 IdP 能力矩阵，当 IdP 满足不了 MCP 的鉴权 profile 时拒绝部署。

## 问题所在

第 16 课的模拟器在内存里跑 OAuth 2.1。生产有三个纯内存模拟器看不到的运维缺口。

第一个缺口是入册。一个真实组织跑着几百个 MCP server 和几千个 MCP client。运维不会把每个 Cursor 用户都手动注册成 OAuth client。RFC 7591 动态 client 注册让一个 client 对 authorization server `POST /register`，当场拿到一个 `client_id`（可选还有 `client_secret`）。server 在它的 RFC 8414 元数据里发布 `registration_endpoint`；client 无需带外配置就能发现它。

第二个缺口是密钥轮换。JWT 校验依赖 authorization server 的签名密钥，以一个 JSON Web Key Set（JWKS）发布。authorization server 按计划轮换它们（常常每小时，事件响应时有时更快）。一个在启动时取一次 JWKS 的 MCP server，在轮换窗口之前都校验正常——然后每个请求都失败，直到重启。生产把 JWKS 串成一个带缓存的值，配一个刷新作业，在上一批密钥过期前覆盖缓存，外加一个缓存未命中时的兜底拉取，应对一个由比缓存更新的密钥签名的 token 到来的情况。

第三个缺口是受众绑定。第 16 课引入了 RFC 8707 resource indicator。在生产里，那个 indicator 变成每个请求上的一道硬性 claim 检查。MCP server 把 `token.aud` 和自己的规范 resource URL 对比，不匹配就用 HTTP 401 拒绝。这是唯一一道防御，挡住一个上游 MCP server（或一个持有本属于某 server 的 token 的恶意 client）把那个 token 重放给同一信任网格里另一个 server。

本课把这每一个缺口都当作一个 iii 基元来处理。元数据文档是一个返回某函数输出的 HTTP trigger。JWKS 轮换是一个调 `auth::rotate-jwks` 的 cron trigger，后者写入 `state::set("auth/jwks/<issuer>", ...)`。JWT 校验是一个别人经由 `iii.trigger("auth::validate-jwt", token)` 调用的函数。MCP server 本身只是另一个 HTTP trigger，它在分发前调进校验。重启引擎：trigger 注册表重建；state 存活；鉴权表面无需人工对账就处于可运营状态。

## 核心概念

### RFC 8414——OAuth Authorization Server Metadata

`/.well-known/oauth-authorization-server` 上的一份文档描述了 client 需要的一切：

```json
{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "https://auth.example.com/authorize",
  "token_endpoint": "https://auth.example.com/token",
  "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
  "registration_endpoint": "https://auth.example.com/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp:tools.read", "mcp:tools.invoke"],
  "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"]
}
```

拿到一个 MCP resource URL 的 client 串起发现链：来自 RFC 9728 的 `oauth-protected-resource`（resource server 的文档）点名 issuer，然后 `oauth-authorization-server`（本 RFC）点名每个端点。client 从不硬编码一个 authorization URL。

在为 MCP 信任一个 IdP 之前你要核实的契约：

- `code_challenge_methods_supported` 含 `S256`（按 RFC 7636 的 PKCE）。
- `grant_types_supported` 含 `authorization_code`，且拒绝 `password` 和 `implicit`。
- `registration_endpoint` 存在（RFC 7591 支持）。
- 对 OAuth 2.1，`response_types_supported` 恰好是 `["code"]`。

如果其中任何一个缺失，MCP server 拒绝对这个 IdP 部署。错的是部署清单，不是代码。

### RFC 9728（回顾）——Protected Resource Metadata

第 16 课讲过 RFC 9728。生产里的增量：这份文档是 client 唯一会去查、以找到*这个* MCP server 信任的 authorization server 的地方。单个 MCP server 可以接受来自多个 IdP 的 token（一个给员工，一个给合作伙伴）。RFC 9728 声明那个集合；RFC 8414 记录每个 IdP 支持什么。

```json
{
  "resource": "https://notes.example.com",
  "authorization_servers": ["https://auth.example.com", "https://partners.example.com"],
  "scopes_supported": ["mcp:tools.invoke"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://notes.example.com/docs"
}
```

### RFC 7591——动态 Client 注册

没有 DCR，每个 MCP client（Cursor、Claude Desktop、一个自定义 agent）都需要和 IdP 管理员做一次带外交换。有了 DCR，client 发：

```json
POST /register
Content-Type: application/json

{
  "redirect_uris": ["http://127.0.0.1:7333/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "mcp:tools.invoke",
  "client_name": "Cursor",
  "software_id": "com.cursor.cursor",
  "software_version": "0.42.0"
}
```

server 用一个 `client_id` 和一个供日后更新用的 `registration_access_token` 响应：

```json
{
  "client_id": "c_3e7f1a",
  "client_id_issued_at": 1769472000,
  "redirect_uris": ["http://127.0.0.1:7333/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "registration_access_token": "regt_b2...",
  "registration_client_uri": "https://auth.example.com/register/c_3e7f1a"
}
```

`token_endpoint_auth_method: none` 是跑在用户设备上的 MCP client 的正确默认。它们只拿一个 `client_id`——没有 `client_secret` 可被外泄。PKCE 提供了 public client 所需的持有证明。

三个生产坑：

- 注册端点必须按来源 IP 限流。没有它，一个恶意行为者用脚本搞出几百万个假注册，把 `client_id` 命名空间耗尽。iii 让这变得简单：注册 HTTP trigger 在分发给 registrar 前先调一个 `auth::rate-limit` 函数。
- 某些企业 IdP 要求 `software_statement`（一个为 client 担保的签名 JWT）。本课的 mock 跳过它；生产串一道校验步骤，拒绝来自 localhost redirect URI 之外任何来源的未签名注册。
- `registration_access_token` 必须以哈希存储，不是明文。偷到这个 token 意味着攻击者能重写 client 的 redirect URI。

### RFC 8707（回顾）——Resource Indicator

第 16 课立起了形状。生产规则：每个 token 请求都含 `resource=<canonical-mcp-url>`，且 MCP server 在每个调用上核实 `token.aud` 匹配自己的 resource URL。如果 MCP server 在 `https://notes.example.com/mcp` 可达，规范 URL 就是 `https://notes.example.com`——path 部分被排除，这样单个 server 在一个受众下托管多条 path。

### RFC 7636（回顾）——PKCE

PKCE 在 OAuth 2.1 里是强制的。本课的授权码流程始终携带 `code_challenge` 和 `code_verifier`。server 拒绝任何不带 verifier、或 verifier 哈希对不上存好的 challenge 的 token 请求。

### MCP 规范 2025-11-25 鉴权 Profile

MCP 规范（2025-11-25）对一个 MCP server 的授权层必须做什么很精确：

- 发布 `/.well-known/oauth-protected-resource`（RFC 9728）。
- 只经由 `Authorization: Bearer ...` 接受 token。
- 每个请求校验 `aud`、`iss`、`exp` 和必需的 scope。
- 对每个 401 和 403 用携带 `Bearer error=...` 的 `WWW-Authenticate` 响应，适用时含 `scope=` 和 `resource=` 参数。
- 拒绝 `aud` 不匹配规范 resource 的 token。
- 拒绝 `iss` 不在受保护资源元数据的 `authorization_servers` 列表里的 token。

OAuth 2.1 草案是底料；RFC 8414/7591/8707/9728 + RFC 7636 是表面；MCP 规范是 profile。

### IdP 能力矩阵

不是每个 IdP 都支持完整的 MCP profile。下表记录截至 2025-11-25 规范的事实性能力陈述。它是一道*部署门槛*，不是推荐。

| IdP 类别 | RFC 8414 元数据 | RFC 7591 DCR | RFC 8707 resource | RFC 7636 S256 PKCE | 备注 |
|---|---|---|---|---|---|
| 自托管（Keycloak） | 是 | 是 | 是（自 24.x 起） | 是 | 本课 MCP profile 的参考 IdP；端到端支持每个 RFC。 |
| 企业 SSO（Microsoft Entra ID） | 是 | 是（高级档） | 是 | 是 | DCR 可用性因租户档而异；部署前在目标租户里核实。 |
| 企业 SSO（Okta） | 是 | 是（Okta CIC / Auth0） | 是 | 是 | DCR 在 Auth0（现 Okta CIC）上可用；经典 Okta 组织需要管理员预注册。 |
| 社交登录 IdP（通用） | 不一 | 罕见 | 罕见 | 是 | 多数社交 IdP 把 client 当静态合作伙伴；别指望 DCR。只当身份源用，在上面叠你自己的 MCP 感知 authorization server。 |
| 自研 / 土法 | 看情况 | 看情况 | 看情况 | 看情况 | 如果你自己交付，就交付完整 profile。上面四个 RFC 跳掉任何一个都会破坏 MCP 鉴权契约。 |

部署清单的拒绝规则：如果所选 IdP 不返回 `registration_endpoint` 且不在 `code_challenge_methods_supported` 里列 `S256`，MCP server 拒绝启动。没有降级模式。

### 用 iii 做 JWKS 轮换模式

生产里的失败模式是陈旧的 JWKS 缓存。用一个 cron trigger 和一个 `state::*` 缓存来解决：

```python
iii.registerTrigger(
    "cron",
    {"schedule": "0 */6 * * *", "name": "auth::jwks-refresh"},
    "auth::rotate-jwks",
)
```

每六小时，cron trigger 调 `auth::rotate-jwks`，它拉取 `<issuer>/.well-known/jwks.json` 并写入 `state::set("auth/jwks/<issuer>", {keys, fetched_at})`。校验器从 `state::get` 读。一个 `kid` 在缓存里缺失的 token 会触发一次同步的 `auth::rotate-jwks` 调用作为兜底。这一下处理两种情况：计划轮换（cron）和密钥重叠窗口（同步兜底）。

state 形状：

```json
{
  "auth/jwks/https://auth.example.com": {
    "keys": [
      {"kid": "k_2026_03", "kty": "RSA", "n": "...", "e": "AQAB", "alg": "RS256", "use": "sig"},
      {"kid": "k_2026_04", "kty": "RSA", "n": "...", "e": "AQAB", "alg": "RS256", "use": "sig"}
    ],
    "fetched_at": 1772668800
  }
}
```

同时两把密钥是稳态。authorization server 通过在退役上一把（`k_2026_03`）之前引入下一把（`k_2026_04`）来轮换，这样旧密钥签发的 token 在过期前仍有效。缓存持有并集；校验器按 `kid` 挑。

### iii 基元的串接（本课真正讲的那部分）

五个基元组成鉴权表面：

```python
# 1. RFC 8414 元数据文档
iii.registerTrigger(
    "http",
    {"path": "/.well-known/oauth-authorization-server", "method": "GET"},
    "auth::serve-asm",
)

# 2. RFC 7591 动态 client 注册
iii.registerTrigger(
    "http",
    {"path": "/register", "method": "POST"},
    "auth::register-client",
)

# 3. JWT 校验作为一个可调用函数（resource server 触发它）
iii.registerFunction("auth::validate-jwt", validate_jwt_handler)

# 4. 增量 scope 的 step-up 签发（来自 L16 的 SEP-835）
iii.registerFunction("auth::issue-step-up", issue_step_up_handler)

# 5. cron 驱动的 JWKS 轮换
iii.registerTrigger(
    "cron",
    {"schedule": "0 */6 * * *"},
    "auth::rotate-jwks",
)
iii.registerFunction("auth::rotate-jwks", rotate_jwks_handler)
```

MCP server 本身从不直接调校验。它做：

```python
result = iii.trigger("auth::validate-jwt", {"token": bearer_token, "resource": self.resource})
if not result["valid"]:
    return {"status": 401, "WWW-Authenticate": result["www_authenticate"]}
```

这层间接就是 iii 的赌注。明天你把校验器换成一个并行咨询两个 IdP 的扇出，或加一个 span 发射器，或缓存正向校验。MCP server 不变。

### 带受众绑定的 confused-deputy 走查

Server A（`notes.example.com`）和 Server B（`tasks.example.com`）都对同一个 authorization server 注册。Server A 被攻陷。攻击者拿到一个用户的 notes token，把它重放给 Server B。

Server B 的校验器：

1. 解码 JWT，按 `kid` 取 JWKS，验签名。
2. 把 `iss` 和它的受保护资源元数据的 `authorization_servers` 对比。（通过——同一个 IdP。）
3. 检查 `aud == "https://tasks.example.com"`。（失败——token 的 `aud` 是 `https://notes.example.com`。）
4. 返回 401，带 `WWW-Authenticate: Bearer error="invalid_token", error_description="audience mismatch"`。

受众 claim 是协议层唯一一道挡住这种攻击的防御。为性能而跳过它是最常见的生产错误；校验器必须在每个请求上跑，而不只是会话开始时。

### 失败模式

- **陈旧 JWKS。** 校验器在密钥轮换后拒绝合法 token。修法是上面的 cron+兜底模式。绝不要在没有刷新作业的情况下缓存 JWKS。
- **缺 `aud` claim。** 某些 IdP 默认省略 `aud`，除非 token 请求里有 `resource`。校验器必须拒绝缺 `aud` 的 token，而不是把缺失当通配符。
- **scope 升级竞态。** 同一用户的两个并发 step-up 流程可能都成功，产出两个不同 scope 的 access token。校验器必须用请求上出示的 token，而非查"用户当前的 scope"——那会造出一个 TOCTOU 窗口。
- **注册 token 失窃。** 一个泄漏的 `registration_access_token` 让攻击者能重写 redirect URI。把这些在静态时哈希；要求 client 在每次更新时出示明文；有嫌疑就轮换。
- **`iss` 未钉定。** 一个接受任意 `iss` 的校验器，让攻击者能立起自己的 authorization server、为目标受众注册一个 client、并签发 token。受保护资源元数据的 `authorization_servers` 列表就是白名单；强制它。

## 上手使用

`code/main.py` 用标准库 Python 和一个模仿 `iii.registerFunction`、`iii.registerTrigger`、`iii.trigger` 和 `state::set/get` 的小 `iii_mock` 注册表走完整的生产流程。流程：

1. authorization server 在 `/.well-known/oauth-authorization-server` 发布 RFC 8414 元数据。
2. MCP client 调元数据端点，发现注册端点。
3. MCP client 向 `/register`（RFC 7591）发请求，收到一个 `client_id`。
4. MCP client 跑 PKCE 保护的授权码流程（RFC 7636），带 `resource` indicator（RFC 8707）。
5. MCP client 带 `Authorization: Bearer ...` 调 MCP server 上的一个工具。
6. MCP server 触发 `auth::validate-jwt`，它从 `state::get` 读 JWKS。
7. cron trigger 触发 `auth::rotate-jwks`，替换 state 里的 JWKS。
8. 下一个调用无需重启就对新密钥校验。
9. 一次针对不同 MCP resource 的 confused-deputy 尝试，因受众不匹配拿到 401。

这里的 mock JWT 用带共享密钥的 HS256（这样本课只靠标准库就能跑）。生产用 RS256 或 EdDSA 配上面的 JWKS 模式；校验逻辑在别处是一样的。

## 交付

本课产出 `outputs/skill-mcp-auth-iii.md`。给定一份 MCP server 配置和一个 IdP 能力集，这个 skill 发出要注册的 iii 基元、JWKS 轮换计划、scope 映射，以及当 IdP 不支持完整 RFC profile 时要应用的拒绝规则。

## 练习

1. 跑 `code/main.py`。追踪那 9 步流程。注意 `state::get` 在 `auth::rotate-jwks` 覆盖它之前那一刻返回陈旧数据的地方，以及下一个请求现在如何对新密钥校验。

2. 给受保护资源元数据的 `authorization_servers` 列表加一个新 IdP。签发一个由新 IdP 签名的 token，确认校验器接受它。签发一个由未列出 IdP 签名的 token，确认校验器以 `WWW-Authenticate: Bearer error="invalid_token", error_description="iss not allowed"` 拒绝。

3. 把 `auth::rate-limit` 实现为一个 iii 函数，在 registrar 跑之前从注册 HTTP trigger 里调它。用一个按来源 IP、存在 `state::set("auth/ratelimit/<ip>", ...)` 里的 token-bucket。

4. 读 RFC 7591，找出本课 `/register` 处理器没校验的两个字段。把校验加上。（提示：`software_statement` 和 `redirect_uris` 的 URI scheme。）

5. 读 MCP 规范 2025-11-25 的授权章节。找出本课校验器目前没发出的、关于 `WWW-Authenticate` 头的那条规范性要求。把它加上。

## 关键术语

| 术语 | 大家嘴上怎么说 | 它实际是什么 |
|------|----------------|------------------------|
| ASM | "OAuth 元数据文档" | RFC 8414 的 `/.well-known/oauth-authorization-server` JSON |
| DCR | "自助 client 注册" | RFC 7591 的 `POST /register` 流程 |
| JWKS | "JWT 校验用的公钥" | JSON Web Key Set，从 `jwks_uri` 取，按 `kid` 索引 |
| Resource indicator | "受众参数" | 把 token 钉到一个 server 的 RFC 8707 `resource` 参数 |
| `aud` claim | "受众" | 校验器拿来和规范 resource URL 对比的 JWT claim |
| Confused deputy | "token 重放" | 为 Server A 签发的 token 被出示给 Server B 的攻击 |
| `iss` allow-list | "受信 authorization server" | 受保护资源元数据的 `authorization_servers` 里点名的集合 |
| Key rotation | "滚动 JWKS" | 带重叠窗口的签名密钥定期替换 |
| Public client | "原生或浏览器 client" | 无 `client_secret` 的 OAuth client；PKCE 补偿 |
| `WWW-Authenticate` | "401/403 响应头" | 携带驱动 client 恢复的 `Bearer error=...` 指令 |

## 延伸阅读

- [MCP — Authorization spec (2025-11-25)](https://modelcontextprotocol.io/specification/draft/basic/authorization) — 本课实现的 MCP 鉴权 profile
- [RFC 8414 — OAuth 2.0 Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414) — 发现契约
- [RFC 7591 — OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591) — DCR
- [RFC 7636 — Proof Key for Code Exchange (PKCE)](https://datatracker.ietf.org/doc/html/rfc7636) — public client 的持有证明
- [RFC 8707 — Resource Indicators for OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc8707) — 受众钉定
- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) — resource server 发现
- [OAuth 2.1 draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) — 整合的 OAuth 底料
