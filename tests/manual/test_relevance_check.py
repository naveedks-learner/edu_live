from relevance_check import is_relevant


def _fake_embed(texts):
    # Deterministic stand-in for a real embedding model: texts sharing the
    # "SIMILAR" marker get an identical vector, everything else gets an
    # orthogonal one - lets us test the cosine-similarity branch without
    # loading sentence-transformers.
    vectors = []
    for t in texts:
        vectors.append([1.0, 0.0] if "SIMILAR" in t else [0.0, 1.0])
    return vectors


def test_is_relevant_true_when_keywords_and_similarity_pass():
    ok, reason = is_relevant(
        question="What is chlorophyll?",
        answer="Chlorophyll is the green pigment SIMILAR in plants.",
        context_text="Chlorophyll SIMILAR pigment absorbs light.",
        embed_fn=_fake_embed,
        threshold=0.5,
    )
    assert ok
    assert reason is None


def test_is_relevant_false_when_no_keyword_overlap():
    ok, reason = is_relevant(
        question="What is chlorophyll?",
        answer="Bananas are yellow fruit SIMILAR.",
        context_text="Chlorophyll SIMILAR pigment absorbs light.",
        embed_fn=_fake_embed,
        threshold=0.5,
    )
    assert not ok
    assert "keyword" in reason


def test_is_relevant_false_when_embedding_dissimilar():
    ok, reason = is_relevant(
        question="What is chlorophyll?",
        answer="Chlorophyll is a pigment.",  # no SIMILAR marker -> dissimilar vector
        context_text="Chlorophyll SIMILAR pigment absorbs light.",
        embed_fn=_fake_embed,
        threshold=0.5,
    )
    assert not ok
    assert "similarity" in reason


def test_is_relevant_ignores_stopwords_for_keyword_check():
    # "What is the" are all stopwords - only "chlorophyll" counts, and it's
    # absent from the answer, so this must fail on keyword overlap even
    # though several literal words match.
    ok, reason = is_relevant(
        question="What is the chlorophyll?",
        answer="This is a pigment SIMILAR to what the plant has.",
        context_text="Chlorophyll SIMILAR pigment absorbs light.",
        embed_fn=_fake_embed,
        threshold=0.5,
    )
    assert not ok
    assert "keyword" in reason
