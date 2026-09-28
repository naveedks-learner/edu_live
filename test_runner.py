"""
Standalone manual test suite runner - never auto-wired into pytest/CI.
Run on demand:
    python test_runner.py

Runs every test_*.py suite under tests/manual/, prints a pass/fail/skip
summary per suite, and exits 1 if anything failed (0 if all passed or
were skipped). The LLM suite is skipped, not failed, when the active
provider's API key isn't configured.
"""

import importlib
import inspect
import os
import sys
import traceback

MANUAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "manual")
sys.path.insert(0, MANUAL_DIR)

SUITES = ["test_ingestion", "test_retrieval", "test_llm"]


def _test_functions(module):
    return [
        (name, fn) for name, fn in inspect.getmembers(module, inspect.isfunction)
        if name.startswith("test_") and fn.__module__ == module.__name__
    ]


def _run_suite(suite_name: str) -> tuple[int, int, int]:
    """Returns (passed, failed, skipped) for one suite."""
    print(f"\n=== {suite_name} ===")
    module = importlib.import_module(suite_name)

    if suite_name == "test_llm" and not module.active_provider_key_available():
        for name, _ in _test_functions(module):
            print(f"  SKIP  {name}  (active provider's API key not configured)")
        return 0, 0, len(_test_functions(module))

    passed = failed = 0
    for name, fn in _test_functions(module):
        try:
            fn()
        except Exception as e:
            failed += 1
            print(f"  FAIL  {name}  {e}")
            if not isinstance(e, AssertionError):
                traceback.print_exc()
        else:
            passed += 1
            print(f"  PASS  {name}")
    return passed, failed, 0


def main() -> int:
    total_passed = total_failed = total_skipped = 0
    for suite_name in SUITES:
        passed, failed, skipped = _run_suite(suite_name)
        total_passed += passed
        total_failed += failed
        total_skipped += skipped

    print(f"\n=== summary: {total_passed} passed, {total_failed} failed, {total_skipped} skipped ===")
    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(main())
