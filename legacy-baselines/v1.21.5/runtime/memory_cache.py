"""Small byte-bounded in-memory caches."""

from __future__ import annotations

from collections import OrderedDict
import threading


class ByteLRUCache:
    def __init__(self, max_items, max_bytes):
        self.max_items = max(1, int(max_items))
        self.max_bytes = max(1, int(max_bytes))
        self._items = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            value = self._items.get(key)
            if value is not None:
                self._items.move_to_end(key)
            return value

    def put(self, key, value):
        size = len(value)
        if size > self.max_bytes:
            return False
        with self._lock:
            previous = self._items.pop(key, None)
            if previous is not None:
                self._bytes -= len(previous)
            self._items[key] = value
            self._bytes += size
            while len(self._items) > self.max_items or self._bytes > self.max_bytes:
                _, removed = self._items.popitem(last=False)
                self._bytes -= len(removed)
            return True

    def delete(self, key):
        with self._lock:
            value = self._items.pop(key, None)
            if value is None:
                return False
            self._bytes -= len(value)
            return True

    def stats(self):
        with self._lock:
            return {
                "items": len(self._items),
                "bytes": self._bytes,
                "max_items": self.max_items,
                "max_bytes": self.max_bytes,
            }
