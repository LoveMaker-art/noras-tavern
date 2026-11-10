import contextlib, json, shutil, subprocess, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
CLOSURE_PREFIX = "NORA_FIXTURE_CLOSURE "

@contextlib.contextmanager
def owned_fixture_directory(prefix):
    """Retain a fresh root whenever an admitted helper lacks actual close proof."""
    fixture = SimpleNamespace(root=Path(tempfile.mkdtemp(prefix=prefix)).resolve(), closed=True)
    try:
        yield fixture
    finally:
        if fixture.closed:
            shutil.rmtree(fixture.root)
        else:
            message = f'Retaining owned fixture without closure proof: {fixture.root}'
            primary = sys.exc_info()[1]
            if primary is None:
                raise RuntimeError(message)
            if hasattr(primary, 'add_note'):
                primary.add_note(message)
            else:
                primary.fixture_root = str(fixture.root)

def require_fixture_closure(fixture, output):
    fixture.closed = False
    records = [json.loads(line[len(CLOSURE_PREFIX):]) for line in output.splitlines()
               if line.startswith(CLOSURE_PREFIX)]
    if (len(records) != 1 or set(records[0]) != {'schema', 'root', 'closed'}
            or records[0]['schema'] != 'nora-fixture-closure/1'
            or not isinstance(records[0]['root'], str)
            or Path(records[0]['root']).resolve() != fixture.root
            or records[0]['closed'] is not True):
        raise RuntimeError(f'Owned fixture closure proof is missing or invalid; retained: {fixture.root}')
    fixture.closed = True

def close_fixture_child(child, timeout=2):
    """Close only the Popen we held; a TERM request is not proof of exit."""
    if child.poll() is None:
        try:
            child.terminate()
        except ProcessLookupError:
            pass
    streams = [getattr(child, name, None) for name in ('stdin', 'stdout', 'stderr')]
    try:
        if any(stream is not None and not stream.closed for stream in streams):
            child.communicate(timeout=timeout)
        else:
            child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.kill()
        if any(stream is not None and not stream.closed for stream in streams):
            child.communicate(timeout=timeout)
        else:
            child.wait(timeout=timeout)
    if child.poll() is None:
        raise RuntimeError('Held fixture child closure remains unconfirmed')
    for stream in streams:
        if stream is not None and not stream.closed:
            stream.close()

def cleanup_fixture_children(self):
        failures = []
        for child in self.fixture_children:
            try:
                close_fixture_child(child)
            except Exception as error:
                failures.append(error)
        if failures:
            raise RuntimeError(f'Retaining fixture with unconfirmed child closure: {self.root}') from failures[0]
        shutil.rmtree(self.root)
