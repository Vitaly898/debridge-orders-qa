export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type FilterMode = 'CrossChain' | 'SameChain' | 'Mixed';
export type OrderState = 'None' | 'Created' | 'Fulfilled' | 'SentUnlock' | 'OrderCancelled' | 'SentOrderCancel' | 'ClaimedUnlock' | 'ClaimedOrderCancel';

/** API request fields; pagination is supplied separately by the runner. */
export interface OrderFilters {
  filter?: string;
  giveChainIds?: number[];
  takeChainIds?: number[];
  orderStates?: OrderState[];
  blockTimestampFrom?: number;
  blockTimestampTo?: number;
  maker?: string;
  creator?: string;
  fulfiller?: string;
  unlockAuthorities?: string;
  referralCode?: number;
  orderAuthorityInSourceChain?: string;
  orderAuthorityInDestinationChain?: string;
  orderTradeType?: 'None' | 'Market' | 'Limit';
  filterMode?: FilterMode;
}
export interface OrderSummary {
  orderId: { stringValue: string };
  tradeType: 'CrossChain' | 'SameChain';
}
export interface OrderPage { orders: OrderSummary[]; totalCount: number }
export interface OrdersApi {
  list(filters: OrderFilters, skip: number, take: number): Promise<OrderPage>;
  details(order: OrderSummary): Promise<Json>;
}
export interface ValidationResult {
  name: string;
  passed: boolean;
  matches: string[];
  message: string;
}
export interface Validator {
  name: string;
  validate(details: Json): ValidationResult;
}
