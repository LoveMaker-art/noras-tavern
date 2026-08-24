"""Bounded, coalescing background jobs without external services."""

from __future__ import annotations

import os
import queue
import sys
import threading
import traceback


class CoalescingJobRunner:
    """Run a small number of keyed jobs and coalesce repeated submissions.

    A repeated key waiting in the queue simply receives the newest arguments.  A
    key submitted while it is running is scheduled exactly once more afterwards.
    This fits Tavern's derived-state jobs: bursts should converge on the latest
    production state, not create one model request thread per message.
    """

    def __init__(self, workers=2, max_keys=128, name="tavern-bg"):
        self.workers = max(1, int(workers))
        self.max_keys = max(self.workers, int(max_keys))
        self.name = name
        self._queue = queue.Queue()
        self._jobs = {}
        self._queued = set()
        self._running = set()
        self._rerun = set()
        self._lock = threading.Lock()
        for index in range(self.workers):
            threading.Thread(
                target=self._worker,
                name=f"{self.name}-{index + 1}",
                daemon=True,
            ).start()

    def submit(self, key, function, *args, **kwargs):
        with self._lock:
            if key not in self._jobs and len(self._jobs) >= self.max_keys:
                return False
            self._jobs[key] = (function, args, kwargs)
            if key in self._running:
                self._rerun.add(key)
                return True
            if key in self._queued:
                return True
            self._queued.add(key)
            self._queue.put_nowait(key)
            return True

    def is_active(self, key):
        with self._lock:
            return key in self._jobs

    def stats(self):
        with self._lock:
            return {
                "workers": self.workers,
                "queued": len(self._queued),
                "running": len(self._running),
                "tracked": len(self._jobs),
                "capacity": self.max_keys,
            }

    def _worker(self):
        while True:
            key = self._queue.get()
            with self._lock:
                self._queued.discard(key)
                self._running.add(key)
                job = self._jobs.get(key)
            try:
                if job:
                    function, args, kwargs = job
                    function(*args, **kwargs)
            except Exception:
                print(f"background job failed: {key!r}", file=sys.stderr, flush=True)
                traceback.print_exc()
            finally:
                with self._lock:
                    self._running.discard(key)
                    if key in self._rerun:
                        self._rerun.discard(key)
                        self._queued.add(key)
                        self._queue.put_nowait(key)
                    else:
                        self._jobs.pop(key, None)
                self._queue.task_done()


def tavern_job_runner():
    return CoalescingJobRunner(
        workers=int(os.environ.get("TAVERN_BACKGROUND_WORKERS", "2")),
        max_keys=int(os.environ.get("TAVERN_BACKGROUND_MAX_KEYS", "128")),
    )
