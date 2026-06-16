import { roundKrw } from "../../../../packages/shared/src";
import type { BithumbPrivateClient } from "../bithumb/bithumb-client";
import type { PriceQuote } from "../bithumb/bithumb-client";

export interface AccountCapitalSnapshot {
  market: string;
  currency: string;
  assetCurrency: string;
  totalCapitalKrw: number;
  krwBalance: number;
  krwLocked: number;
  assetBalance: number;
  assetLocked: number;
  assetPriceKrw: number;
  assetValueKrw: number;
  evaluatedAt: string;
}

export async function loadAccountCapitalSnapshot(params: {
  client: BithumbPrivateClient;
  market: string;
  quote: PriceQuote;
}): Promise<AccountCapitalSnapshot> {
  const [currency, assetCurrency] = params.market.split("-");
  if (currency !== "KRW" || !assetCurrency) {
    throw new Error(`Account capital valuation only supports KRW markets. Received: ${params.market}`);
  }

  const accounts = await params.client.getAccounts();
  const krwAccount = findAccount(accounts, "KRW");
  const assetAccount = findAccount(accounts, assetCurrency);
  const krwBalance = krwAccount?.balance ?? 0;
  const krwLocked = krwAccount?.locked ?? 0;
  const assetBalance = assetAccount?.balance ?? 0;
  const assetLocked = assetAccount?.locked ?? 0;
  const assetQty = assetBalance + assetLocked;
  const assetValueKrw = roundKrw(assetQty * params.quote.tradePrice);
  const totalCapitalKrw = roundKrw(krwBalance + krwLocked + assetValueKrw);

  return {
    market: params.market,
    currency,
    assetCurrency,
    totalCapitalKrw,
    krwBalance: roundKrw(krwBalance),
    krwLocked: roundKrw(krwLocked),
    assetBalance,
    assetLocked,
    assetPriceKrw: params.quote.tradePrice,
    assetValueKrw,
    evaluatedAt: new Date().toISOString(),
  };
}

function findAccount(
  accounts: Awaited<ReturnType<BithumbPrivateClient["getAccounts"]>>,
  currency: string,
) {
  return accounts.find((account) => account.currency.toUpperCase() === currency.toUpperCase());
}
