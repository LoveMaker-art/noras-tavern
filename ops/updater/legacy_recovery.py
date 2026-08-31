"""Recovery-only adapter for pre-directory receipts; never performs new updates."""
import json
import os
from pathlib import Path

from bundle import digest
from update import ReleaseReview, NativeLifecycle, atomic, content, json_write, sha


class LegacyRecovery(ReleaseReview):
    def __init__(self, home, *, lifecycle=None):
        super().__init__(home, lifecycle=lifecycle)
        self.lifecycle = lifecycle or LegacyLifecycle(self)

    def review(self, *_args, **_kwargs):
        raise ValueError('Legacy adapter accepts existing recovery receipts only')

    def apply(self, *_args, **_kwargs):
        raise ValueError('Legacy file-level updates are retired; review with the current updater')

    def _load_plan(self, transaction, expected):
        transaction, plan = super()._load_plan(transaction, expected)
        if plan.get('cleanTransaction') or plan.get('isolatedClean'):
            raise ValueError('Directory transactions cannot use legacy recovery')
        receipt = json.loads((transaction / 'receipt.json').read_text())
        if receipt.get('planDigest') != expected or not isinstance(receipt.get('actual'), list):
            raise ValueError('Invalid legacy recovery receipt')
        return transaction, plan

    def _restore(self, transaction, receipt):
        # Preflight the whole recovery so a hotfix cannot cause a partial restore.
        for i in reversed(receipt["applied"]):
            change = receipt["actual"][i]
            target = self._target(change["name"])
            if sha(target) not in (change["after"], change["before"]):
                receipt["status"] = "recovery-blocked-concurrent-change"
                json_write(transaction / "receipt.json", receipt)
                raise ValueError("Recovery preserved a concurrent modification: " + change["name"])
            old = content(transaction / "backup" / str(i)) if change["before"] is not None else None
            if (digest(old) if old is not None else None) != change["before"]:
                raise ValueError("Recovery backup checksum mismatch")
        self.lifecycle.stop()
        for i in reversed(receipt["applied"]):
            change = receipt["actual"][i]
            target = self._target(change["name"])
            old = content(transaction / "backup" / str(i)) if change["before"] is not None else None
            atomic(target, old, change["mode"])
        self.lifecycle.restore(transaction)
        atomic(self.root / "installed.json", content(transaction / "backup/baseline.json"))
        receipt.update(status="rolled-back", hermesReloadRequired=True, freshSessionRequired=True)
        json_write(transaction / "receipt.json", receipt)
        return receipt

    def rollback(self, transaction, expected):
        with self.lock():
            transaction, plan = self._load_plan(transaction, expected)
            receipt = json.loads((transaction / "receipt.json").read_text())
            if receipt["status"] == "rolled-back":
                return receipt
            baseline = self.root / "installed.json"
            if baseline.exists() and receipt["status"] == "installed-awaiting-hermes-reload":
                if json.loads(baseline.read_text()).get("transaction") != transaction.name:
                    raise ValueError("A newer transaction is installed; refusing stale rollback")
            if baseline.exists() and json.loads(baseline.read_text()).get("manifestSha256") not in (plan["manifestSha256"], None):
                if sha(baseline) != plan["previousBaseline"]:
                    raise ValueError("A different release was installed; refusing stale rollback")
            return self._restore(transaction, receipt)


class LegacyLifecycle(NativeLifecycle):
    def restore(self, transaction):
        # The reviewed lifecycle can boot either schema-2 source snapshot; do
        # not run an older start() that rewrites operator config on rollback.
        self.module_path = transaction / "source/app/native_lifecycle.py"
        journal = transaction / "dependencies.json"
        if journal.exists():
            for entry in reversed(json.loads(journal.read_text())):
                target, old, source = (Path(entry[k]) for k in ("target", "backup", "source"))
                # If the source still exists the dependency switch never finished.
                if not source.exists() and target.exists():
                    os.replace(target, source)
                if old.exists():
                    os.replace(old, target)
        marker = transaction / "backup/dependency-marker"
        if marker.exists():
            atomic(self.runtime().dependencies_marker, marker.read_bytes())
        self.runtime().start(port=self.port, assets_prepared=True)
