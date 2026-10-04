import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DebridgeApi } from './api.js';
import { runOrders } from './runner.js';
import { walletValidator } from './validators.js';
import type { OrderFilters } from './types.js';

const DEFAULT_WALLET = 'BUnGokFzA1wu8vb6adHfyhnNvCxaVt6QyPNmmUNWPwET';
async function main() {
  const { values } = parseArgs({ options: {
    wallet: { type: 'string', default: DEFAULT_WALLET },
    'base-url': { type: 'string', default: 'https://stats-api.dln.trade' },
    filters: { type: 'string' },
    'max-pages': { type: 'string' },
    output: { type: 'string', default: 'reports/orders.json' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: npm start -- [--wallet ADDRESS] [--base-url URL] [--filters FILE.json] [--max-pages N] [--output FILE.json]\nAll pages are checked by default, 25 orders per page. A partial or empty run is not a pass.');
    return;
  }
  let extra: OrderFilters = {};
  if (values.filters) {
    const parsed: unknown = JSON.parse(await readFile(values.filters, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Filters file must contain an object');
    const allowed = new Set(['filter', 'giveChainIds', 'takeChainIds', 'orderStates', 'blockTimestampFrom', 'blockTimestampTo', 'maker', 'creator', 'fulfiller', 'unlockAuthorities', 'referralCode', 'orderAuthorityInSourceChain', 'orderAuthorityInDestinationChain', 'orderTradeType', 'filterMode']);
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.has(key)) throw new Error(`Unknown filter: ${key}`);
      if (['giveChainIds', 'takeChainIds'].includes(key)) {
        if (!Array.isArray(value) || !value.every(item => Number.isSafeInteger(item) && item >= 0)) throw new Error(`Invalid ${key}`);
      } else if (key === 'orderStates') {
        const states = ['None', 'Created', 'Fulfilled', 'SentUnlock', 'OrderCancelled', 'SentOrderCancel', 'ClaimedUnlock', 'ClaimedOrderCancel'];
        if (!Array.isArray(value) || !value.every(item => states.includes(item))) throw new Error('Invalid orderStates');
      } else if (['blockTimestampFrom', 'blockTimestampTo', 'referralCode'].includes(key)) {
        if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${key}`);
      } else if (typeof value !== 'string') throw new Error(`Invalid ${key}: expected string`);
      if (key === 'filterMode' && !['CrossChain', 'SameChain', 'Mixed'].includes(value as string)) throw new Error('Invalid filterMode');
      if (key === 'orderTradeType' && !['None', 'Market', 'Limit'].includes(value as string)) throw new Error('Invalid orderTradeType');
    }
    extra = parsed as OrderFilters;
    if (extra.filter !== undefined && extra.filter !== values.wallet) throw new Error('filter must equal --wallet');
    if (extra.blockTimestampFrom !== undefined && extra.blockTimestampTo !== undefined && extra.blockTimestampFrom > extra.blockTimestampTo) throw new Error('Invalid date range');
  }
  const filters: OrderFilters = { giveChainIds: [], takeChainIds: [], filterMode: 'Mixed', ...extra, filter: values.wallet };
  const limits = values['max-pages'] === undefined ? {} : { maxPages: Number(values['max-pages']) };
  const report = await runOrders(new DebridgeApi(values['base-url']), filters, [walletValidator(values.wallet)], {
    ...limits,
    onPage: (page, count) => console.log(`Страница ${page}: получено ${count} заказов`),
    onOrder: order => {
      if (order.error !== undefined) console.log(`ERROR ${order.orderId}: ${order.error}`);
      else if (order.passed) console.log(`PASS ${order.orderId}: ${order.checks.flatMap(check => check.matches).join(', ')}`);
      else console.log(`FAIL ${order.orderId}: ${order.checks.filter(check => !check.passed).map(check => check.message).join('; ')}`);
    },
  });
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  const passed = report.orders.filter(order => order.passed).length;
  const errors = report.orders.filter(order => order.error !== undefined).length;
  const failed = report.orders.length - passed - errors;
  console.log(`\nИтог:\nУспешно проверено: ${passed}\nНе прошли проверку: ${failed}\nОшибки проверки/получения деталей: ${errors}\nПолучено страниц: ${report.pagesFetched}\nОбход завершён: ${report.complete ? 'да' : 'нет'}`);
  for (const error of report.errors) console.error(error);
  if (!report.orders.length) console.error('No orders checked; wallet validation is inconclusive.');
  if (!report.complete) console.error('Run incomplete; see report.');
  console.log(`Report: ${values.output}`);
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
