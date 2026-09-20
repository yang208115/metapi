import { useState, useMemo } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';
import type { RouteCandidateView, RouteAccountOption } from '../helpers/routeModelCandidatesIndex.js';

type ChannelSelection = {
  accountId: number;
};

type AddChannelModalProps = {
  open: boolean;
  onClose: () => void;
  routeId: number;
  routeTitle: string;
  candidateView: RouteCandidateView;
  onSuccess: () => void;
  existingChannelAccountIds?: Set<number>;
};

export default function AddChannelModal({
  open,
  onClose,
  routeId,
  routeTitle,
  candidateView,
  onSuccess,
  existingChannelAccountIds,
}: AddChannelModalProps) {
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<Record<number, ChannelSelection>>({});
  const [submitting, setSubmitting] = useState(false);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return candidateView.accountOptions;
    return candidateView.accountOptions.filter((option) =>
      option.label.toLowerCase().includes(q),
    );
  }, [candidateView.accountOptions, searchQuery]);

  const selectedCount = Object.keys(selectedAccounts).length;

  const toggleAccount = (account: RouteAccountOption) => {
    setSelectedAccounts((prev) => {
      if (prev[account.id]) {
        const next = { ...prev };
        delete next[account.id];
        return next;
      }
      return {
        ...prev,
        [account.id]: {
          accountId: account.id,
        },
      };
    });
  };

  const handleSubmit = async () => {
    const channels = Object.values(selectedAccounts);
    if (channels.length === 0) return;

    setSubmitting(true);
    try {
      const result = await api.batchAddChannels(routeId, channels);
      const msg = `已添加 ${result.created} 个通道` +
        (result.skipped > 0 ? `，跳过 ${result.skipped} 个重复` : '') +
        (result.errors.length > 0 ? `，${result.errors.length} 个错误` : '');
      toast.success(msg);
      setSelectedAccounts({});
      setSearchQuery('');
      onSuccess();
      onClose();
    } catch (e: any) {
      toast.error(e.message || '批量添加通道失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setSelectedAccounts({});
      setSearchQuery('');
      onClose();
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={handleClose}
      title={`${tr('添加通道')} - ${routeTitle}`}
      maxWidth={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {tr('已选')} {selectedCount} {tr('个通道')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={handleClose} disabled={submitting}>
              {tr('取消')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting || selectedCount === 0}
            >
              {submitting ? (
                <><span className="spinner spinner-sm" /> {tr('添加中...')}</>
              ) : (
                `${tr('批量添加')} (${selectedCount})`
              )}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="toolbar-search" style={{ width: '100%' }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr('搜索账号...')}
          />
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filteredAccounts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '12px 0', textAlign: 'center' }}>
              {candidateView.accountOptions.length === 0
                ? tr('当前没有支持此模型的可用账号')
                : tr('没有匹配的账号')}
            </div>
          ) : (
            <>
              {filteredAccounts.map((account) => {
                const isSelected = !!selectedAccounts[account.id];
                const isExisting = existingChannelAccountIds?.has(account.id);

                return (
                  <div
                    key={account.id}
                    onClick={() => toggleAccount(account)}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: isSelected ? 'color-mix(in srgb, var(--color-primary) 6%, transparent)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ cursor: 'pointer', pointerEvents: 'none' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{account.label}</span>
                      {isExisting && (
                        <span className="badge badge-muted" style={{ fontSize: 10 }}>{tr('已添加')}</span>
                      )}
                    </div>

                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </CenteredModal>
  );
}
