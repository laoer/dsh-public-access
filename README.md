# dsh-reverse-proxy

DeepSeek Harness 反向代理插件 — 支持通过公网 IP 或 nginx 反向代理访问 Web UI。

**无需修改 node_modules，完全通过插件系统实现。**

## 安装

```bash
# 安装插件到 web profile
dsh plugin --profile web add /home/ubuntu/deepaeek-plugin

# 启动（自动检测公网 IP 并传递 --trusted-host）
./start.sh
```

## 使用

```bash
./start.sh
# 等价于:
# dsh --profile web --no-open --port 3080 --trusted-host 127.0.0.1 --trusted-host 43.139.254.202 ...
```

## 工作原理

全部在 Cordis 插件层解决，不修改任何 node_modules 文件：

| 问题 | 解决方式 |
|---|---|
| WebServer 绑定 127.0.0.1 | `cordis.patch.yml` 覆盖为 0.0.0.0 |
| API 特权接口只允许 loopback | HTTP 层拦截：将 `/api/*` 请求的 Host 头伪装为 127.0.0.1 |
| 前端 isLoopback=false | 注入脚本：Cordis 初始化后 patch `connection.isLoopback = true` |
| crypto.randomUUID 报错 | 注入 polyfill 脚本 |
| API 403 forbidden | `--trusted-host` 传递公网 IP |

## 文件结构

```
dsh-reverse-proxy/
├── package.json            # DSH 插件包声明
├── cordis.patch.yml        # 覆盖 webserver 绑定 0.0.0.0
├── src/
│   └── reverse-proxy-fix.ts  # 插件代码
├── start.sh                # 一键启动脚本
└── README.md
```

## 卸载

```bash
dsh plugin --profile web remove dsh-reverse-proxy
```
