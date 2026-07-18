export function createPromptRedactor(values: readonly string[]): (value: string) => string {
  const exactValues = [...new Set(values.filter(Boolean))];
  const promptLines = new Set(exactValues.flatMap((value) => value.split(/\r?\n/)).filter(Boolean));
  const embeddedValues = [
    ...new Set([
      ...exactValues,
      ...promptLines,
    ]),
  ].sort((a, b) => b.length - a.length);
  return (value: string): string => {
    if (promptLines.has(value)) return '[REDACTED_PROMPT]';
    let redacted = value;
    for (const sensitive of embeddedValues) {
      redacted = redacted.replaceAll(sensitive, '[REDACTED_PROMPT]');
    }
    return redacted;
  };
}
