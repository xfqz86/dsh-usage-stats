/**
 * 日期明细弹窗（DateDetail）：日期页每行末尾的「明细」链接打开的二级弹窗，
 * 含标题（日期 + 当天合计）、按会话 / 按模型两个子标签、加载 / 失败 / 空态与关闭按钮。
 *
 * chrome 与模型明细弹窗同一套（UsageStatsCommon 的 detail* 类）：用 headless Modal 自建，
 * 基座 Modal 自带层级栈（只给最上层 Escape 与焦点、点遮罩关自己），叠在详情面板之上时
 * Esc 只关这一层。两个子视图各自独立成文件（DateDetailSessions / DateDetailModels），
 * 本文件只管弹窗 chrome 与状态切换；子标签状态不跨关闭保留——关闭即卸载，
 * 与各 Tab 的视图状态口径一致。显示与否由父组件的条件渲染决定，数据由 useDateDetail 取。
 * 按模型子视图的模型行按偏好里的重定向规则在这里归并（服务端明细始终是原始行，与模型页同口径）。
 */

import {
  IconAgentPresetOutlineRegular,
  IconCloseOutlineRegular,
  IconQueueOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useMemo, useState } from 'react';

import shared from '../components/UsageStatsCommon.module.css';
import { fmtFull, fullDayLabel, redirectModels, usageTotal } from '../stats.ts';

import { DateDetailModels } from './DateDetailModels.tsx';
import { DateDetailSessions } from './DateDetailSessions.tsx';

import type { ModelRedirect } from '../../types.ts';
import type { DateDetailState } from '../useDateDetail.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 子标签键：与明细的两个维度一一对应。 */
type DetailTab = 'sessions' | 'models';

/** 日期明细弹窗：标题、子标签与三态，内容区按子标签切换。 */
export function DateDetail({
  day, rules, state, onClose, t,
}: {
  /** 打开的日期，本地日零点（与日期表行的 t 同值）。 */
  day: number
  /** 模型统计重定向规则，只作用于按模型子视图。 */
  rules: readonly ModelRedirect[]
  state: DateDetailState
  onClose: () => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const [tab, setTab] = useState<DetailTab>('sessions');
  const { detail, loading, error, reload } = state;
  const label = fullDayLabel(day);

  // 归并只在浏览器端做：服务端明细给的是原始 provider/model 行，口径与模型页、模型明细弹窗
  // 保持一致（同一套规则、同一份 redirectModels）。当天行不带 series 不影响归并——它只把
  // 同一批用量换个名字，头部合计与「按模型」的占比分母都取当天合计，归并前后不变。
  // mergedSources 连同归并结果一起带给按模型表，行上那枚「已归并 N」标记与模型页同源。
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
    if (detail.calls === 0) return <div className={shared.empty}>{t('days.detailEmpty')}</div>;
    return tab === 'sessions'
      ? <DateDetailSessions sessions={detail.sessions} t={t} />
      : <DateDetailModels models={redirect.models} mergedSources={redirect.mergedSources} t={t} />;
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
          {label}
          {/* 当天合计复用热力图的口径与文案；明细还没到时不摆 0，免得把「未知」读成「当天没有用量」 */}
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
      {/* 子标签栏：与用量统计面板的 Tab 栏同一套基元（图标 + 文字、等宽铺满、选中下划线）。
          默认「按会话」：会话是当天用量的来源，模型维度是它的另一种切分 */}
      <div className={shared.tabbar} role="tablist" aria-label={label}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sessions'}
          className={tab === 'sessions' ? `${shared.tab} ${shared.tabOn}` : shared.tab}
          onClick={() => setTab('sessions')}
        >
          <IconQueueOutlineRegular size={14} />
          <span>{t('days.detailSessions')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'models'}
          className={tab === 'models' ? `${shared.tab} ${shared.tabOn}` : shared.tab}
          onClick={() => setTab('models')}
        >
          <IconAgentPresetOutlineRegular size={14} />
          <span>{t('days.detailModels')}</span>
        </button>
      </div>
      <div className={shared.detailBody} role="tabpanel">
        {renderBody()}
      </div>
    </Modal>
  );
}
