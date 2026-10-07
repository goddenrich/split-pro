import { useTranslation } from 'next-i18next';
import React, { useCallback } from 'react';
import { toast } from 'sonner';
import { BankAccountSelect } from './BankAccountSelect';
import { PlaidLink } from './PlaidLink';
import { api } from '~/utils/api';
import type { ButtonProps } from '~/components/ui/button';

interface BankConnectionProps {
  bankConnectionEnabled: boolean;
  bankConnection: string | null;
  children: React.ReactElement<ButtonProps>;
}

export const BankConnection: React.FC<BankConnectionProps> = ({
  bankConnectionEnabled,
  bankConnection,
  children,
}) => {
  const { t } = useTranslation();
  const userQuery = api.user.me.useQuery();
  const connectToBank = api.bankTransactions.connectToBank.useMutation();

  const fetchUser = useCallback(() => {
    userQuery.refetch().catch(console.error);
  }, [userQuery]);

  const onConnectToBank = useCallback(async () => {
    if (bankConnection === 'GOCARDLESS') {
      if (!userQuery.data?.bankingId) {
        return;
      }
      const res = await connectToBank.mutateAsync(userQuery.data.bankingId).catch(console.error);
      if (res?.authLink) {
        window.location.href = res.authLink;
      }
    } else if (bankConnection === 'LUNCHFLOW') {
      try {
        await connectToBank.mutateAsync();
        toast.success(t('bank_transactions.lunchflow.connected_successfully'));
        fetchUser();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'An unexpected error occurred');
      }
    } else if (bankConnection === 'PLAID') {
      const res = await connectToBank.mutateAsync().catch(console.error);
      if (res?.authLink) {
        return res.authLink;
      }
    }
  }, [connectToBank, userQuery.data?.bankingId, bankConnection, fetchUser, t]);

  if (!bankConnectionEnabled) {
    return null;
  }

  return (
    <>
      {bankConnection === 'GOCARDLESS' && (
        <BankAccountSelect bankConnectionEnabled={bankConnectionEnabled} />
      )}

      {'LUNCHFLOW' === bankConnection ? (
        React.cloneElement(children, { onClick: onConnectToBank } as Partial<ButtonProps>)
      ) : bankConnection === 'PLAID' ? (
        <PlaidLink onConnect={onConnectToBank} onSuccess={fetchUser}>
          {children}
        </PlaidLink>
      ) : (
        bankConnection === 'GOCARDLESS' &&
        userQuery.data?.bankingId &&
        React.cloneElement(children, { onClick: onConnectToBank } as Partial<ButtonProps>)
      )}
    </>
  );
};
