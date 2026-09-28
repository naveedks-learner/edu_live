"""
Pure helper: turns already-indexed chunks into retrieval test questions,
so test_retrieval.py never hardcodes questions - any newly-ingested
document is covered automatically the next time the suite runs.
"""


def sample_questions(chunks: list[dict], per_doc: int = 2) -> list[dict]:
    per_source_count: dict[str, int] = {}
    questions = []

    for chunk in chunks:
        source = chunk["source"]
        if per_source_count.get(source, 0) >= per_doc:
            continue

        first_sentence = chunk["text"].split(". ")[0]
        words = first_sentence.split()
        if len(words) < 3:
            continue

        query = " ".join(words[:12]).strip()
        questions.append({"source": source, "query": query, "chunk_id": chunk.get("chunk_id")})
        per_source_count[source] = per_source_count.get(source, 0) + 1

    return questions
