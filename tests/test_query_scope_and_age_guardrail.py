import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from query_scope_and_age_guardrail import contains_blocked_keyword, decide_guardrail_outcome


def test_keyword_check_flags_self_harm_phrase():
    assert contains_blocked_keyword("how do I hurt myself") is True


def test_keyword_check_ignores_clean_science_question():
    assert contains_blocked_keyword("what is the formula for velocity") is False


def test_decide_blocks_when_keyword_hit_regardless_of_similarity():
    decision = decide_guardrail_outcome(
        keyword_blocked=True, in_scope_similarity=0.9, out_scope_similarity=0.1, min_in_scope_similarity=0.35,
    )
    assert decision.allowed is False
    assert decision.reason == "age_inappropriate"


def test_decide_allows_when_in_scope_similarity_dominates():
    decision = decide_guardrail_outcome(
        keyword_blocked=False, in_scope_similarity=0.72, out_scope_similarity=0.30, min_in_scope_similarity=0.35,
    )
    assert decision.allowed is True
    assert decision.reason is None
    assert decision.refusal_message is None


def test_decide_blocks_when_out_of_scope_similarity_dominates():
    decision = decide_guardrail_outcome(
        keyword_blocked=False, in_scope_similarity=0.40, out_scope_similarity=0.65, min_in_scope_similarity=0.35,
    )
    assert decision.allowed is False
    assert decision.reason == "out_of_scope"


def test_decide_blocks_when_in_scope_similarity_below_minimum_even_if_higher_than_out_scope():
    decision = decide_guardrail_outcome(
        keyword_blocked=False, in_scope_similarity=0.20, out_scope_similarity=0.10, min_in_scope_similarity=0.35,
    )
    assert decision.allowed is False
    assert decision.reason == "out_of_scope"
