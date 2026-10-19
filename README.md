# dsh-settings-extras

在 dsh 桌面版 GUI 的「设置 → 通用设置」中增加两个官方设置页没有暴露的选项：
**自动压缩阈值**与**默认思考等级**。滑块改完即生效，无需重启，也无需手工改配置文件。

## 这是什么

dsh 的上下文自动压缩阈值写在每个 Agent 预设内联的
`compaction-basic.config.thresholdRatio` 里，默认思考等级则由 provider 级的
`reasoning` 与请求级的 `reasoningEffort` 共同决定。这两处都不在设置页上，
用户要么改不了，要么得逐份改预设。

本插件补上这一缺口：

- **Host 半**（`lib/index.js`）：把设置页里选定的两个值推送到所有生效位置，
  并在每条模型请求上按该模型实际支持的档位做安全换档。
- **Client 半**（`lib/client.js`）：向「设置 → 通用设置」的 `settings.general.item`
  插槽贡献两行滑块，读写走官方设置通道 `ctx.configForms.get('dsh-settings-extras')`
  → `remote.settings.mutate`，由 Host 落盘到 profile 的配置文档。

界面文案内置中文与英文两套，样式只用 `--dsw-*` 主题 token，跟随 dsh 主题。

## 两个选项

### 自动压缩阈值

上下文占用达到窗口的这个比例时触发自动压缩。范围 **20% ~ 95%**，步进 5%，
默认 **50%**。

写入方式是**整份重写预设 config**：阈值所在的 `compaction-basic` 是预设
`plugins` 数组里的嵌套行，而补丁层只能按 id 寻址、且多个预设的嵌套行同名冲突，
所以无法就地打补丁。Host 按包名扫描所有 `@deepseek-ai/dsh-agent-preset` 行，
因此将来新增的预设会被自动纳入，无需改代码。

上下限不是随手取的：

- 上限 0.95：取 1.0 时触发点等于压力预算上限（`floor(min(W×ratio, W−reserved−headroom))`），
  容易在压缩之前先撞上 provider 的上下文上限。
- 下限 0.2：必须高于 `retainRatio`（`compaction-basic` 要求 `retainRatio < thresholdRatio`，
  其默认值为 0.16），否则预设会在加载期直接拒绝。

阈值写进预设后**对新建会话生效**，已有会话不会回溯调整。

### 默认思考等级

未手动指定档位时使用。七档：`off` / `minimal` / `low` / `medium` / `high` /
`xhigh` / `max`，默认 **high**。生效分两处：

1. **请求换档**：在 `agent/request` 的最终配置上，按该模型实际支持的档位集合重选一档
   （取不低于目标的最小档；没有更高档则取该模型最高档；目标是 `off` 时不往上抬，
   交给 provider 自己的默认）。因为 pi-ai 路由的「模型默认档」来自 provider 级
   `reasoning`，而它是 route 级，无法表达「按模型升高/降档」。
2. **显示对齐**：把各 provider 的 `reasoning` 一并写成同一档位，让输入框旁的档位
   显示不再落到 Default。

换档只作用于**没有显式档位**的请求：用户在输入框里手选过档位的会话保持其选择。

## 仓库结构

```
dsh-settings-extras/
├── package.json          # bundle 元数据，声明 dsh.bundle.patch 与 dsh.client
├── cordis.patch.yml      # 把本插件作为一条 Loader 行插入 profile
├── lib/
│   ├── index.js          # Host 半：推送阈值 / 请求换档
│   └── client.js         # Client 半：通用设置里的两行滑块
├── reconcile.log         # 运行时诊断日志（已 gitignore，不入库）
├── .gitignore
└── README.md
```

依赖只有一项：`@deepseek-ai/schemastery`，声明在 `peerDependencies` 与
`devDependencies` 中，由运行中的 dsh 运行时闭包提供，插件仓库不携带 `node_modules/`。

## 安装与启用

本插件是 dsh bundle，由 dsh 桌面版按 `package.json` 中的 `dsh` 字段识别并加载：

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，由 Host 半作为一条 Loader 行注册。
- `dsh.client` 声明 `platform: web`，由 dsh 客户端模块系统把 `lib/client.js`
  作为浏览器半侧送出（不会自动送，必须靠 patch 行占位）。

通过 dsh 插件管理器安装，或把本仓库地址作为 bundle 加进 profile。加载后两个滑块
出现在**「设置 → 通用设置」**页，按 `order` 30 / 31 排入该页条目列表。

> **patch 行的 id 就是设置命名空间。** 它必须与 `lib/client.js` 的 `CONFIG_NS`
> 完全一致（当前均为 `dsh-settings-extras`）；改名会让已有用户的配置变成孤儿。
>
> **`cordis.patch.yml` 不声明 `config`。** 两个字段的默认值由 `lib/index.js` 的
> `Config` schema 给出，用户的改动落在 profile 自己的 patch 层上——升级本 bundle
> 不会覆盖用户已调好的值。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `compactionThreshold` | number | `0.5` | 自动压缩触发比例，取值 0.2 ~ 0.95 |
| `defaultReasoningEffort` | string | `high` | 默认思考等级，取 `LEVEL_ORDER` 中的一档 |

两个字段都标了 `volatile()`，这是设置页可写入的前提。客户端滑块带有兜底值，
与 Host 侧 `Config` 的默认值保持一致。

## 实现取舍

- **触发用轮询而非事件。** `settings/document-updated` 只在 `describe()` 检测到原始值
  变化时发出，实测拖动滑块后并不总会推流。因此除监听该事件外，另有 1.5 秒一次的
  轮询读取 volatile 值兜底——读引用不依赖任何事件，是确定性的触发；值未变时既不写入
  也不产生副作用。
- **只在确实不同时才写。** `configEditor.edit` 在 `next` 与 `inherited` 深等时会删除
  该行的 config，盲目写入会抹掉用户自己固定的预设配置。所以每处写入前都先比对。
- **每轮只写一条，连续失败到上限即放弃。** 避免以 1.5 秒周期反复打 Loader。
- **不 import 任何 `@deepseek-ai/dsh-client-*` 包。** Client 半只 `require` 平台种子模块
  （`react` / `react/jsx-runtime`），使 dsh 升级最多导致外观降级，而不会让插槽条目崩掉。

## 诊断日志

Host 半把「本轮推送了什么、哪一条写入失败」写进插件目录下的 `reconcile.log`，
只保留最近 120 行，用于外部观察推流是否发生。该文件已 gitignore。

## 许可证

MIT
