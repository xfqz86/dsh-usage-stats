/**
 * 会话明细弹窗（SessionDetail）：会话页主会话行末尾的「明细」链接打开的二级弹窗，
 * 含标题（会话标题 + 合计）、按日期 / 按模型两个子标签、加载 / 失败 / 空态与关闭按钮。
 *
 * chrome 与模型/日期明细同一套（UsageStatsCommon 的 detail* 类）：用 headless Modal 自建，
 * 基座 Modal 自带层级栈（只给最上层 Escape 与焦点、点遮罩关自己），叠在详情面板之上时
 * Esc 只关这一层。两个子视图各自独立成文件（SessionDetailDates / SessionDetailModels），
 * 本文件只管弹窗 chrome 与状态切换；子标签状态不跨关闭保留——关闭即卸载，
 * 与各 Tab 的视图状态口径一致。显示与否由父组件的条件渲染决定，数据由 useSessionDetail 取；
 * 请求集合（主会话 + 展平的子代理）由父组件在点击那一刻冻结后传入，标题与合计都取该行数据。
 * 按模型子视图的模型行按偏好里的重定向规则在这里归并（服务端明细始终是原始行，与模型页同口径）。
 */

import {
  IconAgentPresetOutlineRegular,
  IconCloseOutlineRegular,
  IconRightUpOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useMemo, useState } from 'react';

import shared from '../components/UsageStatsCommon.module.css';
import { fmtFull, redirectModels, shortId, usageTotal } from '../stats.ts';

import { SessionDetailDates } from './SessionDetailDates.tsx';
import { SessionDetailModels } from './SessionDetailModels.tsx';

import type { ModelRedirect } from '../../types.ts';
import type { SessionDetailState } from '../useSessionDetail.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 子标签键：与明细的两个维度一一对应。 */
type DetailTab = 'dates' | 'models';

/** 会话明细弹窗：标题、子标签与三态，内容区按子标签切换。 */
export function SessionDetail({
  id, title, rules, state, onClose, t,
}: {
  /** 所点行的主会话 id，标题里的短 id 用它。 */
  id: string
  /** 所点行的会话标题（缺标题时调用方已回落短 id，与表格行同一表现）。 */
  title: string
  /** 模型统计重定向规则，只作用于按模型子视图。 */
  rules: readonly ModelRedirect[]
  state: SessionDetailState
  onClose: () => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const [tab, setTab] = useState<DetailTab>('dates');
  const { detail, loading, error, reload } = state;
  const label = `${title} · ${shortId(id)}`;

  // 归并只在浏览器端做：服务端明细给的是原始 provider/model 行，口径与模型页、日期明细
  // 保持一致（同一套规则、同一份 redirectModels）。归并只换名字不改总量，标题合计与
  // 「按日期」不受影响；mergedSources 连同归并结果带给按模型表，行上那枚「已归并 N」标记同源。
  const redirect = useMemo(
    () => redirectModels(detail?.models ?? [], rules),
    [detail?.models, rules],
  );

  /** 内容区渲染：失败 → 加载 → 空态 → 子视图，避免嵌套三元。 */
  function renderBody() {
    if (error !== null) {
      return (
        <div className={shared.empty}>
          {t('detail.failed')}
          <button type="button" className={shared.detailRetry} onClick={reload}>{t('detail.retry')}</button>
        </div>
      );
    }
    if (detail === null) {
      return <div className={shared.empty}>{loading ? t('state.loading') : t('state.noUsage')}</div>;
    }
    // 空态判据是 calls：只有 reasoning 的调用 calls>0 而四段 total 为 0，不能用 total 判空
    if (detail.calls === 0) return <div className={shared.empty}>{t('sessions.detailEmpty')}</div>;
    return tab === 'dates'
      ? <SessionDetailDates daily={detail.daily} t={t} />
      : <SessionDetailModels models={redirect.models} mergedSources={redirect.mergedSources} t={t} />;
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={label}
      headless
      className={shared.detailModal}
    >
      <header className={shared.detailHeader}>
        <div className={shared.detailTitle}>
          {title} <span className={shared.sub}>· {shortId(id)}</span>
          {/* 合计复用热力图的口径与文案；明细还没到时不摆 0，免得把「未知」读成「没有用量」 */}
          {detail !== null && (
            <span className={shared.sub}> · {t('heat.total', { tokens: fmtFull(usageTotal(detail.usage)), calls: fmtFull(detail.calls) })}</span>
          )}
        </div>
        <button
          type="button"
          className={shared.detailClose}
          onClick={onClose}
          aria-label={t('detail.close')}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
      </header>
      {/* 子标签栏：与用量统计面板的 Tab 栏同一套基元（图标 + 文字、等宽铺满、选中下划线），
          图标复用面板「日期 / 模型」两个 Tab 的图形；默认「按日期」——会话的用量先按时间铺开 */}
      <div className={shared.tabbar} role="tablist" aria-label={label}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'dates'}
          className={tab === 'dates' ? `${shared.tab} ${shared.tabOn}` : shared.tab}
          onClick={() => setTab('dates')}
        >
          <IconRightUpOutlineRegular size={14} />
          <span>{t('sessions.detailDates')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'models'}
          className={tab === 'models' ? `${shared.tab} ${shared.tabOn}` : shared.tab}
          onClick={() => setTab('models')}
        >
          <IconAgentPresetOutlineRegular size={14} />
          <span>{t('sessions.detailModels')}</span>
        </button>
      </div>
      <div className={shared.detailBody} role="tabpanel">
        {renderBody()}
      </div>
    </Modal>
  );
}
