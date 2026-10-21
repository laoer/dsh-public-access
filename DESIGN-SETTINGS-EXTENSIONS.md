# DSH 设置界面扩展设计方案

## 1. 架构概述

### 1.1 DSH 设置界面架构

DSH 的设置界面采用 **Slot（插槽）** 系统进行 UI 组合：

```
SettingsRoot (sidebar.settings)
├── settings.trigger     - 触发按钮
├── settings.header      - 标题
├── settings.action      - 操作按钮
├── settings.close       - 关闭按钮
├── settings.section     - 设置分区（列表）
│   ├── general          - 通用设置 (order: 0)
│   ├── models           - 模型设置 (order: 10)
│   └── plugins          - 插件设置 (order: 15)
│       ├── settings.plugins.tab  - 插件分区内的标签页
│       │   ├── configurable      - 插件配置 (order: 0)
│       │   └── all               - 插件列表 (order: 10)
│       └── settings.plugin.item  - 插件配置项
└── settings.onboarding  - 引导步骤
```

### 1.2 关键技术点

1. **Slot 注册机制**：通过 `ctx.slots.register()` 注册 UI 组件
2. **Locale 字典**：每个插件维护自己的中英文翻译字典
3. **Settings Scope**：通过 `ctx.settingsScope.bind()` 绑定设置命名空间
4. **API Remotes**：通过 `ctx.remote` 调用后端 API
5. **Client Bundle**：前端代码打包为 `client.js`，通过 `window.__ModuleLoader__.load()` 加载

## 2. 功能需求分析

### 2.1 SKILL 管理功能
- 查看所有已注册的 Skill 列表
- 支持 Skill 启用/禁用
- 显示 Skill 的来源、描述等信息

### 2.2 MCP 管理功能
- 查看所有已配置的 MCP Server 列表
- 支持 MCP Server 启用/禁用
- 支持 MCP Server 配置编辑（命令、参数、环境变量等）

### 2.3 归档 Session 管理功能
- 查看所有归档的 Session 列表
- 支持物理删除归档 Session（删除文件和数据库记录）
- 支持恢复归档 Session 为非归档状态

## 3. 实现方案

### 3.1 方案一：创建独立插件包（推荐）

创建一个新的 DSH 插件包 `dsh-settings-extensions`，包含：

#### 3.1.1 目录结构
```
dsh-settings-extensions/
├── package.json
├── cordis.patch.yml          # 注册插件到 web profile
├── src/
│   ├── index.js              # Host 端入口
│   ├── client.js             # Client 端入口（设置界面）
│   ├── api/
│   │   ├── skills.js         # Skill 管理 API
│   │   ├── mcp.js            # MCP 管理 API
│   │   └── sessions.js       # Session 管理 API
│   └── components/
│       ├── SkillManager.jsx  # Skill 管理组件
│       ├── McpManager.jsx    # MCP 管理组件
│       └── SessionManager.jsx # Session 管理组件
```

#### 3.1.2 注册新的设置分区

```javascript
// src/client.js
export function apply(ctx) {
  const t = ctx.locale.bind(NS);
  
  // 注册新的设置分区：扩展管理
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "extensions",
    order: 20,  // 在插件之后
    label: () => t("nav"),
    locale: NS,
    inject: sectionInjected,
    children: {
      "settings.extensions.tab": {
        kind: "list",
        scope: "root"
      }
    }
  }, ExtensionsSettingsSection));
  
  // 注册 Skill 管理标签页
  ctx.slots.inject("settings.extensions.tab", () => ctx.slots.register({
    name: "settings.extensions.tab",
    id: "skills",
    order: 0,
    label: () => t("skillsTab"),
    locale: NS,
    inject: () => skillManager.inject()
  }, SkillManagerTab));
  
  // 注册 MCP 管理标签页
  ctx.slots.inject("settings.extensions.tab", () => ctx.slots.register({
    name: "settings.extensions.tab",
    id: "mcp",
    order: 10,
    label: () => t("mcpTab"),
    locale: NS,
    inject: () => mcpManager.inject()
  }, McpManagerTab));
  
  // 注册 Session 管理标签页（可放在通用设置或独立分区）
  ctx.slots.inject("settings.extensions.tab", () => ctx.slots.register({
    name: "settings.extensions.tab",
    id: "sessions",
    order: 20,
    label: () => t("sessionsTab"),
    locale: NS,
    inject: () => sessionManager.inject()
  }, SessionManagerTab));
}
```

