/**
 * Prompt construction: template interpolation.
 */

/** Replace {{placeholders}} in template with context values. */
export function interpolateTemplate(
  template: string,
  context: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in context ? context[key] : match;
  });
}

