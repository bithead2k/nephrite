// Conservative candidate planner. Residual predicates always run on returned pages.
export type BirthdayPlan = { month: number; day: number };
export function planBirthday(expressions: string[], current: Record<string, any>): BirthdayPlan | null {
  const fields = new Map<string, Partial<BirthdayPlan>>();
  for (const expression of expressions) {
    // Only a conjunction of simple comparisons: no OR, calls, negation, or aliases.
    const parts = expression.split(/\s+and\s+|&&/i);
    for (const part of parts) {
      const match = part.trim().match(/^(birthday|birthdate|birth_date|date_of_birth|dob)\.(month|day)\s*(?:==|=)\s*(\d+|this\.date\.(?:month|day))$/i);
      if (!match) continue;
      // Reject the entire expression if its boolean structure is not understood.
      if (/\bor\b|\|\||[()!]/i.test(expression)) continue;
      const value = /^\d+$/.test(match[3]) ? Number(match[3]) : Number(current.date?.[match[3].split('.').pop()!]);
      const field = match[1].toLowerCase();
      const pair = fields.get(field) ?? {};
      pair[match[2].toLowerCase() as 'month' | 'day'] = value;
      fields.set(field, pair);
    }
  }
  for (const {month, day} of fields.values()) {
    if (Number.isInteger(month) && month! >= 1 && month! <= 12 && Number.isInteger(day) && day! >= 1 && day! <= 31) return {month: month!, day: day!};
  }
  return null;
}


// Recognize the complete common birthday-list script, not arbitrary JavaScript.
// Every other script falls back; we never narrow a snapshot used by another query.
export function planBirthdayScript(code: string, current: Record<string, any>): BirthdayPlan | null {
  const prefix = code.match(/^\s*const (\w+) = dv\.current\(\);\s*const (\w+) = dv\.pages\((['"])((?:(?!\3)[^\\\n])*)\3\)\.filter\((\w+) => \5\.(birthday|birthdate|birth_date|date_of_birth|dob)\)\.filter\((\w+) => ([^;]+)\);/s);
  if (!prefix) return null;
  const [, note, result, , , , field, arg, condition] = prefix;
  const expected = `${arg}.${field}.month == ${note}.date.month && ${arg}.${field}.day == ${note}.date.day`;
  if (condition.trim() !== expected) return null;
  const tail = code.slice(prefix[0].length).trim();
  // Only conditional literal headings/separators and the selected list may follow.
  const escaped = result.replace(/[$]/g, '\\$&');
  const outputs = new RegExp(`^(?:if \\(${escaped}\\.length\\) dv\\.paragraph\\((?:"[^"\\n]*"|'[^'\\n]*')\\);\\s*)*if \\(${escaped}\\.length\\) dv\\.list\\(${escaped}\\.file\\.link\\);$`);
  if (!outputs.test(tail)) return null;
  return planBirthday([`${field}.month = this.date.month and ${field}.day = this.date.day`], current);
}
