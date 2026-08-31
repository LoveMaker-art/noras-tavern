"""Opt-in crash matrix: abrupt process exit after EVERY actual switch rename.

Uses real archives, the current updater engine, durable receipts and filesystem
renames. Only service/model/platform I/O is replaced by the existing fixture.
"""
import json
from pathlib import Path
import subprocess
import sys

import test_clean_update as fixture_module


CHILD = r'''
import json, os, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from clean_update import CleanUpdater
from test_full_update import Service
import tree_transaction as trees
service = Service()
original = trees.rename
def interrupted(source, target):
    original(source, target)
    record = json.loads((Path(sys.argv[4]) / 'receipt.json').read_text())
    index = record['applied'][-1]
    entry = record['entries'][index]
    if index == int(sys.argv[6]) and str(target) == entry[sys.argv[7]]:
        os._exit(73)
trees.rename = interrupted
CleanUpdater(sys.argv[3], lifecycle=service, port=54321).apply(sys.argv[4], sys.argv[5])
'''


def main():
    fixture = fixture_module.CleanUpdateTests()
    fixture.setUp()
    try:
        f, updater = fixture.fixture, fixture.u
        seed = f.review()
        f.apply(seed)
        entries = json.loads((Path(seed['transaction']) / 'receipt.json').read_text())['entries']
        updater.rollback(seed['transaction'], seed['planDigest'])
        cases = [(index, 'backup', entry['name']) for index, entry in enumerate(entries) if entry['hadOld']]
        cases += [(index, 'target', entry['name']) for index, entry in enumerate(entries)
                  if Path(entry['source']).exists()]
        for index, side, name in cases:
            before = f.snapshot()
            review = f.review()
            result = subprocess.run([sys.executable, '-B', '-c', CHILD,
                str(fixture_module.fixtures.OPS / 'updater'), str(fixture_module.fixtures.OPS / 'tests'),
                str(fixture.home), review['transaction'], review['planDigest'], str(index), side],
                capture_output=True, text=True, timeout=30)
            assert result.returncode == 73, (index, side, name, result.stderr[-2000:])
            recovered = updater.rollback(review['transaction'], review['planDigest'])
            assert recovered['status'] == 'rolled-back', name
            assert f.snapshot() == before, (index, side, name)
        print(json.dumps({'crashPoints': len(cases), 'entries': len(entries), 'allRecovered': True,
                          'realRenamesAndReceipts': True, 'realProductionServices': False}))
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    main()
