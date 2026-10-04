import type { OrderFilters, OrdersApi, ValidationResult, Validator } from './types.js';

export interface OrderResult {
  orderId: string;
  tradeType: string;
  passed: boolean;
  checks: ValidationResult[];
  error?: string;
}
export interface Report {
  startedAt: string;
  finishedAt: string;
  filters: OrderFilters;
  pageSize: number;
  pagesFetched: number;
  initialTotalCount: number | null;
  totalCountChanged: boolean;
  complete: boolean;
  passed: boolean;
  orders: OrderResult[];
  errors: string[];
}

export async function runOrders(
  api: OrdersApi,
  filters: OrderFilters,
  validators: Validator[],
  options: {
    pageSize?: number;
    maxPages?: number;
    detailDelayMs?: number;
    pause?: (ms: number) => Promise<void>;
    onPage?: (page: number, count: number) => void;
    onOrder?: (result: OrderResult) => void;
  } = {},
): Promise<Report> {
  const pageSize = options.pageSize ?? 25;
  const detailDelayMs = options.detailDelayMs ?? 1000;
  if (!Number.isSafeInteger(detailDelayMs) || detailDelayMs < 0) throw new Error('detailDelayMs must be nonnegative');
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let detailRequested = false;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('pageSize must be 1–100');
  if (options.maxPages !== undefined && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1)) throw new Error('maxPages must be positive');
  if (!validators.length) throw new Error('At least one validator is required');
  const report: Report = {
    startedAt: new Date().toISOString(), finishedAt: '', filters: { ...filters }, pageSize,
    pagesFetched: 0, initialTotalCount: null, totalCountChanged: false,
    complete: false, passed: false, orders: [], errors: [],
  };
  const seen = new Set<string>();
  try {
    for (let skip = 0; ; skip += pageSize) {
      const page = await api.list(filters, skip, pageSize);
      report.pagesFetched++;
      options.onPage?.(report.pagesFetched, page.orders.length);
      report.initialTotalCount ??= page.totalCount;
      if (report.initialTotalCount !== page.totalCount) report.totalCountChanged = true;
      if (page.orders.length > pageSize) throw new Error('API returned more orders than requested');
      if (!page.orders.length) {
        if (skip < page.totalCount) throw new Error('Empty page before advertised totalCount');
        report.complete = true;
        break;
      }
      for (const order of page.orders) {
        const orderId = order.orderId.stringValue;
        if (seen.has(orderId)) throw new Error(`Duplicate order across pagination: ${orderId}; restart with a stable date range`);
        seen.add(orderId);
        const result: OrderResult = { orderId, tradeType: order.tradeType, passed: false, checks: [] };
        try {
          if (detailRequested && detailDelayMs > 0) await pause(detailDelayMs);
          detailRequested = true;
          const details = await api.details(order);
          result.checks = validators.map(validator => validator.validate(details));
          result.passed = result.checks.every(check => check.passed);
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
        }
        report.orders.push(result);
        options.onOrder?.(result);
      }
      if (skip + page.orders.length >= page.totalCount) {
        report.complete = true;
        break;
      }
      if (page.orders.length < pageSize) throw new Error('Short page before advertised totalCount');
      if (options.maxPages !== undefined && report.pagesFetched >= options.maxPages) break;
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  if (report.totalCountChanged) report.errors.push('totalCount changed during pagination; a full stable snapshot cannot be confirmed');
  report.finishedAt = new Date().toISOString();
  report.passed = report.complete && report.orders.length > 0 && report.errors.length === 0 && report.orders.every(order => order.passed);
  return report;
}
