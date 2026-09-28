"""
Free internet search via DuckDuckGo (no API key required), used as the
"external sources" tool in the Phase 3 agent. See rag.py for how this gets
offered to the LLM as a tool the model can choose to call.
"""

import logging
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


def _domain(url: str) -> str:
    netloc = urlparse(url).netloc.lower()
    return netloc[4:] if netloc.startswith("www.") else netloc


def _matches_any(domain: str, domain_list: list[str]) -> bool:
    return any(domain == d or domain.endswith("." + d) for d in domain_list)


def _domain_allowed(url: str, allowed_domains: list[str] | None, blocked_domains: list[str] | None) -> bool:
    domain = _domain(url)
    if blocked_domains and _matches_any(domain, blocked_domains):
        return False
    if allowed_domains and not _matches_any(domain, allowed_domains):
        return False
    return True


def web_search(
    query: str,
    max_results: int = 5,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> list[dict]:
    """
    Returns [{"title": ..., "url": ..., "snippet": ...}, ...]
    Empty allowed_domains/blocked_domains = no restriction (search everything).
    Never raises: a failed search returns an empty list so the agent loop
    can keep going and tell the user the search didn't work.
    """
    from ddgs import DDGS

    filtering = bool(allowed_domains or blocked_domains)
    fetch_count = max_results * 4 if filtering else max_results

    logger.debug(f"web_search: query={query!r} max_results={max_results}")
    try:
        raw_results = list(DDGS().text(query, max_results=fetch_count))
    except Exception as e:
        logger.warning(f"web_search failed for query {query!r}: {e}")
        return []

    results = []
    for r in raw_results:
        url = r.get("href", "")
        if filtering and not _domain_allowed(url, allowed_domains, blocked_domains):
            continue
        results.append({"title": r.get("title", ""), "url": url, "snippet": r.get("body", "")})
        if len(results) >= max_results:
            break

    return results


if __name__ == "__main__":
    # quick manual test: python web_search.py <query>
    import sys

    q = " ".join(sys.argv[1:]) or "what is photosynthesis"
    for r in web_search(q, max_results=3):
        print(f"- {r['title']} ({r['url']})\n  {r['snippet'][:120]}\n")
