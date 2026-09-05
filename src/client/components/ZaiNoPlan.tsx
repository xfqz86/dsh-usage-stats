/**
 * Z.ai 未开通空态：品牌色图标徽标配短文案，概览磁贴与侧边栏 tooltip 共用。
 * `tile` 为磁贴浅底，`tip` 为深色 tooltip 底。
 */

import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives';

import css from './ZaiNoPlan.module.css';

/** Z.ai 未开通空态，图标加短文案，色调按容器深浅切换。 */
export function ZaiNoPlan({ text, tone = 'tile' }: {
  text: string
  tone?: 'tile' | 'tip'
}) {
  return (
    <div className={tone === 'tip' ? `${css.root} ${css.tip}` : css.root}>
      <span className={css.icon} aria-hidden="true">
        <IconSparkle16 size={14} />
      </span>
      <span className={css.text}>{text}</span>
    </div>
  );
}
