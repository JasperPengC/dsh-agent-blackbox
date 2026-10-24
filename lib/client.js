/**
 * agent-blackbox · DSH 插件（浏览器半边）
 * ====================================
 *
 * 两个入口，都指向同一个宿主内路由 `/blackbox/`：
 *   · 侧栏 `sidebar.panellist`：任何时候一键到达；
 *   · 主区 `main`：整屏面板（iframe），外层不加额外工具条（DSH 面板本身已有 chrome）。
 *
 * 为什么用 iframe 而不是用 React 重写一遍仪表盘：
 *   仪表盘的性能关键（投影、检查点、聚合、分桶）全部在服务端，前端只是渲染器。
 *   用 iframe 直接复用同一份渲染器，插件和独立运行不会出现"两套 UI 慢慢漂移"。
 *   代价是多一层文档上下文，对这个场景可以忽略。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-blackbox',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const NS = 'plugin.agentBlackbox'
    /** 侧栏面板 id；同时作为 main slot 的 key */
    const PANEL_ID = 'agent-blackbox'
    /** 面板里用嵌入模式：隐藏 blackbox 自己的顶栏，避免与外层 chrome 重复 */
    const EMBEDDED = '/blackbox/?embed=1'

    /**
     * 判断 iframe 里加载的是不是黑匣子页面。
     * 注意：app.js 启动后会把 document.title 改成「会话名 · agent-blackbox」，
     * 所以不能用全等匹配；用包含 + 关键元素双保险。
     */
    function isOurDocument(doc) {
      if (!doc) return false
      try {
        if (typeof doc.title === 'string' && doc.title.includes('agent-blackbox')) return true
        return !!doc.querySelector && !!doc.querySelector('#sessionTitle')
      } catch {
        return false
      }
    }

    const DICTIONARIES = {
      zh: { nav: '黑匣子' },
      en: { nav: 'Blackbox' },
    }

    /**
     * 面板 = 一个 iframe + 父层占位。
     * 为什么需要占位/重试：DSH 刚启动时 UI 可能先把面板挂出来，此时插件路由
     * 还没注册好，iframe 请求会拿到错误页并**永久空白**（Chrome 不会自动重试）。
     * 这里在父层探测 iframe 是否真的加载了我们的页面（同源可读 contentDocument），
     * 没加载到就自动带 cache-bust 重试，并始终显示可读的状态。
     */
    function Dashboard() {
      const [attempt, setAttempt] = React.useState(0)
      const [phase, setPhase] = React.useState('loading') // loading | retrying | ready | error
      const frameRef = React.useRef(null)
      const triesRef = React.useRef(0)
      const lastRetryRef = React.useRef(0)

      const probe = React.useCallback(() => {
        const el = frameRef.current
        try {
          const doc = el && el.contentDocument
          if (isOurDocument(doc)) {
            setPhase('ready')
            return true
          }
        } catch {
          /* 跨域/未就绪：当作失败 */
        }
        return false
      }, [])

      const reload = React.useCallback(() => {
        triesRef.current = 0
        lastRetryRef.current = 0
        setPhase('loading')
        setAttempt((n) => n + 1)
      }, [])

      React.useEffect(() => {
        let stopped = false
        const startedAt = Date.now()
        const timer = setInterval(() => {
          if (stopped) return
          if (probe()) {
            stopped = true
            clearInterval(timer)
            return
          }
          const now = Date.now()
          // 给正常加载 1.5s；之后每 1.2s 重试一次，最多 6 次
          let loading = false
          try {
            const el = frameRef.current
            loading = !!(el && el.contentDocument && el.contentDocument.readyState === 'loading')
          } catch {
            loading = false
          }
          if (now - startedAt > 1500 && triesRef.current < 6 && now - lastRetryRef.current > 1200 && !loading) {
            triesRef.current += 1
            lastRetryRef.current = now
            setPhase('retrying')
            setAttempt((n) => n + 1)
          }
          if (now - startedAt > 15000) {
            stopped = true
            clearInterval(timer)
            setPhase('error')
          }
        }, 400)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [probe])

      const placeholderText =
        phase === 'error'
          ? '面板加载失败（插件服务未就绪）'
          : phase === 'retrying'
            ? '面板服务还没就绪，正在重试…'
            : '正在加载黑匣子面板…'

      return h(
        'div',
        { style: { position: 'relative', height: '100%', minHeight: 0, background: '#070b12' } },
        h('style', null, '@keyframes bbSpin{to{transform:rotate(360deg)}}'),
        h('iframe', {
          key: attempt,
          ref: frameRef,
          src: `${EMBEDDED}&r=${attempt}`,
          title: 'agent-blackbox',
          onLoad: () => {
            probe()
          },
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#070b12' },
        }),
        phase !== 'ready'
          ? h(
              'div',
              {
                style: {
                  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 10,
                  background: '#070b12', color: '#94a3b8', font: '12px ui-monospace, Menlo, monospace',
                  zIndex: 2,
                },
              },
              h('div', {
                style: {
                  width: 18, height: 18, borderRadius: '50%',
                  border: '2px solid #24334c', borderTopColor: '#38bdf8',
                  animation: phase === 'error' ? 'none' : 'bbSpin .8s linear infinite',
                },
              }),
              h('div', null, placeholderText),
              phase === 'error'
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: reload,
                      style: {
                        font: 'inherit', color: '#dbe4f3', background: '#0f1a2c',
                        border: '1px solid #24334c', borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                      },
                    },
                    '重新加载',
                  )
                : null,
            )
          : null,
      )
    }

    function NavIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.6, y: 3.2, width: 12.8, height: 9.6, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 5.4, cy: 8, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 10.6, cy: 8, r: 1.15, fill: 'currentColor' }),
        h('path', { d: 'M6.7 8h2.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'agent-blackbox: dictionaries')

      // 主区整屏面板
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Dashboard),
      )
      // 侧栏入口：一键到达
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 31, locale: NS, label: () => ctx.locale.bind(NS)('nav') },
          NavIcon,
        ),
      )
    }

    exports.__isOurDocument = isOurDocument
    exports.name = 'agent-blackbox-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
