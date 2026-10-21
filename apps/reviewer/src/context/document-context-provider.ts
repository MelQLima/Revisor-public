import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  ContextKind,
  ContextProvider,
  ContextResult,
  ContextSearchOptions,
} from '../domain/context.js';
import { termFrequencies, tokenize } from './tokenize.js';

/**
 * MVP context retrieval: a keyword/TF-IDF index over markdown documents in a
 * directory (default `docs/ai`). Documents are chunked by heading so retrieval
 * returns the specific section (e.g. `payments.md#invariants`) rather than a
 * whole file.
 *
 * This deliberately implements the SAME `ContextProvider` interface a future
 * pgvector/Qdrant provider would, so swapping in semantic retrieval later is a
 * drop-in change with no impact on the review pipeline.
 */

interface Chunk {
  id: string;
  source: string;
  title: string;
  kind: ContextKind;
  content: string;
  tf: Map<string, number>;
  length: number;
}

function inferKind(relPath: string): ContextKind {
  const p = relPath.toLowerCase();
  // `business-rules/**` is an optional evidence-anchored rule registry; it must retrieve as `business` (the kind the review pipeline
  // queries for domain context) — not as `other`, or the reviewer never sees it.
  if (
    p.includes(`domain${sep}`) ||
    p.includes('/domain/') ||
    p.includes('business-context') ||
    p.includes('business-rule')
  )
    return 'business';
  if (p.includes('architecture')) return 'architecture';
  if (p.includes('review-guideline') || p.includes('guideline')) return 'guideline';
  if (p.includes('incident') || p.includes('history')) return 'history';
  return 'other';
}

/** Split a markdown file into heading-delimited chunks. */
function chunkMarkdown(relPath: string, raw: string): Omit<Chunk, 'tf' | 'length'>[] {
  const kind = inferKind(relPath);
  const lines = raw.split(/\r?\n/);
  const chunks: Omit<Chunk, 'tf' | 'length'>[] = [];

  let currentTitle = relPath;
  let buffer: string[] = [];
  let index = 0;

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content.length > 0) {
      const anchor = currentTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      chunks.push({
        id: `${relPath}#${anchor || index}`,
        source: `${relPath}${anchor ? `#${anchor}` : ''}`,
        title: currentTitle,
        kind,
        content,
      });
      index += 1;
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      currentTitle = heading[2]!.trim();
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

async function walk(dir: string): Promise<string[]> {
  let entries: string[] = [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      entries = entries.concat(await walk(full));
    } else if (dirent.isFile() && /\.(md|markdown)$/i.test(dirent.name)) {
      entries.push(full);
    }
  }
  return entries;
}

export class DocumentContextProvider implements ContextProvider {
  readonly name = 'document-context';
  private chunks: Chunk[] = [];
  private idf = new Map<string, number>();
  private loaded = false;

  constructor(private readonly docsDir: string) {}

  /** Build the in-memory index. Idempotent; call `reload()` to force a rebuild. */
  async load(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    const chunks: Chunk[] = [];
    const root = this.docsDir;
    try {
      await stat(root);
    } catch {
      // Directory missing — index stays empty (valid: "no context found").
      this.chunks = [];
      this.idf = new Map();
      this.loaded = true;
      return;
    }

    const files = await walk(root);
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      const rel = relative(process.cwd(), file);
      for (const c of chunkMarkdown(rel, raw)) {
        const tokens = tokenize(`${c.title} ${c.content}`);
        chunks.push({ ...c, tf: termFrequencies(tokens), length: tokens.length || 1 });
      }
    }

    // Document frequency -> idf.
    const df = new Map<string, number>();
    for (const c of chunks) {
      for (const term of c.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const n = Math.max(chunks.length, 1);
    const idf = new Map<string, number>();
    for (const [term, freq] of df) idf.set(term, Math.log(1 + n / freq));

    this.chunks = chunks;
    this.idf = idf;
    this.loaded = true;
  }

  async search(query: string, options: ContextSearchOptions = {}): Promise<ContextResult[]> {
    await this.load();
    if (this.chunks.length === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];
    const queryTf = termFrequencies(queryTerms);

    const raw = this.chunks
      .filter((c) => !options.kinds || options.kinds.includes(c.kind))
      .map((c) => {
        let score = 0;
        for (const [term, qf] of queryTf) {
          const tf = c.tf.get(term);
          if (!tf) continue;
          const idf = this.idf.get(term) ?? 0;
          // BM25-lite: saturating tf, length-normalized, weighted by idf and query freq.
          const norm = tf / (tf + 1.5 * (0.25 + (0.75 * c.length) / 200));
          score += qf * idf * norm;
        }
        return { chunk: c, score };
      })
      .filter((r) => r.score > 0);

    if (raw.length === 0) return [];

    const max = Math.max(...raw.map((r) => r.score));
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0;

    return raw
      .map((r) => ({
        id: r.chunk.id,
        kind: r.chunk.kind,
        source: r.chunk.source,
        title: r.chunk.title,
        content: r.chunk.content,
        score: Number((r.score / max).toFixed(4)),
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
