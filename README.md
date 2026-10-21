# dsh-public-access（`@laoer/dsh-public-access`）

DeepSeek Harness 公网 / 局域网访问插件 — 支持 `0.0.0.0` 绑定、`--public-url` / TLS、nginx，以及用户名密码登录认证。

> **包名**：`@laoer/dsh-public-access`（fork 自 JNan-QQ/dsh-public-access）。
>
> **兼容性**：2.1.0 适配 **dsh 0.2.1-rc.2**（`>=0.2.1-rc.2 <0.3.0`）。dsh 0.1.x 请继续使用 1.3.0。

## 📖 简介

`@laoer/dsh-public-access` 是一个 DeepSeek Harness 插件，用于将本地开发环境暴露到公网或局域网，同时提供安全的登录认证机制。该插件解决了以下核心问题：

- **网络绑定**：dsh 0.2.1 在 CLI 和 `webserver` 配置 schema 两处都拒绝通配地址；插件在 boot 路径上就地放宽 `WebServer.Config.host`，重新允许 `0.0.0.0` / `::`
- **安全认证**：在 dsh 原生启动令牌 / 签名 Cookie 之上叠加用户名密码登录，插件会话 24 小时有效
- **鉴权接入**：0.2.1 的 `/api` 走 `connection.admit` 而不是 `requestRejection`，插件把会话接入 `admit` 与 `authorizeIndex`
- **前端兼容**：注入 `__DSH_TRANSPORT__.ownsHost` 与 `crypto.randomUUID` polyfill，保证非回环、明文 HTTP 访问下设置持久化与 RPC 正常

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌐 **全接口绑定** | 自定义 `web-startup` + 就地放宽 boot 路径的 webserver `host` schema，解除 dsh 0.2.1 对 `0.0.0.0` / `::` 的限制 |
| 🔐 **登录认证** | 在 dsh 0.2.1 原生浏览器鉴权之上叠加用户名/密码登录，`dsh_session` 24 小时有效（两种鉴权并存） |
| 🛡️ **信任栅栏** | 保留 dsh 的 Host/Origin 栅栏；`--trusted-host` 声明公网 IP/域名，LAN 地址由插件自动推导 |
| 🖥️ **前端兼容** | 注入 `__DSH_TRANSPORT__.ownsHost`，使公网访问获得回环级 `isLoopback` 状态 |
| 🔒 **crypto polyfill** | 公网 HTTP 环境补齐 `crypto.randomUUID`，优先使用 `getRandomValues` |
| 🚀 **自动检测** | `start.sh` 自动探测公网 IP 并配置 trusted-host / public-url；LAN 地址由 `web-startup` 按网卡推导 |
| 🧹 **可撤销登出** | 登出同时清除 `dsh_session` 与请求中所有 `dsh-auth-*` 原生 Cookie |

## ⬆️ 从 1.3.0 / 2.0.0 升级到 2.1.0

0.1.x → 0.2.1 的上游鉴权入口和行为都变了，2.0.0 是 breaking release；2.1.0 同时把包名从 `dsh-public-access` 改为 **`@laoer/dsh-public-access`**，因此需要先移除旧包再安装新包：

1. 先把 dsh 升级到 `0.2.1-rc.2`；
2. 移除旧包：`dsh plugin --profile web remove dsh-public-access`；
3. 安装新包：`dsh plugin --profile web add @laoer/dsh-public-access@2.1.0`（未发布 npm 时用 `github:laoer/dsh-public-access` 或本地路径）；
4. 重启 `dsh --profile web`；
5. 确认启动日志没有 `webserver: ... wildcard ...`，并访问 `/` 检查是否跳转 `/_auth/login`；
6. 已签发的 `dsh_session` 仍有效，通常不需要重新登录。

如果仍在使用 dsh 0.1.x，请继续使用插件 1.3.0，不要升级到 2.x。

## 📦 安装

### 方式一：通过 DSH 插件管理器安装（推荐）

```bash
# 已发布到 npm 时
dsh plugin --profile web add @laoer/dsh-public-access@2.1.0

# 未发布 npm 时，从 GitHub 仓库安装（pnpm 读取仓库里的 package.json）
dsh plugin --profile web add github:laoer/dsh-public-access

# 固定 commit，便于复现
dsh plugin --profile web add 'github:laoer/dsh-public-access#<commit>'
```

### 方式二：手动安装 / 本地开发

