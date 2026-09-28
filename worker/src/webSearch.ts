export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export function formatWebResultsAsContext(results: WebResult[]): string {
  if (results.length === 0) return "No web results found.";
  return results.map((r) => `[${r.title}](${r.url})\n${r.snippet}`).join("\n\n");
}

/**
 * DuckDuckGo HTML search, no API key - same approach as web_search.py.
 * Never throws: returns an empty array on any failure so the chat
 * pipeline can fall back to "no web results" rather than a 500.
 */
export async function webSearch(query: string, maxResults = 5): Promise<WebResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; edu-live-bot/1.0)" },
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);

    const html = await response.text();
    const results: WebResult[] = [];
    const resultRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      results.push({
        url: match[1],
        title: stripTags(match[2]),
        snippet: stripTags(match[3]),
      });
    }
    return results;
  } catch (err) {
    console.error("web search failed", err);
    return [];
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}
