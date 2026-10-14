import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { format, subDays } from 'date-fns';
import { z } from 'zod';
import { env } from '~/env';
import { db } from '~/server/db';
import type { TransactionOutput, TransactionOutputItem } from '~/types/bank.types';

const LUNCHFLOW_CONSTANTS = {
  BASE_URL: 'https://lunchflow.app/api/v1',
  DEFAULT_INTERVAL_DAYS: 30,
  DATE_FORMAT: 'yyyy-MM-dd',
  CACHE_TTL_MS: 24 * 60 * 60 * 1000,
} as const;

const ERROR_MESSAGES = {
  FAILED_FETCH_CACHED: 'Failed to fetch cached transactions',
  FAILED_FETCH_ACCOUNTS: 'Failed to fetch Lunch Flow accounts',
  FAILED_FETCH_TRANSACTIONS: 'Failed to fetch transactions',
} as const;

const AccountsResponse = z.object({
  accounts: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      name: z.string().nullish(),
      institution_name: z.string().nullish(),
    }),
  ),
});

const TransactionsResponse = z.object({
  transactions: z.array(
    z.object({
      // Lunch Flow returns null ids for some transactions (see `withStableIds`).
      id: z.string().nullish(),
      amount: z.number(),
      currency: z.string(),
      date: z.string(),
      merchant: z.string().nullish(),
      description: z.string().nullish(),
      isPending: z.boolean(),
    }),
  ),
});

type LunchFlowTransaction = z.infer<typeof TransactionsResponse>['transactions'][number];
type LunchFlowAccount = z.infer<typeof AccountsResponse>['accounts'][number];
type WithAccountName = Omit<LunchFlowTransaction, 'id'> & { id: string; accountName?: string };

/**
 * Lunch Flow personal API. The API key belongs to a single Lunch Flow user, so the connection is
 * instance-wide: every Split Pro user who connects sees the accounts behind `LUNCHFLOW_API_KEY`.
 */
export class LunchFlowService {
  private async get<T extends z.ZodTypeAny>(path: string, schema: T, errorMessage: string) {
    const response = await fetch(`${LUNCHFLOW_CONSTANTS.BASE_URL}${path}`, {
      headers: { 'x-api-key': env.LUNCHFLOW_API_KEY ?? '' },
    });

    if (!response.ok) {
      console.error('Lunch Flow request failed', path, response.status);
      if (401 === response.status || 403 === response.status) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid Lunch Flow API key' });
      }
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: errorMessage });
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      console.error('Unexpected Lunch Flow response', path, parsed.error);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: errorMessage });
    }

    return parsed.data as z.infer<T>;
  }

  returnTransactionFilters() {
    const intervalInDays =
      env.LUNCHFLOW_INTERVAL_IN_DAYS ?? LUNCHFLOW_CONSTANTS.DEFAULT_INTERVAL_DAYS;

    return new URLSearchParams({
      from: format(subDays(new Date(), intervalInDays), LUNCHFLOW_CONSTANTS.DATE_FORMAT),
      to: format(new Date(), LUNCHFLOW_CONSTANTS.DATE_FORMAT),
      include_pending: 'true',
    });
  }

  async getTransactions(userId: number, cacheKey?: string) {
    if (!cacheKey) {
      return;
    }

    const cachedData = await db.cachedBankData.findUnique({
      where: { obapiProviderId: cacheKey, userId },
    });

    if (cachedData) {
      if (!cachedData.data) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: ERROR_MESSAGES.FAILED_FETCH_CACHED,
        });
      }

      if (cachedData.lastFetched > new Date(Date.now() - LUNCHFLOW_CONSTANTS.CACHE_TTL_MS)) {
        return JSON.parse(cachedData.data) as TransactionOutput;
      }
    }

    const { accounts } = await this.get(
      '/accounts',
      AccountsResponse,
      ERROR_MESSAGES.FAILED_FETCH_ACCOUNTS,
    );

    const filters = this.returnTransactionFilters().toString();
    const responses = await Promise.all(
      accounts.map(async (account) => {
        const { transactions } = await this.get(
          `/accounts/${account.id}/transactions?${filters}`,
          TransactionsResponse,
          ERROR_MESSAGES.FAILED_FETCH_TRANSACTIONS,
        );
        const accountName = this.accountLabel(account);

        return this.withStableIds(account, transactions).map((transaction) => ({
          ...transaction,
          accountName,
        }));
      }),
    );

    const formattedTransactions = this.formatTransactions(responses.flat());

    await db.cachedBankData.upsert({
      where: { obapiProviderId: cacheKey, userId },
      create: {
        obapiProviderId: cacheKey,
        data: JSON.stringify(formattedTransactions),
        lastFetched: new Date(),
        user: { connect: { id: userId } },
      },
      update: {
        data: JSON.stringify(formattedTransactions),
        lastFetched: new Date(),
      },
    });

    return formattedTransactions;
  }

  /** There is no OAuth/redirect flow: the connection lives in the Lunch Flow dashboard. */
  async connectToBank(userId?: string) {
    // Ensure the key is valid before marking the user as connected.
    await this.get('/accounts', AccountsResponse, ERROR_MESSAGES.FAILED_FETCH_ACCOUNTS);

    return { institutionId: LunchFlowService.cacheKey(userId), authLink: '' };
  }

  getInstitutions() {
    return Promise.resolve([]);
  }

  /** `CachedBankData.obapiProviderId` is globally unique, so scope it per user. */
  static cacheKey(userId?: string | number) {
    return `lunchflow-${userId ?? ''}`;
  }

  /**
   * Transaction ids drive the "already added" check and row selection, so ones Lunch Flow leaves
   * null get a deterministic id derived from the transaction's contents (plus an occurrence index
   * to keep otherwise identical rows apart).
   */
  private withStableIds(account: LunchFlowAccount, transactions: LunchFlowTransaction[]) {
    const seen = new Map<string, number>();

    return transactions.map((transaction) => {
      if (transaction.id) {
        return { ...transaction, id: transaction.id };
      }

      const hash = createHash('sha256')
        .update(
          [
            account.id,
            transaction.date,
            transaction.amount,
            transaction.currency,
            transaction.description,
            transaction.merchant,
          ].join('|'),
        )
        .digest('hex')
        .slice(0, 16);
      const occurrence = seen.get(hash) ?? 0;
      seen.set(hash, occurrence + 1);

      return { ...transaction, id: `lf-${hash}-${occurrence}` };
    });
  }

  private accountLabel(account: LunchFlowAccount) {
    return [account.institution_name, account.name].filter(Boolean).join(' · ') || undefined;
  }

  private formatTransaction(transaction: WithAccountName): TransactionOutputItem {
    return {
      transactionId: transaction.id,
      bookingDate: transaction.date,
      description: transaction.description || transaction.merchant || '?',
      merchant: transaction.merchant || undefined,
      accountName: transaction.accountName,
      transactionAmount: {
        amount: transaction.amount.toString(),
        currency: transaction.currency,
      },
    };
  }

  private formatTransactions(transactions: WithAccountName[]): TransactionOutput {
    return {
      transactions: {
        booked: transactions.filter((t) => !t.isPending).map((t) => this.formatTransaction(t)),
        pending: transactions.filter((t) => t.isPending).map((t) => this.formatTransaction(t)),
      },
    };
  }
}
