"""Hermes entrypoint; implementation is owned by the reviewed Tavern ops tree."""
import importlib.util
import sys


def register(ctx):
    from hermes_constants import get_hermes_home
    root = get_hermes_home() / 'apps/tavern-ops/updater/activation'
    name = '_tavern_update_activation'
    spec = importlib.util.spec_from_file_location(name, root / '__init__.py', submodule_search_locations=[str(root)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    gateway = importlib.import_module(name + '.gateway')
    gateway.register(ctx)
