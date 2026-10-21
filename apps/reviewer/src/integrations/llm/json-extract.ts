/**
 * Robustly extract a single JSON object from an LLM's text response.
 *
 * Local/open models are less disciplined than tool-calling APIs: they may wrap
 * JSON in ```json fences, prepend a sentence, or add trailing commentary. This
 * strips fences and slices from the first `{` to the last `}` before parsing,
 * which recovers the object in the common cases without a full JSON tokenizer.
 */
export function extractJsonObject(text: string | null | undefined): unknown {
  if (!text || !text.trim()) {
    throw new Error('model returned an empty response');
  }

  let source = text.trim();

  // Prefer the contents of a fenced code block when present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced && fenced[1]) {
    source = fenced[1].trim();
  }

  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object found in model output: ${source.slice(0, 200)}`);
  }

  const candidate = source.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`failed to parse JSON from model output: ${(err as Error).message}`);
  }
}
