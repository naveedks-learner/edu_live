"""
Pre-flight gate that runs on every incoming question BEFORE any retrieval or
LLM call: blocks questions that are (a) outside science/maths scope or
(b) age-inappropriate for a 16-17 year old audience, and returns a friendly
refusal instead of letting the question reach the agentic pipeline.

Deliberately makes NO LLM API call - at the volumes this product targets,
an extra classification call per question was ruled out as a cost/latency
bottleneck. Everything here runs locally and for free:

- contains_blocked_keyword(): a small substring blocklist that hard-blocks
  the clearest age-inappropriate categories (self-harm, sexual content,
  drugs, violence) regardless of what the similarity check below thinks.
- Embedding similarity: the question is compared (via the same
  sentence-transformers model store.py already loads for retrieval, so
  there's no new dependency or extra download) against two small reference
  sets - example in-scope science/maths questions and example out-of-scope
  questions - and is allowed through only if it's clearly closer to the
  in-scope set than the out-of-scope set, and clearly close to *something*
  recognizable as in-scope.

decide_guardrail_outcome() is the pure decision logic (no ML calls), kept
separate from the embedding plumbing so it's trivially unit-testable and
so the threshold/policy can be reasoned about on its own.

Toggle: set GUARDRAIL_ENABLED=false in .env to disable this gate entirely
(see config.guardrail_enabled()). Default is enabled.
"""

import logging
import re
from dataclasses import dataclass
from functools import lru_cache

logger = logging.getLogger(__name__)

# Substring/phrase blocklist for the clearest age-inappropriate categories.
# Intentionally short and blunt - this is a hard override, not the primary
# scope check (that's the embedding similarity below).
BLOCKED_KEYWORDS = (
    "hurt myself", "kill myself", "self harm", "self-harm", "suicide",
    "cut myself", "want to die",
    "drugs", "cocaine", "heroin", "get high",
    "sex", "porn", "nude", "naked pics",
    "kill someone", "how to make a bomb", "how to make a weapon",
)

IN_SCOPE_EXAMPLE_QUESTIONS = [
    "What is Newton's second law of motion?",
    "How do you factorise a quadratic equation?",
    "Explain the process of photosynthesis.",
    "What is the difference between speed and velocity?",
    "How do you find the derivative of a function?",
    "What are the states of matter?",
    "Explain Ohm's law with an example.",
    "How do you solve a system of linear equations?",
    "What is the periodic table and how is it organized?",
    "What is the Pythagorean theorem?",
]

OUT_OF_SCOPE_EXAMPLE_QUESTIONS = [
    "Who won the football match yesterday?",
    "What's the best movie to watch this weekend?",
    "Can you help me write a message to ask someone out?",
    "What's your favorite celebrity gossip?",
    "How do I get more followers on social media?",
    "Tell me a joke about my teacher.",
    "What should I cook for dinner tonight?",
    "Give me relationship advice.",
]

REFUSAL_AGE_INAPPROPRIATE = (
    "I can't help with that here. If you're going through something "
    "difficult, please talk to a teacher, parent, or trusted adult. "
    "I'm happy to help with science and maths questions any time!"
)

REFUSAL_OUT_OF_SCOPE = (
    "I can only help with science and maths topics here. Try asking me "
    "something from your science or maths syllabus!"
)

DEFAULT_MIN_IN_SCOPE_SIMILARITY = 0.35


@dataclass(frozen=True)
class GuardrailDecision:
    allowed: bool
    reason: str | None  # None, "age_inappropriate", or "out_of_scope"
    refusal_message: str | None


def contains_blocked_keyword(question: str) -> bool:
    text = question.lower()
    return any(re.search(rf"\b{re.escape(term)}\b", text) for term in BLOCKED_KEYWORDS)


def decide_guardrail_outcome(
    keyword_blocked: bool,
    in_scope_similarity: float,
    out_scope_similarity: float,
    min_in_scope_similarity: float = DEFAULT_MIN_IN_SCOPE_SIMILARITY,
) -> GuardrailDecision:
    """
    Pure policy logic, no ML calls - takes already-computed similarity
    scores so it can be unit-tested without loading an embedding model.
    """
    if keyword_blocked:
        return GuardrailDecision(False, "age_inappropriate", REFUSAL_AGE_INAPPROPRIATE)

    if in_scope_similarity < min_in_scope_similarity or in_scope_similarity <= out_scope_similarity:
        return GuardrailDecision(False, "out_of_scope", REFUSAL_OUT_OF_SCOPE)

    return GuardrailDecision(True, None, None)


@lru_cache(maxsize=1)
def _embedding_model():
    from sentence_transformers import SentenceTransformer
    from config import get_embedding_model

    return SentenceTransformer(get_embedding_model())


@lru_cache(maxsize=1)
def _reference_embeddings():
    model = _embedding_model()
    in_scope = model.encode(IN_SCOPE_EXAMPLE_QUESTIONS, normalize_embeddings=True)
    out_scope = model.encode(OUT_OF_SCOPE_EXAMPLE_QUESTIONS, normalize_embeddings=True)
    return in_scope, out_scope


def _mean_cosine_similarity(question_embedding, reference_embeddings) -> float:
    import numpy as np

    return float(np.mean(reference_embeddings @ question_embedding))


def check_query_in_scope_and_age_appropriate(question: str) -> GuardrailDecision:
    """
    The real, wired-up gate: combines the keyword hard-block with local
    embedding similarity against the reference sets above. Call this from
    answer_question() before any retrieval or LLM call.
    """
    keyword_blocked = contains_blocked_keyword(question)

    model = _embedding_model()
    in_scope_refs, out_scope_refs = _reference_embeddings()
    question_embedding = model.encode(question, normalize_embeddings=True)

    in_scope_similarity = _mean_cosine_similarity(question_embedding, in_scope_refs)
    out_scope_similarity = _mean_cosine_similarity(question_embedding, out_scope_refs)

    decision = decide_guardrail_outcome(keyword_blocked, in_scope_similarity, out_scope_similarity)
    if not decision.allowed:
        logger.info(f"guardrail blocked question (reason={decision.reason!r}): {question!r}")
    return decision
