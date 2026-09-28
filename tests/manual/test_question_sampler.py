from question_sampler import sample_questions


def test_sample_questions_picks_per_doc_limit():
    chunks = [
        {"source": "a.pdf", "chunk_id": 0, "text": "Photosynthesis is the process plants use to make food. More text here about chlorophyll and sunlight absorption in leaves."},
        {"source": "a.pdf", "chunk_id": 1, "text": "The mitochondria is the powerhouse of the cell. Extra filler words to pad this chunk out further."},
        {"source": "a.pdf", "chunk_id": 2, "text": "A third chunk from the same document that should be dropped by the per_doc limit of two."},
        {"source": "b.pdf", "chunk_id": 0, "text": "Light travels in straight lines called rays. This is the basis of the rectilinear propagation of light."},
    ]

    result = sample_questions(chunks, per_doc=2)

    sources = [q["source"] for q in result]
    assert sources.count("a.pdf") == 2
    assert sources.count("b.pdf") == 1
    assert all(q["query"] for q in result)


def test_sample_questions_skips_too_short_text():
    chunks = [
        {"source": "a.pdf", "chunk_id": 0, "text": "ok"},
        {"source": "a.pdf", "chunk_id": 1, "text": "This is a properly long first sentence to use as a query. Trailing text."},
    ]

    result = sample_questions(chunks, per_doc=2)

    assert len(result) == 1
    assert result[0]["chunk_id"] == 1


def test_sample_questions_truncates_to_12_words():
    chunks = [{
        "source": "a.pdf", "chunk_id": 0,
        "text": "one two three four five six seven eight nine ten eleven twelve thirteen fourteen. next sentence.",
    }]

    result = sample_questions(chunks, per_doc=1)

    assert len(result[0]["query"].split()) <= 12
