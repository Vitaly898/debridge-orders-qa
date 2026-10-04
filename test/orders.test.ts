import test from 'node:test';
import assert from 'node:assert/strict';
import { DebridgeApi } from '../src/api.js';
import { findValuePaths, walletValidator } from '../src/validators.js';
import { runOrders } from '../src/runner.js';
import type { OrdersApi, OrderSummary } from '../src/types.js';

const wallet = 'BUnGokFzA1wu8vb6adHfyhnNvCxaVt6QyPNmmUNWPwET';
const summary = (id: number): OrderSummary => ({ orderId: { stringValue: `order-${id}` }, tradeType: 'CrossChain' });
const checks = [walletValidator(wallet)];
const noDelay = { detailDelayMs: 0 };

test('finds all exact values across nested objects and arrays, ignores keys, substrings, case and null', () => {
  const data = { receiverDst: { stringValue: wallet }, nested: [null, { authority: wallet }],
    [wallet]: 'irrelevant', substring: `prefix${wallet}`, lowercase: wallet.toLowerCase(), number: 1 };
  assert.deepEqual(findValuePaths(data, wallet), ['$.receiverDst.stringValue', '$.nested[1].authority']);
  assert.equal(walletValidator(wallet).validate({}).passed, false);
});

test('paginates filtered HTTP requests and fetches every detail separately', async () => {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      const skip = body.skip as number;
      return Response.json({ orders: Array.from({ length: Math.min(25, 27 - skip) }, (_, i) => summary(skip + i)), totalCount: 27 });
    }
    calls.push({ url });
    return Response.json({ orderId: { stringValue: url.split('/').at(-1) }, receiverDst: { stringValue: wallet } });
  };
  const report = await runOrders(new DebridgeApi('https://example.test', fetcher), { filter: wallet, filterMode: 'Mixed' }, checks, noDelay);
  assert.equal(report.passed, true);
  assert.equal(report.orders.length, 27);
  assert.deepEqual(calls.filter(call => call.body).map(call => call.body), [
    { filter: wallet, filterMode: 'Mixed', skip: 0, take: 25 },
    { filter: wallet, filterMode: 'Mixed', skip: 25, take: 25 },
  ]);
  assert.equal(calls.filter(call => !call.body).length, 27);
});

test('detail errors and missing wallet fail but do not stop remaining orders', async () => {
  const api: OrdersApi = {
    list: async () => ({ orders: [summary(1), summary(2), summary(3)], totalCount: 3 }),
    details: async order => {
      if (order.orderId.stringValue === 'order-1') throw new Error('HTTP failure');
      return order.orderId.stringValue === 'order-2' ? {} : { address: wallet };
    },
  };
  const report = await runOrders(api, {}, checks, noDelay);
  assert.equal(report.complete, true);
  assert.equal(report.passed, false);
  assert.deepEqual(report.orders.map(order => order.passed), [false, false, true]);
});

test('empty and deliberately limited runs are not passes', async () => {
  const empty: OrdersApi = { list: async () => ({ orders: [], totalCount: 0 }), details: async () => ({}) };
  assert.equal((await runOrders(empty, {}, checks)).passed, false);
  const api: OrdersApi = {
    list: async () => ({ orders: Array.from({ length: 25 }, (_, i) => summary(i)), totalCount: 26 }),
    details: async () => ({ address: wallet }),
  };
  const report = await runOrders(api, {}, checks, { ...noDelay, maxPages: 1 });
  assert.equal(report.complete, false);
  assert.equal(report.passed, false);
});

test('repeated pages and inconsistent short pages are detected', async () => {
  const api: OrdersApi = {
    list: async () => ({ orders: [summary(1)], totalCount: 2 }),
    details: async () => ({ address: wallet }),
  };
  const repeated = await runOrders(api, {}, checks, { ...noDelay, pageSize: 1 });
  assert.match(repeated.errors[0] ?? '', /Duplicate/);
  const short = await runOrders(api, {}, checks, noDelay);
  assert.match(short.errors[0] ?? '', /Short page/);
});

test('changing totals cannot produce a successful stable snapshot', async () => {
  const api: OrdersApi = {
    list: async (_, skip) => ({ orders: [summary(skip)], totalCount: skip === 0 ? 2 : 1 }),
    details: async () => ({ wallet }),
  };
  const report = await runOrders(api, {}, checks, { ...noDelay, pageSize: 1 });
  assert.equal(report.totalCountChanged, true);
  assert.equal(report.passed, false);
});

