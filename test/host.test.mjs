import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const plugin = await import('../lib/index.js')

test('exports the cordis plugin name and apply()', () => {
  assert.equal(plugin.name, 'agent-blackbox')
  assert.equal(typeof plugin.apply, 'function')
})

test('serves the panel and API through a host web server', async () => {
  let handler = null
  plugin.apply({
    inject(_names, fn) {
      fn({
        effect: (run) => run(),
        webServer: {
          register(route) {
            handler = route.handler
            return { dispose() {} }
          },
        },
      })
    },
  })
  assert.equal(typeof handler, 'function')

  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const page = await fetch(`${base}/blackbox/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /agent-blackbox|黑匣|会话/)
    const live = await (await fetch(`${base}/blackbox/api/live`)).json()
    assert.equal(typeof live.eventCount, 'number')
  } finally {
    server.close()
  }
})
