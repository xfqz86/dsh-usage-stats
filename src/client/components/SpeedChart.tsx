/**
 * 详情卡顶部的模型速度小图表：每次调用一根 ATPS 柱，TTFT 用折线叠加（两套纵轴各自缩放）。
 *
 * 最多展示最近 50 次；鼠标移到任意一列上，浮出的读数卡固定在详情卡外侧（图表外面）
 * 显示该次调用的完整数据，不压住图形。
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { type NS } from '../locales.ts';
import { buildChartGeometry, formatRate, formatTtft, type SpeedSample } from '../modelSpeed.ts';

import css from './SpeedChart.module.css';

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';

/** 图表最多展示的调用次数；更多时只保留最近一段。 */
const MAX_CHART_SAMPLES = 50;

/** 视图尺寸（宽度与详情卡内容区一致，高度给柱和点留出呼吸）。 */
const VIEW_WIDTH = 272;
const VIEW_HEIGHT = 88;

/** 读数卡宽度，以及它和详情卡、视口边缘的距离。 */
const TIP_WIDTH = 174;
const TIP_GAP = 8;
const TIP_EDGE = 8;
/** 首次测量前的估值（真实高度约 106px），只用于纵向夹紧。 */
const TIP_HEIGHT = 108;

/** 读数卡里的时间：本地时区的 MM/DD HH:mm:ss。 */
function formatCallTime(time: number): string {
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 图表的组件属性。 */
export interface SpeedChartProps {
  /** 当前会话的全部调用样本（按时间顺序）。 */
  samples: readonly SpeedSample[]
  /** 本插件的翻译函数。 */
  t: TranslateNS<typeof NS>
}

/** 读数卡上的一行。 */
function TipRow({ kind, label, value }: { kind: 'ttft' | 'atps' | 'tokens' | 'total'; label: string; value: string }) {
  return (
    <div className={css.tipRow}>
      <span className={css.tipDot} data-kind={kind} aria-hidden />
      <span className={css.tipLabel}>{label}</span>
      <span className={css.tipValue}>{value}</span>
    </div>
  );
}

/** 读数卡的 fixed 坐标。 */
interface TipPosition {
  left: number
  top: number
}

/** ATPS 柱 + TTFT 折线，悬停时在详情卡外侧显示该次调用的读数卡。 */
export function SpeedChart({ samples, t }: SpeedChartProps) {
  const recent = useMemo(() => samples.slice(-MAX_CHART_SAMPLES), [samples]);
  const geometry = useMemo(() => buildChartGeometry(recent, VIEW_WIDTH, VIEW_HEIGHT), [recent]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tip, setTip] = useState<TipPosition | null>(null);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const last = recent.length - 1;
  const active = hovered === null ? undefined : recent[hovered];

  // 读数卡贴详情卡外侧：右侧放得下就贴右，否则贴左；再不行就夹在视口里。
  useLayoutEffect(() => {
    if (hovered === null) {
      setTip(null);
      return;
    }
    const update = (): void => {
      const chart = chartRef.current;
      if (chart === null) return;
      const chartRect = chart.getBoundingClientRect();
      const panel = chart.closest('[role="dialog"]');
      const panelRect = (panel ?? chart).getBoundingClientRect();
      const height = tipRef.current?.offsetHeight ?? TIP_HEIGHT;
      const right = panelRect.right + TIP_GAP;
      const left = panelRect.left - TIP_GAP - TIP_WIDTH;
      const clampTop = (value: number): number => Math.min(Math.max(value, TIP_EDGE), Math.max(TIP_EDGE, window.innerHeight - height - TIP_EDGE));
      const rightFits = right + TIP_WIDTH <= window.innerWidth - TIP_EDGE;
      const leftFits = left >= TIP_EDGE;
      if (rightFits || leftFits) {
        setTip({ left: rightFits ? right : left, top: clampTop(chartRect.top) });
        return;
      }
      // 两侧都放不下（窗口很窄）：退到详情卡正上方，上方也没位置就放正下方，横向对齐图表。
      const above = panelRect.top - TIP_GAP - height;
      setTip({
        left: Math.min(Math.max(chartRect.left, TIP_EDGE), window.innerWidth - TIP_WIDTH - TIP_EDGE),
        top: above >= TIP_EDGE ? above : panelRect.bottom + TIP_GAP,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [hovered]);

  return (
    <div className={css.wrap}>
      <div className={css.chartArea}>
        <svg
          ref={chartRef}
          className={css.chart}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-label={t('speed.chart.label')}
        >
          <line className={css.grid} x1={0} y1={geometry.midline} x2={VIEW_WIDTH} y2={geometry.midline} />
          <line className={css.grid} x1={0} y1={geometry.baseline} x2={VIEW_WIDTH} y2={geometry.baseline} />
          {geometry.bars.map(bar => (
            <rect
              key={`bar-${recent[bar.sample]?.index ?? bar.sample}`}
              className={css.bar}
              data-bar="true"
              data-last={bar.sample === last ? 'true' : undefined}
              data-active={hovered === bar.sample ? 'true' : undefined}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1.5}
            />
          ))}
          {geometry.segments.map((points, index) => (
            <polyline key={`line-${index}`} className={css.line} points={points} />
          ))}
          {geometry.dots.map(dot => (
            <circle
              key={`dot-${recent[dot.sample]?.index ?? dot.sample}`}
              className={css.dot}
              data-last={dot.sample === last ? 'true' : undefined}
              data-active={hovered === dot.sample ? 'true' : undefined}
              cx={dot.cx}
              cy={dot.cy}
              r={recent.length > 24 ? 1.4 : 2}
            />
          ))}
          {/* 透明命中区放在最上层：细柱也能稳定悬停，且不干扰图形本身的绘制。 */}
          {geometry.hits.map(hit => (
            <rect
              key={`hit-${recent[hit.sample]?.index ?? hit.sample}`}
              className={css.hit}
              data-hit="true"
              x={hit.x}
              y={0}
              width={hit.width}
              height={VIEW_HEIGHT}
              onPointerEnter={() => { setHovered(hit.sample); }}
              onPointerLeave={() => { setHovered(null); }}
            />
          ))}
        </svg>
      </div>
      <div className={css.legend}>
        <span className={css.legendItems}>
          <span className={css.legendItem}>
            <span className={css.swatchLine} aria-hidden />
            {t('speed.chart.ttft')}
          </span>
          <span className={css.legendItem}>
            <span className={css.swatchBar} aria-hidden />
            {t('speed.chart.atps')}
          </span>
        </span>
        {samples.length > MAX_CHART_SAMPLES && (
          <span className={css.recent}>{t('speed.chart.recent', { count: MAX_CHART_SAMPLES })}</span>
        )}
      </div>
      {active !== undefined && createPortal(
        <div
          ref={tipRef}
          className={css.tooltip}
          data-tip="true"
          style={{
            left: (tip ?? { left: 0, top: 0 }).left,
            top: (tip ?? { left: 0, top: 0 }).top,
            visibility: tip === null ? 'hidden' : 'visible',
          }}
        >
          <div className={css.tipTitle}>
            <span>{t('speed.readout.call', { index: active.index })}</span>
            <span className={css.tipTime}>{formatCallTime(active.time)}</span>
          </div>
          <TipRow kind="ttft" label={t('speed.readout.ttft')} value={active.ttftMs === null ? '—' : formatTtft(active.ttftMs)} />
          <TipRow
            kind="atps"
            label={t('speed.readout.atps')}
            value={active.atps === null ? '—' : `${formatRate(active.atps)} tok/s`}
          />
          <TipRow kind="tokens" label={t('speed.readout.tokens')} value={active.outputTokens === null ? '—' : active.outputTokens.toLocaleString()} />
          <TipRow kind="total" label={t('speed.readout.total')} value={active.totalMs === null ? '—' : formatTtft(active.totalMs)} />
        </div>,
        document.body,
      )}
    </div>
  );
}
