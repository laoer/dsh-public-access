# dsh-public-access

DeepSeek Harness 反向代理插件 — 支持公网 IP / nginx 访问 + 登录认证。

## 安装

```bash
dsh plugin --profile web add dsh-public-access
```

## 启动

```bash
# 使用默认账号 admin/admin
./start.sh

# 自定义账号
DSH_AUTH_USER=myuser DSH_AUTH_PASS=mypassword ./start.sh
```

## 功能

| 功能 | 说明 |
|---|---|
| 绑定 0.0.0.0 | `cordis.patch.yml` 覆盖 webserver 配置 |
| 登录认证 | 未登录自动跳转登录页，session 24h 有效 |
| API 代理 | HTTP 层伪装 Host 为 localhost，绕过特权接口限制 |
| 前端兼容 | 注入脚本 patch `connection.isLoopback` |
| crypto polyfill | 公网 HTTP 环境支持 `crypto.randomUUID` |

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_AUTH_USER` | `admin` | 登录用户名 |
| `DSH_AUTH_PASS` | `admin` | 登录密码 |
| `DSH_PORT` | `3080` | 监听端口 |

## 卸载

```bash
dsh plugin --profile web remove dsh-public-access
```
