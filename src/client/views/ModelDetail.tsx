/**
 * 模型明细弹窗（ModelDetail）：模型页每行末尾的「明细」链接打开的二级弹窗，
 * 含标题、按日期 / 按会话两个子标签、加载 / 失败 / 空态与关闭按钮。
 *
 * 用 headless Modal 自建 chrome：基座 Modal 自带层级栈（只给最上层 Escape 与焦点、
 * 点遮罩关自己），因此叠在详情面板之上时 Esc 只关这一层。两个子视图各自独立成文件
 * （ModelDetailDates / ModelDetailSessions），本文件只管弹窗 chrome 与状态切换；
 * 子标签状态不跨关闭保留——关闭即卸载，与各 Tab 的视图状态口径一致。
 * 显示与否由父组件的条件渲染决定，数据由 useModelDetail 取，数字跟随模型页的时间范围
 * （范围只在模型页选，这里不重复展示，只把 range 转给按日期视图的图表）。
 */

import {
  IconCloseOutlineRegular,
  IconQueueOutlineRegular,
  IconRightUpOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useState } from 'react';

import shared from '../components/UsageStatsCommon.module.css';

import css from './ModelDetail.module.css';
import { ModelDetailDates } from './ModelDetailDates.tsx';
import { ModelDetailSessions } from './ModelDetailSessions.tsx';

import type { DateRange } from '../stats.ts';
import type { ModelDetailState } from '../useModelDetail.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 子标签键：与明细的两个维度一一对应。 */
type DetailTab = 'dates' | 'sessions';

/** 模型明细弹窗：标题、子标签与三态，内容区按子标签切换。 */
export function ModelDetail({
  provider, model, mergedCount, range, state, onClose, t,
}: {
  provider: string
  model: string
  /** 归并进来的来源条数，0 表示这一行没有配重定向规则。 */
  mergedCount: number
  /** 模型页当前时间范围，转给按日期视图的图表补齐每一天。 */
  range: DateRange
  state: ModelDetailState
  onClose: () => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const [tab, setTab] = useState<DetailTab>('dates');
  const { detail, loading, error, reload } = state;

  /** 内容区渲染：失败 → 加载 → 空态 → 子视图，避免嵌套三元。 */
  function renderBody() {
    if (error !== null) {
      return (
        <div className={shared.empty}>
          {t('models.detailFailed')}
          <button type="button" className={css.retry} onClick={reload}>{t('models.retry')}</button>
        </div>
      );
    }
    if (detail === null) {
      return <div className={shared.empty}>{loading ? t('state.loading') : t('state.noUsage')}</div>;
    }
    if (detail.calls === 0) return <div className={shared.empty}>{t('models.detailEmpty')}</div>;
    return tab === 'dates'
      ? <ModelDetailDates daily={detail.daily} range={range} t={t} />
      : <ModelDetailSessions sessions={detail.sessions} t={t} />;
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${model} · ${provider}`}
      headless
      className={css.modal}
    >
      <header className={css.header}>
        <div className={css.title}>
          {model} <span className={shared.sub}>· {provider}</span>
          {mergedCount > 0 && (
            <span className={css.mergedNote}>{t('models.mergedSources', { n: mergedCount })}</span>
          )}
        </div>
        <button
          type="button"
          className={css.close}
          onClick={onClose}
          aria-label={t('models.closeDetail')}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
      </header>
      {/* 子标签栏：与用量统计面板的 Tab 栏同一套基元（图标 + 文字、等宽铺满、选中下划线），
          图标也复用面板「日期 / 会话」两个 Tab 的图形，让同名的两个维度看起来是同一处 */}
      <div className={shared.tabbar} role="tablist" aria-label={`${model} · ${provider}`}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'dates'}
          className={tab === 'dates' ? `${shared.tab} ${shared.tabOn}` : shared.tab}
          onClick={() => setTab('dates')}
        >
          <IconRightUpOutlineRegular size={14} />
          <span>{t('models.detailDates')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sessions'}
          className={tab === 'sessions' ? `${shared.tab} ${shared.tabOn}` : shared.tab}
          onClick={() => setTab('sessions')}
        >
          <IconQueueOutlineRegular size={14} />
          <span>{t('models.detailSessions')}</span>
        </button>
      </div>
      <div className={css.body} role="tabpanel">
        {renderBody()}
      </div>
    </Modal>
  );
}
