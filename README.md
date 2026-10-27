# dsh-agent-blackbox

[English](README.en.md) · 中文

DeepSeek Harness 插件：在侧栏打开 [agent-blackbox](https://github.com/JasperPengC/agent-blackbox)
仪表盘，实时监视会话、回放时间轴、查看跨会话成本总览。宿主进程内挂载，不额外起进程或端口。

[![npm](https://img.shields.io/npm/v/dsh-agent-blackbox?label=npm&color=4f7cff)](https://www.npmjs.com/package/dsh-agent-blackbox)
[![ci](https://github.com/JasperPengC/dsh-agent-blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/JasperPengC/dsh-agent-blackbox/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-green)

![面板回放](https://raw.githubusercontent.com/JasperPengC/agent-blackbox/main/docs/playback-dark.gif)

<sub>真实面板 UI · 合成会话 · 4× 回放 · [亮色录屏](https://raw.githubusercontent.com/JasperPengC/agent-blackbox/main/docs/playback-light.gif) · 网速慢可以看[亮色截图](https://raw.githubusercontent.com/JasperPengC/dsh-agent-blackbox/main/docs/panel-light.png)</sub>

## 安装

```bash
dsh plugin --profile desktop add dsh-agent-blackbox
```

重启 DSH 后，侧栏出现「黑匣子」▣，主区可打开整屏面板。也可以在 DSH 的
「设置 → 插件市场」里搜索 `agent-blackbox` 安装。dshmarket 目录也有收录：[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/p/JasperPengC/dsh-agent-blackbox/)。

发布包已内置编译后的核心（`core/`）与前端（`web/`），不需要另外安装
agent-blackbox，也不用本地构建。

开发时用 link 安装：

```bash
git clone https://github.com/JasperPengC/dsh-agent-blackbox.git
cd dsh-agent-blackbox
dsh plugin --profile desktop add link:$PWD
npm test
```

## 能看什么

- **实时**：正在写入的会话自动增量刷新
- **回放**：时间轴缩放 / 框选、工具瀑布、事件检查器
- **归因**：每个 agent 的工具、token、成本与阻塞关系
- **总览**：跨会话成本排行，按 runtime / 项目分组

## 工作原理

插件把核心的 HTTP 路由挂到 DSH 自己的 webServer 的 `/blackbox` 前缀下，与宿主
同源，不需要额外端口。宿主半边（`lib/index.js`）在宿主进程内挂载路由，浏览器
半边（`lib/client.js`）注册侧栏与面板；两侧复用 agent-blackbox 同一份渲染器。
所有数据都在本机，只读本地会话文件，无网络请求。

## 开发

```bash
npm test                                          # 宿主冒烟测试
node scripts/sync-core.mjs --from /path/to/agent-blackbox   # 同步 core/web
```

`core/` 与 `web/` 来自主仓库的构建产物，不要手改。

## 要求与限制

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0`；Node.js `>=22.19`
- 超过 24 MB 的会话只加载尾部 8 MB
- 成本依赖本地价格表；未知模型不计入合计
- 升级插件后需要重启 DSH

## 相关仓库

- [agent-blackbox](https://github.com/JasperPengC/agent-blackbox) — 主项目：会话事件模型、仪表盘、CLI 与 HTTP API

## 社区

本项目在 [LINUX DO](https://linux.do) 社区推广。

## 链接

- npm：https://www.npmjs.com/package/dsh-agent-blackbox
- 问题反馈：https://github.com/JasperPengC/dsh-agent-blackbox/issues
