/**
 * 通用分页（Pagination）：上一页 / 页码信息 / 下一页。
 * 独立成文件（一个组件一个文件），可被任意 Tab 复用。
 */

import css from './Pagination.module.css';

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 通用分页：上一页 / 页码信息 / 下一页。 */
export function Pagination({
  page, totalPages, onPageChange, t,
}: {
  page: number
  totalPages: number
  onPageChange: (p: number) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className={css.pagination} aria-label={t('pagination.label')}>
      <button
        type="button"
        className={css.pageBtn}
        aria-label={t('pagination.prev')}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        ‹
      </button>
      <span className={css.pageInfo}>{t('pagination.page', { current: page, total: totalPages })}</span>
      <button
        type="button"
        className={css.pageBtn}
        aria-label={t('pagination.next')}
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        ›
      </button>
    </nav>
  );
}
