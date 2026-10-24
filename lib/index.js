/**
 * agent-blackbox · DSH 插件（宿主半边）
 * ====================================
 *
 * 做一件事：把核心的路由挂到 DSH **自己的** webServer 的 `/blackbox` 前缀下。
 *
 * 关键取舍：
 *   · **不额外起进程、不额外开端口** —— 路由跑在宿主进程里，dashboard 与 API
 *     和 DSH 同源，iframe 直接可用，也没有跨域问题；
 *   · **复用核心路由**（`createRouter`）—— 插件不是第二套实现，就是同一份代码
 *     换了个挂载点；独立运行的 `blackbox ui` 与插件面板行为完全一致；
 *   · **发布包自包含** —— `core/`（编译后的核心）与 `web/`（渲染器）随 npm 包
 *     一起发布，安装后不再依赖本仓库；仓库里 link 安装时则回退到 `dist/` 或 `src/`。
 *
 * 会话来源自动发现：默认打开最近活动的那一个，也可以用 `?file=` 指定。
 */

import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（发布包 / 仓库里的 integrations/dsh-plugin） */
const PACKAGE_ROOT = new URL('../', import.meta.url)
/** 仓库根目录（仅 link 开发时存在） */
const REPO_ROOT = new URL('../../../', import.meta.url)

/** agent-blackbox monorepo 里的 integrations/dsh-plugin 才是"开发源码"形态 */
const monorepoLayout = /[\\/]integrations[\\/]dsh-plugin[\\/]?$/.test(fileURLToPath(PACKAGE_ROOT))
const devCheckout = monorepoLayout && existsSync(fileURLToPath(new URL('src/server.ts', REPO_ROOT)))
/** 发布包里预编译的核心：core/server.js */
const bundledCore = !devCheckout && existsSync(fileURLToPath(new URL('core/server.js', PACKAGE_ROOT)))

function latestMtime(url) {
  let max = 0
  const walk = (u) => {
    let entries
    try {
      entries = readdirSync(fileURLToPath(u), { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const child = new URL(`${ent.name}${ent.isDirectory() ? '/' : ''}`, u)
      if (ent.isDirectory()) walk(child)
      else {
        try {
          max = Math.max(max, statSync(fileURLToPath(child)).mtimeMs)
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(url)
  return max
}

/**
 * 发布包：直接加载 core/ 里编译好的 JS。
 * 仓库 link：优先 dist/，没有 dist 或 src 更新时用 src 的 TS（Node 类型擦除）。
 */
async function loadCore(name) {
  if (bundledCore) return import(new URL(`core/${name}.js`, PACKAGE_ROOT).href)
  const dist = new URL(`dist/${name}.js`, REPO_ROOT)
  const src = new URL(`src/${name}.ts`, REPO_ROOT)
  const distFile = fileURLToPath(dist)
  let target = src
  if (existsSync(distFile)) {
    const distMtime = statSync(distFile).mtimeMs
    const srcMtime = existsSync(fileURLToPath(src)) ? latestMtime(new URL('src/', REPO_ROOT)) : 0
    target = distMtime >= srcMtime ? dist : src
  }
  return import(target.href)
}

const { createRouter } = await loadCore('server')
const { discoverAll } = await loadCore('sources')

/** Cordis 插件名（必须与 cordis.patch.yml 里的 insert.id 一致） */
export const name = 'agent-blackbox'

const PREFIX = '/blackbox'

/** 发布包内置的示例会话；开发仓库里也有同一份 */
function bundledFixture() {
  for (const root of [PACKAGE_ROOT, REPO_ROOT]) {
    const file = fileURLToPath(new URL('fixtures/mission-demo.ndjson', root))
    if (existsSync(file)) return file
  }
  return null
}

/** 一个会话都没有时的兜底：空 NDJSON，面板显示空状态而不是报错 */
function placeholderSession() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agent-blackbox-'))
  const file = join(dir, 'empty.ndjson')
  writeFileSync(file, '')
  return file
}

/** 默认打开哪个会话：最近活动的那个；一个都没有就用内置示例 */
function pickDefaultSession(configured) {
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) return configured
  try {
    const all = discoverAll()
    if (all.length > 0) return all[0].file
  } catch {
    /* 没有安装任何 agent 也能用内置示例 */
  }
  return bundledFixture() ?? placeholderSession()
}

export function apply(ctx, config = {}) {
  const file = pickDefaultSession(config.file)
  // follow: true —— 实时会话文件在增长时增量扩展索引；静止会话没有额外开销
  const router = createRouter({ file, basePath: PREFIX, follow: true })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: (req, res) => {
            try {
              router.handle(req, res)
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`agent-blackbox: ${message}`)
            }
          },
        }),
      `agent-blackbox: ${PREFIX} routes`,
    )
  })
}
