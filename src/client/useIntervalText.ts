/**
 * 抓取间隔输入 hook（浏览器端）。
 *
 * 三额度同一写法：本地文本态随打随改，失焦/回车时夹取提交并回写规范值，
 * 避免每键回跳；input ref 收归内部，调用方只需展开 field。
 */
import { useRef, useState } from 'react';

/** 间隔输入手柄：field 直接展开到 <input> 上。 */
export function useIntervalText(
  initial: number,
  clamp: (v: number) => number,
  onCommit: (minutes: number) => void,
): {
    field: {
      ref: React.RefObject<HTMLInputElement>
      value: string
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
      onBlur: () => void
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
    }
  } {
  const [text, setText] = useState(String(initial));
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = () => {
    const minutes = clamp(Number(text));
    setText(String(minutes));
    onCommit(minutes);
  };
  return {
    field: {
      ref: inputRef,
      value: text,
      onChange: (e) => setText(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      },
    },
  };
}