```bash
# 克隆仓库
git clone https://github.com/laoer/dsh-public-access.git
cd dsh-public-access

# 安装依赖
pnpm install

# 以 link: 方式装进 web profile（推荐；插件会从 profile 根解析
# @deepseek-ai/dsh-host-webserver，避免命中第二份模块实例）
dsh plugin --profile web add .
```

> 从旧包升级时，务必先 `dsh plugin --profile web remove dsh-public-access`；新旧包名不同，直接 add 会留下旧 bundle。
>
> 不要用 `npm link` 直接全局链接后期待它自动解析 dsh 内部包；dsh 的 runtime resolution 以 profile 根为锚点，`dsh plugin add .` 才是受支持的开发安装方式。

## 🚀 使用方法

### 快速启动

```bash
# 使用默认账号 admin/admin（仅建议本机/可信内网）
./start.sh

# 直接使用 dsh 命令（等价于 start.sh 的核心参数）
dsh --profile web --no-open --host 0.0.0.0 --port 3080
```

启动后浏览器访问 `http://<主机IP>:3080/`，首次会跳转 `/_auth/login`。局域网地址由插件按网卡自动加入 trustedHosts；公网 IP / 域名请通过 `--trusted-host` 或 `DSH_TRUSTED_HOSTS` 声明。

### 自定义配置启动

```bash
# 自定义账号密码
DSH_AUTH_USER=myuser DSH_AUTH_PASS=mypassword ./start.sh

# 自定义绑定地址 / 端口
DSH_HOST=0.0.0.0 DSH_PORT=8080 ./start.sh

# 广告一个公网域名或前缀代理地址（同时用于启动日志、DSH_WEB_URL、Agent 上下文）
DSH_PUBLIC_URL=https://app.example/ui/ ./start.sh

# dsh 直接终止 TLS（而不是由 nginx 终止）
DSH_TLS_CERT=/etc/ssl/app-chain.pem DSH_TLS_KEY=/etc/ssl/app-key.pem ./start.sh

# 追加可信 authority（空格分隔多个）
DSH_TRUSTED_HOSTS="app.example 203.0.113.10" ./start.sh
```

### 生产环境部署（推荐：nginx 终止 TLS）

推荐让 dsh 只监听 loopback，由 nginx 做 TLS 与公网入口；这样不需要放宽通配绑定，攻击面更小：

```bash
dsh --profile web --host 127.0.0.1 --port 3080 \
  --public-url https://app.example/ --trusted-host app.example
```

只有确实需要“本机所有网卡直连”时才使用 `--host 0.0.0.0`（或 `::`）。

### systemd 示例

```bash
sudo tee /etc/systemd/system/dsh.service <<EOF
[Unit]
Description=DeepSeek Harness with Public Access
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/dsh-public-access
Environment=DSH_AUTH_USER=admin
Environment=DSH_AUTH_PASS=your-secure-password
Environment=DSH_PORT=3080
Environment=DSH_PUBLIC_URL=https://app.example/
Environment=DSH_TRUSTED_HOSTS=app.example
ExecStart=/path/to/dsh-public-access/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dsh
sudo systemctl start dsh
```

## ⚙️ 配置选项

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DSH_AUTH_USER` | `admin` | 登录用户名 |
| `DSH_AUTH_PASS` | `admin` | 登录密码 |
| `DSH_AUTH_SALT` | `dsh-reverse-proxy-salt` | 密码哈希盐值 |
| `DSH_HOST` | `0.0.0.0` | `start.sh` 传给 `--host` 的绑定地址 |
| `DSH_PORT` | `3080` | 监听端口 |
| `DSH_PUBLIC_URL` | 空 | 传给 `--public-url` 的对外根 URL |
| `DSH_TRUSTED_HOSTS` | 空 | 额外 `--trusted-host`，空格分隔 |
| `DSH_TLS_CERT` / `DSH_TLS_KEY` | 空 | 传给 `--tls-cert` / `--tls-key`，必须成对 |

### 命令行参数

| 参数 | 说明 |
|------|------|
| `--host <host>` | 绑定地址：`127.0.0.1`、`0.0.0.0`、`::`，或具体 IPv4/IPv6 字面量 |
| `--port <port>` | 指定监听端口（0 表示自动选择） |
| `--no-open` | 不自动打开浏览器 |
| `--trusted-host <authority>` | 添加额外的 trusted-host（可重复使用；LAN 地址会自动推导） |
| `--public-url <url>` | 对外公告的 HTTP(S) 根；用于打印/打开 URL、`DSH_WEB_URL` 与 Agent 运行时上下文 |
| `--tls-cert <file>` | PEM 证书链；必须与 `--tls-key` 同时使用 |
| `--tls-key <file>` | 未加密 PEM 私钥；必须与 `--tls-cert` 同时使用 |

> `--public-url` / `--tls-*` 需要 dsh 0.2.1+。在更旧的 dsh 上会直接报错，而不是静默忽略。

## 🔧 与 nginx 配合使用

推荐让 dsh 只监听 `127.0.0.1`，由 nginx 终止 TLS：

```bash
dsh --profile web --host 127.0.0.1 --port 3080 \
  --public-url https://your-domain.com/ --trusted-host your-domain.com
