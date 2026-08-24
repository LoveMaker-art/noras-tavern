"""Shared retry policy for Tavern model calls.

Retries are intentionally limited to the model selected for the current task.
This module never chooses another provider or model.
"""

from __future__ import annotations


MAX_MODEL_RETRIES = 5
MAX_MODEL_ATTEMPTS = 1 + MAX_MODEL_RETRIES
RETRY_DELAYS_SECONDS = (1.0, 2.0)


def is_retryable_model_error(error):
    """All model-call failures share the same bounded same-model retry policy."""
    return True


def retry_delay_seconds(failed_attempt):
    """Return the bounded delay after a one-based failed attempt."""
    index = max(0, min(int(failed_attempt) - 1, len(RETRY_DELAYS_SECONDS) - 1))
    return RETRY_DELAYS_SECONDS[index]
