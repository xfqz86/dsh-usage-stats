/**
 * 模型饼图 ModelPieChart：按模型占比的饼图，纯 SVG。
 * 输入为过滤后模型切片，内部计算占比与扇区路径，悬停显示明细。
 * 独立成文件，一个组件一个文件，样式见 ModelPieChart.module.css。
 */

import { useEffect, useRef, useState } from 'react';

import { fmtFull, pctOf, pieSlicesOf, pieFullCircleOf  } from '../stats.ts';

import css from './ModelPieChart.module.css';

import type { ModelStat } from '../useSnapshot.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 模型饼图：按过滤后模型的占比饼图，悬停 tooltip 显示明细。 */
export function ModelPieChart({
  models, t,
}: {
  models: ModelStat[]
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const [tip, setTip] = useState<{ x: number; y: number; slicesIndex: number } | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const slices = pieSlicesOf(models);
  // 单模型或单一扇区覆盖整圆时，SVG 弧起终点重合即省略，改绘整圆 <circle>，切片索引供 tooltip 复用
  const fullCircle = pieFullCircleOf(slices);
  const fullCircleIndex = fullCircle ? slices.indexOf(fullCircle) : -1;

  useEffect(() => {
    if (!tip) { setTipPos(null); return; }
    const w = tipRef.current?.offsetWidth ?? 160;
    const h = tipRef.current?.offsetHeight ?? 48;
    const wrapW = wrapRef.current?.clientWidth ?? 120;
    const wrapH = wrapRef.current?.clientHeight ?? 120;
    let left = tip.x - w / 2;
    left = Math.max(4, Math.min(left, wrapW - w - 4));
    let top = tip.y - h - 10;
    top = Math.max(4, Math.min(top, wrapH - h - 4));
    setTipPos({ left, top });
  }, [tip]);

  const tipFromEvent = (e: React.MouseEvent) => {
    let x = 60; let y = 60;
    const el = wrapRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      x = e.clientX - r.left;
      y = e.clientY - r.top;
    }
    return { x, y };
  };

  if (slices.length === 0) {
    return <div className={css.root} style={{ justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>--</div>;
  }

  const activeSlice = tip != null ? slices[tip.slicesIndex] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-caption)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('table.share')}</div>
      <div className={css.root}>
        <div
          className={css.svgWrap}
          ref={wrapRef}
          onMouseLeave={() => setTip(null)}
        >
          <svg className={css.svg} viewBox="0 0 120 120" role="img" aria-label={t('panel.models')}>
            {fullCircle ? (
              <circle
                cx={60}
                cy={60}
                r={50}
                fill={fullCircle.color}
                stroke="var(--dsw-alias-bg-base)"
                strokeWidth={1}
                onMouseEnter={(e) => {
                  const p = tipFromEvent(e);
                  setTip({ x: p.x, y: p.y, slicesIndex: fullCircleIndex });
                }}
                onMouseMove={(e) => {
                  if (tip?.slicesIndex !== fullCircleIndex) return;
                  const p = tipFromEvent(e);
                  setTip({ x: p.x, y: p.y, slicesIndex: fullCircleIndex });
                }}
              />
            ) : (
              slices.map((s, i) => (
                <path
                  key={s.provider + '\u0000' + s.model + i}
                  d={s.path}
                  fill={s.color}
                  stroke="var(--dsw-alias-bg-base)"
                  strokeWidth={1}
                  className={css.slice}
                  onMouseEnter={(e) => {
                    const p = tipFromEvent(e);
                    setTip({ x: p.x, y: p.y, slicesIndex: i });
                  }}
                  onMouseMove={(e) => {
                    if (tip?.slicesIndex !== i) return;
                    const p = tipFromEvent(e);
                    setTip({ x: p.x, y: p.y, slicesIndex: i });
                  }}
                />
              ))
            )}
            {/* 中心白圆形成甜甜圈，突出占比 */}
            <circle cx={60} cy={60} r={28} className={css.center} />
          </svg>
          {activeSlice && (
            <div
              ref={tipRef}
              className={css.tip}
              style={{ left: (tipPos ? tipPos.left : 0) + 'px', top: (tipPos ? tipPos.top : 0) + 'px', opacity: tipPos ? 1 : 0 }}
            >
              <div className={css.tipTitle}>{activeSlice.model} <span className={css.tipMeta}>· {activeSlice.provider}</span></div>
              <div>{fmtFull(activeSlice.total)} tokens · {pctOf(activeSlice.share)}</div>
            </div>
          )}
        </div>
        <div className={css.legend}>
          {slices.map((s) => (
            <div key={s.provider + '\u0000' + s.model} className={css.legendItem} title={`${s.model} · ${s.provider}`}>
              <span className={css.legendDot} style={{ background: s.color }} />
              <span className={css.legendText}>{s.model}</span>
              <span className={css.legendPct}>{pctOf(s.share)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
