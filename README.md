# dsh-public-access

DeepSeek Harness Web 插件。安装后可直接用 `dsh web --host 0.0.0.0` 对外提供访问。

## 安装

```bash
# 安装插件到 web profile
dsh plugin --profile web add dsh-public-access

# 启动
dsh web --host 0.0.0.0
```

## 使用

```bash
./start.sh
# 等价于:
# dsh --profile web --host 0.0.0.0 --no-open --port 3080
```

## 工作原理

全部在 Cordis 插件层解决，不修改任何 node_modules 文件：

| 问题 | 解决方式 |
|---|---|
| `--host 0.0.0.0` 被官方 web-startup 拒绝 | bundle 替换 `web-startup`，放行该参数 |
| WebServer 绑定所有网卡后访问被挡 | 官方 `webRuntime -> connection` 链会自动推导 LAN trustedHosts |
| 卸载后恢复默认 | 移除 bundle 后，原始 `dsh-web-app` 行恢复生效 |

## 文件结构

```
dsh-reverse-proxy/
├── package.json            # DSH 插件包声明
├── cordis.patch.yml        # 替换 web-startup 并挂载本包入口
├── src/
│   └── web-startup.js      # 替代官方 web-startup 的插件入口
└── README.md
```

## 卸载

```bash
dsh plugin --profile web remove dsh-public-access
```
