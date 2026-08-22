/**
 * /api/search route — full-text search across conversations
 */

import type { Hono } from "hono";
import { rpc } from "../routing.js";
import { getMetadata } from "../metadata.js";
import { handleRPCError } from "../errors.js";

// ── Step text cache ──

interface StepCache {
  texts: string[]; // searchable text fragments
  fetchedAt: number;
}

const stepCache = new Map<string, StepCache>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Extract searchable text from a step */
export function extractStepText(step: Record<string, unknown>): string {
  const parts: string[] = [];

  // User input
  const ui = step.userInput as Record<string, unknown> | undefined;
  if (ui?.items) {
    for (const item of ui.items as Record<string, unknown>[]) {
      if (item.text) parts.push(item.text as string);
    }
  }

  // Planner response
  const pr = step.plannerResponse as Record<string, unknown> | undefined;
  if (pr) {
    if (pr.modifiedResponse) parts.push(pr.modifiedResponse as string);
    if (pr.thinking) parts.push(pr.thinking as string);
  }

  // Run command
  const rc = step.runCommand as Record<string, unknown> | undefined;
  if (rc) {
    if (rc.commandLine) parts.push(rc.commandLine as string);
    if (rc.command) parts.push(rc.command as string);
  }

  // Code action
  const ca = step.codeAction as Record<string, unknown> | undefined;
  if (ca?.description) parts.push(ca.description as string);

  // Grep search
  const gs = step.grepSearch as Record<string, unknown> | undefined;
  if (gs?.query) parts.push(gs.query as string);

  return parts.join(" ");
}

export function clearSearchStepCache(): void {
  stepCache.clear();
}

/** Fetch and cache step texts for a conversation (with timeout) */
export async function getStepTexts(cascadeId: string): Promise<string[]> {
  const cached = stepCache.get(cascadeId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.texts;
  }

  const texts: string[] = [];
  let offset = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const metadata = await getMetadata(true);
    while (true) {
      const page = (await rpc.call("GetCascadeTrajectorySteps", {
        metadata,
        cascadeId,
        offset,
      })) as { steps?: Record<string, unknown>[] };

      const steps = page.steps ?? [];
      if (steps.length === 0) break;

      for (const step of steps) {
        const text = extractStepText(step);
        if (text) texts.push(text);
      }

      offset += steps.length;
      if (steps.length < 500) break;
      if (controller.signal.aborted) break;
    }
  } catch {
    // skip on error
  } finally {
    clearTimeout(timeout);
  }

  stepCache.set(cascadeId, { texts, fetchedAt: Date.now() });
  return texts;
}

/** Run promises with limited concurrency */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

export interface ConversationSearchResultItem {
  id: string;
  title: string;
  snippets: string[];
  matchCount: number;
}

export interface ConversationSearchResult {
  query: string;
  results: ConversationSearchResultItem[];
  totalConversations: number;
  elapsedMs: number;
}

export async function searchConversations(query: string): Promise<ConversationSearchResult> {
  const queryLower = query.trim().toLowerCase();
  const startTime = Date.now();

  let trajectories: Record<string, Record<string, unknown>> = {};
  const metadata = await getMetadata(true);
  const resp = (await rpc.call("GetAllCascadeTrajectories", {
    metadata,
  })) as {
    trajectorySummaries?: Record<string, Record<string, unknown>>;
  };
  trajectories = resp.trajectorySummaries ?? {};

  const entries = Object.entries(trajectories);
  console.log(
    `[search] Searching "${query}" across ${entries.length} conversations...`,
  );

  // Process conversations in parallel (concurrency 5)
  const searchResults = await pMap(
    entries,
    async ([id, summary]) => {
      const title = (summary.title as string) || (summary.summary as string) || id.slice(0, 8);
      const titleMatch = title.toLowerCase().includes(queryLower);
      const texts = await getStepTexts(id);
      const snippets: string[] = [];
      let matchCount = titleMatch ? 1 : 0;

      for (const text of texts) {
        const lower = text.toLowerCase();
        const idx = lower.indexOf(queryLower);
        if (idx !== -1) {
          matchCount++;
          if (snippets.length < 3) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + queryLower.length + 40);
            let snippet = text.slice(start, end).trim();
            if (start > 0) snippet = "…" + snippet;
            if (end < text.length) snippet += "…";
            snippets.push(snippet);
          }
        }
      }

      return matchCount > 0 ? { id, title, snippets, matchCount } : null;
    },
    5,
  );

  const results = searchResults.filter(Boolean) as ConversationSearchResultItem[];
  results.sort((a, b) => b.matchCount - a.matchCount);

  const elapsed = Date.now() - startTime;
  console.log(
    `[search] Done in ${elapsed}ms — ${results.length} matches found`,
  );

  return {
    query,
    results,
    totalConversations: entries.length,
    elapsedMs: elapsed,
  };
}

export function registerSearchRoutes(app: Hono): void {
  app.get("/api/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) {
      return c.json({ error: "Missing 'q' query param" }, 400);
    }
    try {
      const searchResult = await searchConversations(query);
      return c.json(searchResult);
    } catch (err) {
      return handleRPCError(c, err);
    }
  });
}
