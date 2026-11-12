/**
 * 输入区状态行上的模型速度读数：常驻显示当前会话的平均 TTFT / ATPS，点击弹出详情卡。
 *
 * 数据来自本会话的事件窗口（modelSpeed.ts 把 `step/start`、`assistant/attempt` 与
 * `assistant/message` 折算成每次调用样本），刷新页面后历史会话同样可复现。详情卡 portal
 * 到 body，用 fixed 坐标向上展开并按视口夹紧，避免被输入框卡片裁剪；点外部或 Esc 关闭。
 * 口径见 docs/ARCHITECTURE.md §7。
 */

import {
  IconApiOutlineRegular,
  IconCompactOutlineRegular,
  IconGaugeOutlineRegular,
  IconQuestionOutlineRegular,
  IconThinkOutlineRegular,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { clamp } from '../../utils.ts';
import { type NS } from '../locales.ts';
import {
  formatRate,
  formatTtft,
  type MetricSummary,
  type SessionPhase,
  type SpeedSnapshot,
} from '../modelSpeed.ts';

import css from './ModelSpeedPill.module.css';
import { SpeedChart } from './SpeedChart.tsx';

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
// 类型侧合并：ui-conversation 声明 conversation.composer.dock 插槽与会话标准属性。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

/** 条目注入给读数组件的速度读取钩子。 */
export interface SpeedInjected {
  useSpeed: () => SpeedSnapshot
}

/** 读数组件自身需要的属性：注入的速度钩子 + 本命名空间翻译函数。 */
export type SpeedPillProps = InjectFace<SpeedInjected> & PropsLocale<typeof NS>;

/**
 * 输入区状态行条目收到的组合属性：会话标准套件 + 读数组件需要的两项。
 * 本条目没有 children/store，运行时属性由插槽发给门控组件，读数只消费自己需要的两份。
 */
export type SpeedEntryProps = PropsRuntime<'conversation.composer.dock'> & SpeedPillProps;

/** 详情卡的目标宽度与视口安全边距。 */
const PANEL_WIDTH = 300;
const EDGE = 12;
const GAP = 8;
const PANEL_MIN_HEIGHT = 220;

/** 浮层位置（fixed 坐标；宽度在窄视口下收缩）。 */
interface PanelPosition {
  left: number
  top: number
  width: number
}

/** 状态行图标：沿用官方的「思考」「运行命令」「上下文压缩」图标。 */
function PhaseIcon({ phase }: { phase: SessionPhase }) {
  if (phase === 'compacting' || phase === 'compacted') return <IconCompactOutlineRegular />;
  if (phase === 'tools') return <IconApiOutlineRegular />;
  return <IconThinkOutlineRegular />;
}

/** 指标名后面的小问号：悬停或键盘聚焦时显示一句说明。 */
function Help({ text }: { text: string }) {
  return (
    <span className={css.help} tabIndex={0} aria-label={text}>
      <IconQuestionOutlineRegular />
      <span className={css.helpBubble} data-help="true" aria-hidden>{text}</span>
    </span>
  );
}

/** 渲染一格的数值；没有有效样本时显示破折号。 */
function cell(summary: MetricSummary | null, format: (value: number) => string, pick: 'average' | 'last' | 'min' | 'max'): string {
  return summary === null ? '—' : format(summary[pick]);
}

/** 模型速度读数与详情卡。 */
export function ModelSpeedPill({ useSpeed, t }: SpeedPillProps) {
  const summary = useSpeed();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef);

  // 打开期间跟随输入框位置（滚动/缩放后重新夹紧）；关闭后清空，下次打开重新测。
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = (): void => {
      const anchor = anchorRef.current;
      if (anchor === null) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE * 2);
      const height = panelRef.current?.offsetHeight ?? PANEL_MIN_HEIGHT;
      const left = clamp(rect.left + rect.width / 2 - width / 2, EDGE, window.innerWidth - width - EDGE);
      const above = rect.top - GAP - height >= EDGE;
      const top = above
        ? rect.top - GAP - height
        : clamp(rect.bottom + GAP, EDGE, window.innerHeight - height - EDGE);
      setPosition({ left, top, width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, summary]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 捕获阶段拦下：详情卡打开时 Esc 只关闭它，不能顺带计入输入框的 Esc-Esc 停止手势。
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, [open]);

  const ttft = summary.ttft === null ? '—' : formatTtft(summary.ttft.average);
  const atps = summary.atps === null ? '—' : formatRate(summary.atps.average);
  const aria = summary.calls === 0
    ? t('speed.pill.ariaEmpty')
    : t('speed.pill.aria', { ttft, atps });

  // 会动的阶段才脉冲：生成 / 调工具 / 压缩中；压缩完成与空闲保持静止。
  const pulsing = summary.phase === 'generating' || summary.phase === 'tools' || summary.phase === 'compacting';

  return (
    <span className={css.anchor} ref={anchorRef}>
      <button
        type="button"
        className={css.pill}
        aria-label={aria}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open); }}
      >
        <span className={css.phaseIcon} data-phase={summary.phase} data-pulse={pulsing ? 'true' : undefined} aria-hidden>
          <PhaseIcon phase={summary.phase} />
        </span>
        <span className={css.label}>TTFT {ttft}</span>
        <span className={css.sep} aria-hidden>·</span>
        <span className={css.label}>ATPS {atps}</span>
      </button>
      {open && createPortal(
        <div
          className={css.panel}
          ref={panelRef}
          role="dialog"
          aria-label={t('speed.panel.title')}
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            width: position?.width ?? PANEL_WIDTH,
            visibility: position === null ? 'hidden' : 'visible',
          }}
        >
          <div className={css.panelHeader}>
            <span className={css.headerLabel}>
              <IconGaugeOutlineRegular />
              {t('speed.panel.title')}
            </span>
            <span className={css.phaseText} data-phase={summary.phase}>
              {t(`speed.state.${summary.phase}`)}
            </span>
            {summary.calls > 0 && (
              <span className={css.calls}>
                {summary.calls === 1 ? t('speed.panel.call') : t('speed.panel.calls', { count: summary.calls })}
              </span>
            )}
          </div>
          {summary.calls === 0 ? (
            <div className={css.empty}>
              {t('speed.panel.empty')}
              <div className={css.emptyHint}>{t('speed.panel.emptyHint')}</div>
            </div>
          ) : (
            <>
              <SpeedChart samples={summary.samples} t={t} />
              <table className={css.table}>
                <thead>
                  <tr>
                    <th aria-hidden />
                    <th>{t('speed.panel.average')}</th>
                    <th>{t('speed.panel.last')}</th>
                    <th>{t('speed.panel.min')}</th>
                    <th>{t('speed.panel.max')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>
                      <span className={css.metricName}>
                        {t('speed.panel.ttft')}
                        <Help text={t('speed.help.ttft')} />
                      </span>
                    </th>
                    <td>{cell(summary.ttft, formatTtft, 'average')}</td>
                    <td>{cell(summary.ttft, formatTtft, 'last')}</td>
                    <td>{cell(summary.ttft, formatTtft, 'min')}</td>
                    <td>{cell(summary.ttft, formatTtft, 'max')}</td>
                  </tr>
                  <tr>
                    <th>
                      <span className={css.metricName}>
                        {t('speed.panel.atps')}
                        <span className={css.unit}> tok/s</span>
                        <Help text={t('speed.help.atps')} />
                      </span>
                    </th>
                    <td>{cell(summary.atps, formatRate, 'average')}</td>
                    <td>{cell(summary.atps, formatRate, 'last')}</td>
                    <td>{cell(summary.atps, formatRate, 'min')}</td>
                    <td>{cell(summary.atps, formatRate, 'max')}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