#### 3.1.3 后端 API 设计

**Skill 管理 API**：
```javascript
// 查看 Skill 列表
ctx.skills.list(options)

// Skill 启用/禁用通过配置文件控制
// ~/.dsh/settings.yaml 中添加：
// skills:
//   disabled:
//     - skill-name-1
//     - skill-name-2
```

**MCP 管理 API**：
```javascript
// MCP 配置存储在 ~/.dsh/settings.yaml
// mcp:
//   servers:
//     server-name:
//       command: "npx"
//       args: ["-y", "@modelcontextprotocol/server-filesystem"]
//       env: {}
//       enabled: true

// 查看 MCP Server 列表
ctx.mcpClient.listServers()

// 启用/禁用 MCP Server
ctx.mcpClient.setServerEnabled(name, enabled)

// 更新 MCP Server 配置
ctx.mcpClient.updateServer(name, config)
```

**Session 管理 API**：
```javascript
// 查看归档 Session 列表
ctx.sessionPersistence.listArchived()

// 删除归档 Session（物理删除）
ctx.sessionPersistence.deleteArchived(sessionId)

// 恢复归档 Session
ctx.sessionPersistence.restoreArchived(sessionId)
```

### 3.2 方案二：扩展现有插件

在现有的 `@laoer/dsh-public-access` 插件中添加设置界面扩展。这种方式更简单，但会增加插件的复杂度。

### 3.3 方案三：直接修改 DSH 核心包

直接修改 `@deepseek-ai/dsh-client-ui-settings-general` 等包。**不推荐**，因为：
- 会影响 DSH 的升级
- 修改编译后的文件难以维护

## 4. 详细实现步骤

### 4.1 创建插件包

```bash
mkdir -p ~/.dsh/plugins/dsh-settings-extensions/src
```

### 4.2 编写 package.json

```json
{
  "name": "dsh-settings-extensions",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./client": "./src/client.js"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-connection"
      ],
      "platform": "web"
    }
  },
  "dependencies": {}
}
```

### 4.3 编写 cordis.patch.yml

```yaml
# 将插件添加到 web profile
- id: settings-extensions
  name: 'dsh-settings-extensions'
```

### 4.4 编写 Host 端 API

```javascript
// src/index.js
export const name = 'settings-extensions';
export const inject = ['skills', 'mcpClient', 'sessionPersistence'];

export function apply(ctx) {
  // 注册 API 端点
  ctx.api.get('/api/settings-extensions/skills', async () => {
    const skills = await ctx.skills.list();
    return { skills };
  });
  
  ctx.api.post('/api/settings-extensions/skills/:name/toggle', async (req) => {
    const { name } = req.params;
    const { enabled } = req.body;
    // 实现启用/禁用逻辑
  });
  
  // MCP 管理 API
  ctx.api.get('/api/settings-extensions/mcp/servers', async () => {
    // 返回 MCP Server 列表
  });
  
  // Session 管理 API
  ctx.api.get('/api/settings-extensions/sessions/archived', async () => {
    // 返回归档 Session 列表
  });
  
  ctx.api.delete('/api/settings-extensions/sessions/:id', async (req) => {
    const { id } = req.params;
    // 物理删除 Session
  });
  
  ctx.api.post('/api/settings-extensions/sessions/:id/restore', async (req) => {
    const { id } = req.params;
    // 恢复归档 Session
  });
}
```

### 4.5 编写 Client 端组件