```

要点：

- nginx 必须转发真实 `Host`（默认的 `proxy_set_header Host $host;` 即可）；写成 `127.0.0.1` 会被 dsh 当作本机请求。
- `--trusted-host` 必须包含浏览器地址栏里的域名；否则 `/api` 会返回纯文本 `forbidden`，这是 dsh 的 Host 栅栏，不是插件登录失败。
- 如果使用路径前缀（例如 `https://app.example/ui/`），用 `--public-url https://app.example/ui/`，并让 nginx 剥掉 `/ui/` 前缀转给 dsh；插件的登录/登出/index 跳转都使用相对路径，可以正常工作。
- `X-Forwarded-Proto` 不作为鉴权依据；需要 `Secure` Cookie 时请配置 `--public-url https://...` 或让 dsh 直接终止 TLS。

### 基本配置

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### HTTPS 配置

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

## 🔒 安全说明

### 认证机制（dsh 0.2.1 适配）

dsh 0.2.1 为 Web 端引入了原生浏览器鉴权：每个进程生成随机启动令牌，访问 `http://<host>:<port>/?token=...` 后换取绑定该 authority 的签名 Cookie（默认 30 天）。`/api` 与 `index.html` 都要求该 Cookie，且 `/api` 先经过 Host/Origin 栅栏。本插件在该机制**之上**叠加用户名/密码登录：

- **插件登录（推荐，便于多人共享）**：未登录访问根路径时跳转 `/_auth/login`，使用 `DSH_AUTH_USER` / `DSH_AUTH_PASS` 登录，签发 24 小时有效的 `dsh_session` Cookie。
- **鉴权接入点**：dsh 0.2.1 的 `/api` 和 API WebSocket 升级走 `connection.admit`，index 走 `connection.authorizeIndex`；插件把有效 `dsh_session` 接入这两个方法，其余请求原样交给 dsh 原生令牌/Cookie 流程。
- **信任栅栏**：Host/Origin 栅栏仍然生效。`--trusted-host` 声明公网 IP/域名；`0.0.0.0` 时插件按网卡推导 LAN 地址，`start.sh` 另外探测公网 IP。未声明的 Host 访问 `/api` 会得到 403。
- **会话管理**：`dsh_session` 使用 HMAC-SHA256 签名；密码使用 SHA-256 加盐哈希；用户名与密码比较都使用 `timingSafeEqual` 防止时序攻击。登出会清除 `dsh_session` 以及请求中所有 `dsh-auth-*` 原生 Cookie。
- **前端兼容**：注入脚本设置 `globalThis.__DSH_TRANSPORT__.ownsHost = true`，使公网访问获得与回环一致的 `isLoopback` 状态（主机设置持久化、文件打开等功能可用）；并补齐公网 HTTP 下的 `crypto.randomUUID`。

### 通配绑定的安全边界

dsh 0.2.1 明确拒绝 `0.0.0.0`，理由是把所有接口暴露到网络会放大远程代码执行风险。本插件为了保留“一键公网/局域网访问”的能力，**在 boot 路径上就地放宽了 `WebServer.Config.host` schema**，并用上面的登录认证作为补偿控制。请理解：

1. **这不是上游支持的配置方式**，升级 dsh 后 schema 形状可能变化；放宽失败时插件会 fail loud，不会静默降级。
2. **登录认证不能替代网络隔离**。暴露到公网时请使用 HTTPS、防火墙/安全组，并修改默认密码。
3. **第三方路由不在本插件鉴权范围内**：只保护 dsh 的 index 与 `connection` 管理的 `/api`。直接注册在 `webServer` 上的其他插件路由仍按该插件自身的安全策略处理；只安装可信插件。
4. **插件会话是唯一可撤销凭据**：不伪造、不重放 dsh 原生 `dsh-auth-*` Cookie；原生 Cookie 只作为备选入口。

### 安全建议

