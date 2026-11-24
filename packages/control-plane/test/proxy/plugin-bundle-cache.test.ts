/**
 * Plugin-bundle cache policy on the desktop leg (control-plane instance proxy).
 *
 * The upstream Electron document handler rewrites `/plugins/**` responses to
 * `cache-control: no-store` (apps/desktop/src/web-document.ts:71,97): the Host
 * marks plugin bundles immutable under a per-process revision, so a browser
 * cache could only accumulate bundles no later launch can reuse. The Swift
 * shell serves the same page over the control-plane origin, so the instance
 * proxy must mirror the policy through the generic
 * ProxyForwardDeps.onUpstreamResponseHeaders seam -- without touching
 * proxy-forward.ts. Same width as the upstream predicate (/^\/plugins\//u):
 * only the '/plugins/' prefix is rewritten; the bare '/plugins' route and every
 * other path keep the upstream's own cache metadata.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeHttpRequest, fakeRequest, fakeResponse, proxyFor } from '../support/proxy-fakes.ts'

/** Upstream reply whose cache metadata is what a plugin bundle carries. */
const immutableReply = () => ({
  response: {
    status: 200,
    headers: {
      'content-type': 'text/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: 'export default 1',
  },
})

test('desktop leg: proxied /plugins/ responses are forced cache-control no-store', async () => {
  const upstream = fakeHttpRequest(immutableReply)
  const proxy = proxyFor(upstream.fn)
  // The real extra-bundle URL shape: the instance prefix is stripped by
  // parseInstancePath, leaving the resolved `/plugins/` pathname plus the
  // `??`-query bundle key (serveBundle keys pathname+search).
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/plugins/??client.js', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.pathname, '/plugins/', 'the resolved upstream pathname is the plugin namespace')
})

test('desktop leg: the bare /plugins route keeps the upstream cache metadata (predicate width parity)', async () => {
  // Upstream PLUGIN_BUNDLE_PATH is /^\/plugins\//u: the bare '/plugins' route is
  // not a plugin-bundle response and must keep its own cache metadata, exactly
  // like every other non-plugin path. Keep the mirror at the same width.
  const upstream = fakeHttpRequest(immutableReply)
  const proxy = proxyFor(upstream.fn)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/plugins', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
})

test('desktop leg: non-plugin responses keep the upstream cache metadata untouched', async () => {
  const upstream = fakeHttpRequest(immutableReply)
  const proxy = proxyFor(upstream.fn)
  const asset = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/assets/index-BKQ_L1z6.js', 'GET'), asset)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')

  // Prefix boundary: a sibling path that merely starts with 'plugins' is not
  // the plugin namespace and must not be rewritten.
  const sibling = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/plugins-extra/index.js', 'GET'), sibling)
  assert.equal(sibling.status, 200)
  assert.equal(sibling.headers['cache-control'], 'public, max-age=31536000, immutable')
})

test('desktop leg: remote dsh transports get the same plugin cache policy', async () => {
  const upstream = fakeHttpRequest(immutableReply)
  const proxy = proxyFor(upstream.fn)
  proxy.registerTransport('dsh:remote', 'http://127.0.0.1:22011')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-remote/plugins/??bundle.js', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(upstream.calls[0].url.pathname, '/plugins/')
})

test('desktop leg: a plugin response without upstream cache metadata still gets no-store', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'text/javascript' }, body: 'export default 2' },
  }))
  const proxy = proxyFor(upstream.fn)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/plugins/??client.js', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('desktop leg: HEAD /plugins/ responses are forced no-store too', async () => {
  // The upstream rewrite runs on every method (it is a response-header policy,
  // not a GET-only path), so a HEAD probe must not be able to cache the bundle.
  const upstream = fakeHttpRequest(immutableReply)
  const proxy = proxyFor(upstream.fn)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/plugins/??client.js', 'HEAD'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('desktop leg: non-2xx /plugins/ responses are still forced no-store', async () => {
  // A 404 from the plugin namespace can still carry stale immutable metadata
  // from the upstream edge; the upstream predicate keys only on the pathname, so
  // the mirror must not narrow it to 200 responses.
  const upstream = fakeHttpRequest(() => ({
    response: {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: 'missing bundle',
    },
  }))
  const proxy = proxyFor(upstream.fn)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/plugins/??missing.js', 'GET'), res)
  assert.equal(res.status, 404)
  assert.equal(res.headers['cache-control'], 'no-store')
})