```javascript
// src/client.js
window.__ModuleLoader__.load({
  id: "dsh-settings-extensions",
  factory: (require) => {
    const react = require("react");
    const react_jsx_runtime = require("react/jsx-runtime");
    
    // Skill 管理组件
    function SkillManagerTab({ t, listSkills, toggleSkill }) {
      const [skills, setSkills] = react.useState([]);
      const [loading, setLoading] = react.useState(true);
      
      react.useEffect(() => {
        listSkills().then(data => {
          setSkills(data);
          setLoading(false);
        });
      }, []);
      
      if (loading) return <div>{t("loading")}</div>;
      
      return (
        <div className="skill-manager">
          <h3>{t("skillsTitle")}</h3>
          <p>{t("skillsDescription")}</p>
          <ul className="skill-list">
            {skills.map(skill => (
              <li key={skill.name} className="skill-item">
                <div className="skill-info">
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                </div>
                <button onClick={() => toggleSkill(skill.name)}>
                  {skill.enabled ? t("disable") : t("enable")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    
    // MCP 管理组件
    function McpManagerTab({ t, listServers, toggleServer, updateConfig }) {
      // 类似实现
    }
    
    // Session 管理组件
    function SessionManagerTab({ t, listArchived, deleteSession, restoreSession }) {
      // 类似实现
    }
    
    // 注册到设置界面
    function apply(ctx) {
      const t = ctx.locale.bind("settings.extensions");
      
      // 注册字典
      ctx.effect(() => ctx.locale.register("settings.extensions", {
        zh: {
          nav: "扩展管理",
          skillsTab: "Skill 管理",
          mcpTab: "MCP 管理",
          sessionsTab: "Session 管理",
          // ... 其他翻译
        },
        en: {
          nav: "Extensions",
          skillsTab: "Skills",
          mcpTab: "MCP",
          sessionsTab: "Sessions",
          // ... 其他 translations
        }
      }), "settings-extensions: dictionaries");
      
      // 注册设置分区
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "extensions",
        order: 20,
        label: () => t("nav"),
        locale: "settings.extensions",
        children: {
          "settings.extensions.tab": {
            kind: "list",
            scope: "root"
          }
        }
      }, ExtensionsSection));
      
      // 注册标签页
      ctx.slots.inject("settings.extensions.tab", () => ctx.slots.register({
        name: "settings.extensions.tab",
        id: "skills",
        order: 0,
        label: () => t("skillsTab"),
        locale: "settings.extensions"
      }, SkillManagerTab));
      
      // ... 注册其他标签页
    }
    
    return { apply };
  }
});
```

## 5. 数据存储设计

### 5.1 Skill 启用/禁用配置

在 `~/.dsh/settings.yaml` 中添加：

```yaml
skills:
  disabled:
    - tencent-docs
    - test-team
```

### 5.2 MCP Server 配置

```yaml
mcp:
  servers:
    filesystem:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
      env: {}
      enabled: true
    github:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "xxx"
      enabled: false
```

### 5.3 Session 归档状态

Session 归档状态存储在 Session 的元数据中：
- 文件系统：`~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd`
- SQLite 数据库：`~/.dsh/session-query.sqlite`

## 6. 注意事项

### 6.1 不影响现有功能

1. **独立命名空间**：使用 `settings.extensions` 命名空间，避免冲突
2. **Slot 隔离**：通过 `settings.extensions.tab` 子插槽，不影响现有标签页
3. **API 隔离**：使用独立的 API 路径 `/api/settings-extensions/`

### 6.2 兼容性考虑

1. **向后兼容**：新功能不影响现有设置的读写
2. **渐进增强**：插件可选安装，不影响核心功能
3. **错误隔离**：插件错误不影响主应用

### 6.3 安全性考虑

1. **权限控制**：Session 删除操作需要确认
2. **数据备份**：删除前提示用户备份重要数据
3. **操作日志**：记录关键操作以便审计

## 7. 测试计划

### 7.1 单元测试
- Skill 列表获取和启用/禁用
- MCP Server 配置读写
- Session 归档/恢复/删除

### 7.2 集成测试
- 设置界面 UI 交互
- API 端点调用
- 数据持久化验证

### 7.3 回归测试
- 现有设置功能不受影响
- 现有 Skill/MCP 功能正常
- 现有 Session 管理正常

## 8. 实现总结

### 8.1 已创建的文件

基于设计方案，已创建以下文件：

