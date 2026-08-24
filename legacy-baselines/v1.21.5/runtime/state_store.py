"""Small, dependency-free persistence boundary for Tavern JSON state."""

from __future__ import annotations

import json
import os
import re
import secrets
import threading


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class InvalidStateIdentifier(ValueError):
    """Raised when an external identifier cannot safely name a state file."""


class JsonStateStore:
    """Atomic JSON storage with one controlled path construction point.

    The store intentionally stays file-backed.  Tavern currently has a tiny state
    set, so a database or resident cache would add operational weight without a
    measurable benefit.  Namespace locks make individual read/modify/write flows
    composable while keeping the existing on-disk format intact.
    """

    NAMESPACES = frozenset({"cards", "worldbooks", "productions"})

    def __init__(self, root: str):
        self.root = os.path.realpath(root)
        self._locks = {name: threading.RLock() for name in self.NAMESPACES}
        for name in self.NAMESPACES:
            os.makedirs(os.path.join(self.root, name), exist_ok=True)

    @staticmethod
    def validate_identifier(value: object) -> str:
        identifier = str(value or "")
        if not _IDENTIFIER.fullmatch(identifier):
            raise InvalidStateIdentifier(
                "id must be 1-128 ASCII letters, digits, underscores, or hyphens"
            )
        return identifier

    def path(self, namespace: str, identifier: object) -> str:
        if namespace not in self.NAMESPACES:
            raise ValueError(f"unknown state namespace: {namespace}")
        safe_id = self.validate_identifier(identifier)
        directory = os.path.join(self.root, namespace)
        candidate = os.path.realpath(os.path.join(directory, safe_id + ".json"))
        if os.path.commonpath((directory, candidate)) != directory:
            raise InvalidStateIdentifier("state path escapes its namespace")
        return candidate

    def read(self, namespace: str, identifier: object, default=None):
        path = self.path(namespace, identifier)
        try:
            with open(path, encoding="utf-8") as file:
                return json.load(file)
        except FileNotFoundError:
            return default

    def write(self, namespace: str, identifier: object, value) -> None:
        path = self.path(namespace, identifier)
        temporary = path + ".tmp." + secrets.token_hex(4)
        with self._locks[namespace]:
            try:
                with open(temporary, "w", encoding="utf-8") as file:
                    json.dump(value, file, ensure_ascii=False, indent=2)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary, path)
            finally:
                try:
                    os.remove(temporary)
                except FileNotFoundError:
                    pass

    def update(self, namespace: str, identifier: object, mutator, default=None):
        """Atomically read, mutate and replace one JSON document in this process."""
        if namespace not in self.NAMESPACES:
            raise ValueError(f"unknown state namespace: {namespace}")
        with self._locks[namespace]:
            current = self.read(namespace, identifier, default)
            updated = mutator(current)
            if updated is None:
                raise ValueError("state mutator must return the updated document")
            self.write(namespace, identifier, updated)
            return updated

    def delete(self, namespace: str, identifier: object) -> bool:
        path = self.path(namespace, identifier)
        with self._locks[namespace]:
            try:
                os.remove(path)
                return True
            except FileNotFoundError:
                return False

    def list(self, namespace: str):
        if namespace not in self.NAMESPACES:
            raise ValueError(f"unknown state namespace: {namespace}")
        directory = os.path.join(self.root, namespace)
        items = []
        with self._locks[namespace]:
            for filename in sorted(os.listdir(directory)):
                if not filename.endswith(".json"):
                    continue
                identifier = filename[:-5]
                try:
                    item = self.read(namespace, identifier)
                except (InvalidStateIdentifier, json.JSONDecodeError, OSError):
                    # A single damaged or foreign file must not break the library.
                    continue
                if item is not None:
                    items.append(item)
        return items
