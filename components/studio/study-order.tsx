"use client";

import type { StudyOrder } from "@/lib/study-order";

export function StudyOrderPicker({ value, textbookAvailable, onChange }: {
  value: StudyOrder; textbookAvailable: boolean; onChange: (order: StudyOrder) => void;
}) {
  return textbookAvailable ? (
    <label className="study-order-picker">
      <span>词序</span>
      <select aria-label="背诵与练习词序" value={value} onChange={event => onChange(event.target.value as StudyOrder)}>
        <option value="random">随机顺序</option>
        <option value="textbook">教材词表顺序</option>
      </select>
    </label>
  ) : <span className="study-order-note">随机顺序</span>;
}