```
~/.dsh/plugins/dsh-settings-extensions/
├── package.json              # 插件配置
├── cordis.patch.yml          # Cordis 注册配置
├── README.md                 # 使用文档
└── src/
    ├── index.js              # Host 端 API（后端）
    └── client.js             # Client 端 UI（前端）
```

### 8.2 核心实现

#### 8.2.1 Host 端 API (src/index.js)

提供以下 API 端点：

| API | 方法 | 功能 |
|-----|------|------|
| `/api/settings-extensions/skills` | GET | 获取 Skill 列表 |
| `/api/settings-extensions/skills/:name/toggle` | POST | 切换 Skill 启用状态 |
| `/api/settings-extensions/mcp/servers` | GET | 获取 MCP Server 列表 |
| `/api/settings-extensions/mcp/servers/:name/toggle` | POST | 切换 MCP Server 启用状态 |
| `/api/settings-extensions/mcp/servers/:name/config` | POST | 更新 MCP Server 配置 |
| `/api/settings-extensions/mcp/servers/:name` | DELETE | 删除 MCP Server |
| `/api/settings-extensions/sessions/archived` | GET | 获取归档 Session 列表 |
| `/api/settings-extensions/sessions/:workspace/:id` | DELETE | 永久删除归档 Session |
| `/api/settings-extensions/sessions/:workspace/:id/restore` | POST | 恢复归档 Session |

#### 8.2.2 Client 端 UI (src/client.js)

通过 Slot 系统注册到设置界面：

1. **扩展管理分区** (settings.section, id: "extensions", order: 20)
   - 在插件设置之后显示
   
2. **Skill 管理标签页** (settings.extensions.tab, id: "skills", order: 0)
   - 显示所有已注册的 Skill
   - 支持启用/禁用切换
   
3. **MCP 管理标签页** (settings.extensions.tab, id: "mcp", order: 10)
   - 显示所有已配置的 MCP Server
   - 支持启用/禁用切换和删除
   
4. **归档会话标签页** (settings.extensions.tab, id: "sessions", order: 20)
   - 显示所有归档的 Session
   - 支持恢复和永久删除

### 8.3 数据存储

#### Skill 启用/禁用
存储在 `~/.dsh/settings.yaml`：
```yaml
skills:
  disabled:
    - skill-name-1
    - skill-name-2
```

#### MCP Server 配置
存储在 `~/.dsh/settings.yaml`：
```yaml
mcp:
  servers:
    server-name:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
      env: {}
      enabled: true
```

#### Session 归档状态
通过在 Session 目录下创建 `.archived` 标记文件：
```
~/.dsh/sessions/<workspace>/<session-id>/.archived
```

### 8.4 集成方式

已更新 `~/.dsh/profiles/web/package.json`，将插件添加到 web profile：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@laoer/dsh-public-access",
        "dsh-settings-extensions"
      ]
    }
  },
  "dependencies": {
    "dsh-settings-extensions": "file:../../plugins/dsh-settings-extensions"
  }
}
```

### 8.5 不影响现有功能的设计

1. **独立命名空间**：使用 `settings.extensions` 命名空间
2. **Slot 隔离**：通过 `settings.extensions.tab` 子插槽
3. **API 隔离**：使用独立的 API 路径 `/api/settings-extensions/`
4. **配置隔离**：Skill/MCP 配置使用独立的配置节

## 9. 后续扩展

### 9.1 功能扩展
- Skill 配置编辑
- MCP Server 连接测试
- Session 导出功能
- 批量操作支持

### 9.2 UI 优化
- 搜索和过滤功能
- 拖拽排序
- 快捷键支持
- 响应式布局

## 10. 使用说明

### 10.1 启动服务

```bash
# 重启 DSH Web 服务以加载新插件
dsh web --host 0.0.0.0
```

### 10.2 访问设置界面

1. 打开浏览器访问 DSH Web 界面
2. 点击左侧边栏底部的"设置"按钮
3. 在设置面板中点击"扩展管理"
4. 使用三个标签页管理 Skill、MCP 和归档会话

### 10.3 注意事项

1. **数据安全**：永久删除 Session 操作不可撤销
2. **配置备份**：修改配置前建议备份 `~/.dsh/settings.yaml`
3. **重启生效**：某些配置修改可能需要重启服务
