/**
 * Lightweight tokenizer shared by the document retriever and query builder.
 * Splits on non-alphanumerics AND on camelCase / snake_case boundaries so that
 * an identifier like `reconcilePayment` matches docs mentioning "reconcile"
 * and "payment".
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be',
  'this', 'that', 'it', 'as', 'by', 'with', 'from', 'at', 'if', 'not', 'no', 'do',
  'we', 'you', 'i', 'was', 'were', 'can', 'will', 'would', 'should', 'must', 'may',
]);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}
