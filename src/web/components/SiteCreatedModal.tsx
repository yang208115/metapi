import CenteredModal from './CenteredModal.js';
import { getSiteInitializationPreset } from '../../shared/siteInitializationPresets.js';

type NextStepChoice = 'session' | 'apikey' | 'later';

type Props = {
  siteName: string;
  initializationPresetId?: string | null;
  initialSegment?: 'session' | 'apikey';
  sessionLabel?: string;
  onChoice: (choice: NextStepChoice) => void;
  onClose: () => void;
};

export default function SiteCreatedModal({
  siteName,
  initializationPresetId,
  initialSegment = 'session',
  sessionLabel = '添加账号（用户名密码登录）',
  onChoice,
  onClose,
}: Props) {
  const preset = getSiteInitializationPreset(initializationPresetId);
  const apiKeyFirst = initialSegment === 'apikey';
  const helperText = preset?.description
    || (apiKeyFirst
      ? '该平台推荐直接通过 API Key 进行调用接入；添加连接并验证通过后可自动发现可用模型。'
      : '接下来您可以继续补充登录连接或 API Key。');

  const primaryAction = apiKeyFirst
    ? {
      choice: 'apikey' as const,
      label: '下一步：添加 API Key（推荐）',
    }
    : {
      choice: 'session' as const,
      label: `下一步：${sessionLabel}`,
    };

  const secondaryAction = apiKeyFirst
    ? {
      choice: 'session' as const,
      label: sessionLabel,
    }
    : {
      choice: 'apikey' as const,
      label: '添加 API Key',
    };

  return (
    <CenteredModal
      open
      onClose={onClose}
      title="站点接入流程"
      maxWidth={540}
      closeOnBackdrop
      closeOnEscape
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={(
        <>
          <button onClick={() => onChoice('later')} className="btn btn-ghost" title="站点已保存，稍后可以在连接页继续配置">
            稍后配置连接
          </button>
          <button
            onClick={() => onChoice(secondaryAction.choice)}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {secondaryAction.label}
          </button>
          <button
            onClick={() => onChoice(primaryAction.choice)}
            className="btn btn-primary"
          >
            {primaryAction.label}
          </button>
        </>
      )}
    >
      {/* 接入向导进度指示 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: 'var(--color-bg)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border-light)',
        fontSize: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-success)', fontWeight: 600 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--color-success)',
            color: '#fff',
            fontSize: 11,
          }}>✓</span>
          <span>1. 站点已保存</span>
        </div>
        <div style={{ color: 'var(--color-text-muted)' }}>→</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-primary)', fontWeight: 600 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--color-primary)',
            color: '#fff',
            fontSize: 11,
          }}>2</span>
          <span>2. 添加连接</span>
        </div>
        <div style={{ color: 'var(--color-text-muted)' }}>→</div>
        <div style={{ color: 'var(--color-text-muted)' }}>
          <span>3. 验证与路由</span>
        </div>
        <div style={{ color: 'var(--color-text-muted)' }}>→</div>
        <div style={{ color: 'var(--color-text-muted)' }}>
          <span>4. 客户端接入</span>
        </div>
      </div>

      <div className="alert alert-success animate-scale-in" style={{ margin: 0 }}>
        <div className="alert-title">站点已保存成功</div>
        <div className="site-created-summary">
          站点 <strong>"{siteName}"</strong> 已保存到数据库。连接尚未配置，您可以现在继续添加凭证，或随时在“连接”页面补充。
        </div>
      </div>

      {preset ? (
        <div className="alert alert-info" style={{ margin: 0 }}>
          <div className="alert-title">{preset.label} 接入提示</div>
          <div className="site-created-helper-text">
            {helperText}
          </div>
        </div>
      ) : (
        <p className="site-created-helper-text" style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          {helperText}
        </p>
      )}

      <div style={{
        padding: '10px 12px',
        background: 'color-mix(in srgb, var(--color-primary) 5%, var(--color-bg-card))',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border-light)',
        fontSize: 12,
        color: 'var(--color-text-muted)',
      }}>
        💡 提示：添加连接后，系统会自动对该连接进行有效性验证并尝试发现上游模型，零配置生成对应路由规则。
      </div>
    </CenteredModal>
  );
}
