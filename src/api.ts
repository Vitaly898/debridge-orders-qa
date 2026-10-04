import type { Json, OrderFilters, OrderPage, OrderSummary, OrdersApi } from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class ApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export class DebridgeApi implements OrdersApi {
  private readonly baseUrl: string;
  constructor(
    baseUrl = 'https://stats-api.dln.trade',
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
    private readonly pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API URL must use HTTP or HTTPS');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new ApiError(`${init.method ?? 'GET'} ${path}: HTTP ${response.status}: ${body}`, response.status);
    }
    try { return await response.json(); }
    catch { throw new ApiError(`${path}: response is not valid JSON`); }
  }

  async list(filters: OrderFilters, skip: number, take: number): Promise<OrderPage> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.listOnce(filters, skip, take);
      } catch (error) {
        console.error(`List page skip=${skip}, attempt ${attempt}/3: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt === 3) throw error;
        console.error('Retrying list request in 10s');
        await this.pause(10_000);
      }
    }
    throw new Error('Unreachable');
  }

  private async listOnce(filters: OrderFilters, skip: number, take: number): Promise<OrderPage> {
    const data = await this.request('/api/Orders/filteredList', {
      method: 'POST',
      headers: { 'content-type': 'application/json-patch+json' },
      body: JSON.stringify({ ...filters, skip, take }),
    });
    if (!object(data) || !Array.isArray(data.orders) ||
        !Number.isSafeInteger(data.totalCount) || (data.totalCount as number) < 0) {
      throw new ApiError('Invalid list response: expected orders array and nonnegative totalCount');
    }
    const orders: OrderSummary[] = data.orders.map((item: unknown) => {
      if (!object(item) || !object(item.orderId) || typeof item.orderId.stringValue !== 'string' ||
          !item.orderId.stringValue || !['CrossChain', 'SameChain'].includes(String(item.tradeType))) {
        throw new ApiError('Invalid order summary: expected orderId.stringValue and supported tradeType');
      }
      return { orderId: { stringValue: item.orderId.stringValue }, tradeType: item.tradeType as OrderSummary['tradeType'] };
    });
    return { orders, totalCount: data.totalCount as number };
  }

  async details(order: OrderSummary): Promise<Json> {
    const routes = {
      CrossChain: { resource: 'Orders', idField: 'orderId' },
      SameChain: { resource: 'SameChainSwap', idField: 'swapId' },
    } as const;
    const route = routes[order.tradeType];
    if (!route) throw new ApiError(`Unsupported trade type: ${order.tradeType}`);

    const id = order.orderId.stringValue;
    const data = await this.request(`/api/${route.resource}/${encodeURIComponent(id)}`);
    const returnedId = object(data) ? data[route.idField] : undefined;
    if (!object(returnedId) || returnedId.stringValue !== id) {
      throw new ApiError(`Invalid details response: ${route.idField} does not match requested order`);
    }
    return data as Json;
  }
}
