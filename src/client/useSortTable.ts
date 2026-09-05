/**
 * 表格排序分页三件套（浏览器端）。
 *
 * 日期/会话/模型三表同一交互：默认降序、同列点击翻转、换列回到降序、
 * 排序切换回第 1 页、页码夹取到有效范围。比较函数与行类型归各表
 * （领域不同），本模块只收状态机、稳定排序壳与分页切片。
 */
import { useCallback, useEffect, useState } from 'react';

import type { SortDir } from './components/ThSortable.tsx';

/** 排序分页状态：三表共用的键/方向/页码/切换/切片动作。 */
export function useSortTable<K extends string>(initialKey: K, rowCount: number, pageSize: number): {
  sortKey: K
  sortDir: SortDir
  handleSort: (key: K) => void
  page: number
  totalPages: number
  setPage: (page: number) => void
  slice: <T>(rows: T[]) => T[]
} {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rowCount / pageSize));
  const handleSort = (key: K) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(1);
  };
  // 行数变化时夹取页码到有效范围
  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), totalPages));
  }, [totalPages]);
  const slice = useCallback(
    <T>(rows: T[]): T[] => rows.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize],
  );
  return { sortKey, sortDir, handleSort, page, totalPages, setPage, slice };
}

/** 稳定排序：下标装饰保证相等项原序，方向统一在此应用。 */
export function stableSort<T>(rows: T[], compare: (a: T, b: T) => number, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const cmp = compare(a.row, b.row);
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
      return a.i - b.i;
    })
    .map((x) => x.row);
}