test('rejects malformed lists and mismatched detail IDs', async () => {
  const malformed = new DebridgeApi('https://example.test', async () => Response.json({ orders: null, totalCount: 1 }), 1000, async () => {});
  await assert.rejects(malformed.list({}, 0, 25), /Invalid list/);
  const mismatch = new DebridgeApi('https://example.test', async () => Response.json({ orderId: { stringValue: 'wrong' }, wallet }));
  await assert.rejects(mismatch.details(summary(1)), /does not match/);
});

test('Mixed results route each type to its own endpoint and validate both wallets', async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (init?.method === 'POST') return Response.json({
      orders: [summary(1), { orderId: { stringValue: 'swap/2' }, tradeType: 'SameChain' }], totalCount: 2,
    });
    if (url.includes('/SameChainSwap/')) return Response.json({
      swapId: { stringValue: 'swap/2' },
      sender: { stringValue: wallet }, recipient: { stringValue: wallet },
    });
    return Response.json({ orderId: { stringValue: 'order-1' }, receiverDst: { stringValue: wallet } });
  };
  const report = await runOrders(new DebridgeApi('https://example.test', fetcher), { filter: wallet, filterMode: 'Mixed' }, checks, noDelay);
  assert.equal(report.passed, true);
  assert.deepEqual(requested, [
    'https://example.test/api/Orders/filteredList',
    'https://example.test/api/Orders/order-1',
    'https://example.test/api/SameChainSwap/swap%2F2',
  ]);
  assert.deepEqual(report.orders[1]?.checks[0]?.matches, ['$.sender.stringValue', '$.recipient.stringValue']);
});

test('same-chain details must contain the matching swapId, not orderId', async () => {
  const order: OrderSummary = { orderId: { stringValue: 'swap-1' }, tradeType: 'SameChain' };
  for (const data of [null, {}, { swapId: { stringValue: 'other' } }, { orderId: { stringValue: 'swap-1' } }]) {
    const api = new DebridgeApi('https://example.test', async () => Response.json(data));
    await assert.rejects(api.details(order), /swapId does not match/);
  }
});

test('list retries errors up to three attempts with fixed 10s pauses', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const api = new DebridgeApi('https://example.test', async () => {
    attempts++;
    return attempts < 3 ? new Response('limited', { status: 429 }) : Response.json({ orders: [], totalCount: 0 });
  }, 1000, async ms => { delays.push(ms); });
  await api.list({}, 0, 25);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10_000, 10_000]);
});

test('list stops after third failure; details never retry', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const api = new DebridgeApi('https://example.test', async () => {
    attempts++;
    return new Response('error', { status: 500 });
  }, 1000, async ms => { delays.push(ms); });
  await assert.rejects(api.list({}, 0, 25), /HTTP 500/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10_000, 10_000]);
  attempts = 0;
  delays.length = 0;
  await assert.rejects(api.details(summary(1)), /HTTP 500/);
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('successful list returns immediately without pauses or duplicate requests', async () => {
  let attempts = 0;
  const api = new DebridgeApi('https://example.test', async () => {
    attempts++;
    return Response.json({ orders: [], totalCount: 0 });
  }, 1000, async () => { assert.fail('Unexpected pause'); });
  await api.list({}, 0, 25);
  assert.equal(attempts, 1);
});

test('pauses between detail requests across pages and emits progress immediately', async () => {
  const events: string[] = [];
  const api: OrdersApi = {
    list: async (_, skip) => ({ orders: [summary(skip)], totalCount: 3 }),
    details: async order => {
      events.push(`details:${order.orderId.stringValue}`);
      if (order.orderId.stringValue === 'order-1') throw new Error('429');
      return { wallet };
    },
  };
  const report = await runOrders(api, {}, checks, {
    pageSize: 1,
    pause: async ms => { events.push(`pause:${ms}`); },
    onPage: page => { events.push(`page:${page}`); },
    onOrder: order => { events.push(order.error ? 'ERROR' : 'PASS'); },
  });
  assert.deepEqual(events, [
    'page:1', 'details:order-0', 'PASS',
    'page:2', 'pause:1000', 'details:order-1', 'ERROR',
    'page:3', 'pause:1000', 'details:order-2', 'PASS',
  ]);
  assert.equal(report.complete, true);
  assert.equal(report.passed, false);
});