1. **修改默认密码**：生产环境务必设置 `DSH_AUTH_USER` / `DSH_AUTH_PASS`
2. **优先使用 nginx + loopback**：只有确实需要多网卡直连时才用 `--host 0.0.0.0`
3. **使用 HTTPS**：通过 nginx 或 `--tls-cert` / `--tls-key` 配置 TLS
4. **限制访问**：使用防火墙/安全组限制来源 IP
5. **定期更新**：保持插件与 dsh 版本匹配


## 🛠️ 故障排除

### 常见问题

#### 1. 无法访问 Web 界面

```bash
# 检查服务是否运行
ps aux | grep dsh

# 检查端口是否监听
netstat -tlnp | grep 3080

# 检查防火墙设置
sudo ufw status
sudo iptables -L -n
```

#### 2. 登录后自动跳转回登录页

```bash
# 检查浏览器是否禁用 Cookie
# 检查系统时间是否准确（会话验证依赖时间戳）
date

# 清除浏览器缓存和 Cookie
```

#### 3. 启动时报 webserver wildcard / `--host 0.0.0.0` 不可用

说明插件没能就地放宽 boot 路径的 `WebServer.Config.host`（dsh 版本不匹配，或 boot 路径解析失败）。处理：

```bash
dsh --profile web --dump-config | grep -A3 web-startup
```

确认 `web-startup` 已 disabled、`public-access-web-startup` 已插入。仍失败时：

- 升级 dsh 到 0.2.1-rc.2；
- 或改用具体网卡地址：`--host 192.168.1.5`；
- 或让 dsh 监听 `127.0.0.1`，由 nginx 暴露公网。

#### 4. API 请求返回 401

```bash
# 确保已登录且会话未过期
# 检查请求是否携带正确的 Cookie
curl -v -b "dsh_session=your-session" http://localhost:3080/api/status
```

如果登录成功但 `/api` 仍 401，检查插件是否真正加载、`connection.admit` 是否被 patch 到；dsh 0.2.1 的 `/api` 不再经过 `requestRejection`。

#### 5. API 请求返回 403 / 纯文本 forbidden

这是 dsh 的 Host/Origin 栅栏，不是插件登录失败。把浏览器地址栏里的 authority 加进 `--trusted-host`（或 `DSH_TRUSTED_HOSTS`），并确认反向代理转发了真实 `Host`。响应体形状可快速定位来源：

| 响应 | 来源 | 处理 |
|------|------|------|
| 401 / 跳转 `/_auth/login` | 插件会话无效 | 重新登录 |
| 纯文本 `forbidden` | dsh Host 栅栏 | 补 `--trusted-host` |
| 登录 POST 返回 403 页面 | 插件检测到 Host 不受信 | 补 `--trusted-host` |

#### 6. nginx 代理后 WebSocket 连接失败

确保 nginx 配置包含 WebSocket 支持：
```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### 日志查看

```bash
# 查看 DSH 日志
journalctl -u dsh -f

# 或直接查看进程输出
./start.sh 2>&1 | tee dsh.log
```

## 📁 项目结构

```
dsh-public-access/
├── src/
│   ├── reverse-proxy-fix.js   # 主插件（登录路由 + admit/authorizeIndex 适配 + polyfill）
│   ├── auth.js                # 认证模块（会话、密码验证、登录页面）
│   ├── web-startup.js         # Web 启动配置（放宽 host schema、新 flag、trustedHosts 推导）
│   ├── webserver-schema.js    # boot 路径 webserver host schema 放宽 + LAN authority 推导
│   └── public-url.js          # --public-url 校验（与 stock 规则一致）
├── test/                      # node:test 单元测试
├── cordis.patch.yml           # DSH 插件配置补丁
├── start.sh                   # 启动脚本
├── package.json               # 包配置
└── README.md                  # 说明文档
```

## 🤝 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

### 开发环境

```bash
# 克隆仓库
git clone https://github.com/laoer/dsh-public-access.git
cd dsh-public-access

# 安装依赖
pnpm install

# 运行单元测试
npm test

# 以 link: 方式装进 web profile
dsh plugin --profile web add .
```

### 代码规范

- 使用 ES Module 语法
- 遵循现有代码风格
- 添加必要的注释
- 更新相关文档

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 🔗 相关链接

- **仓库地址**：https://github.com/laoer/dsh-public-access
- **DeepSeek Harness**：https://github.com/deepseek-ai/deepseek-harness
- **问题反馈**：https://github.com/laoer/dsh-public-access/issues

## 📞 支持

如有问题或建议，请通过以下方式联系：

- 提交 Issue 到 Gitee 仓库
- 发送邮件至维护者

---

**享受使用 DeepSeek Harness 的愉快体验！** 🎉
