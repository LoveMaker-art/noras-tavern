#!/usr/bin/env python3
"""Chat entry for the same native configuration used by the launcher."""
import argparse
import json
import os
from pathlib import Path
import runpy
import sys

native_config = None


def main():
    global native_config
    parser = argparse.ArgumentParser()
    parser.add_argument('--wizard', action='store_true')
    parser.add_argument('--region', default='')
    parser.add_argument('--verify-authorized', action='store_true')
    args = parser.parse_args()
    raw = os.environ.get('HERMES_HOME', '')
    if not raw or not Path(raw).is_absolute():
        raise ValueError('未找到当前实例的HERMES_HOME。')
    home = Path(raw).resolve()
    if not Path(__file__).resolve().is_relative_to(home / 'skills'):
        raise ValueError('技能不属于当前Nora实例。')
    resolver = home / 'scripts/nora-instance.py'
    if resolver.is_symlink() or not resolver.is_file() or not resolver.resolve().is_relative_to(home):
        raise ValueError('当前核心缺少实例定位组件；原配置未修改。')
    paths = runpy.run_path(str(resolver))
    instance = paths['verify_hermes_python'](home, paths['configuration'](home))
    tavern = Path(instance['installRoot'])
    shared = tavern / 'apps/tavern-ops/installer'
    for name in ('hermes_model_config.py', 'hermes_model_probe.py'):
        target = shared / name
        if target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(tavern.resolve()):
            raise ValueError('当前核心缺少共用模型配置组件；原配置未修改，不需要打开启动器。')
    os.environ['HERMES_INSTALL_DIR'] = instance['hermesInstallDir']
    sys.path.insert(0, instance['hermesInstallDir'])
    sys.path.insert(0, str(shared))
    import hermes_model_config as native_config
    if args.wizard:
        result = native_config.configure(home, instance, {'verify_authorized': args.verify_authorized},
                                         wizard=True, region=args.region)
    else:
        request = _body()
        native_config.remember(request.get('api_key'))
        action = request.get('action', 'save')
        if action == 'inspect':
            result = native_config.inspect(home, instance)
        elif action == 'catalog':
            result = native_config.catalog(home)
        elif action == 'save':
            result = native_config.configure(home, instance, request)
        elif action == 'switch':
            if set(request) - {'action', 'id', 'verify_authorized'}:
                raise ValueError('切换已有模型只接收配置ID和验证授权。')
            result = native_config.switch(home, instance, request.get('id'),
                                          verify_authorized=request.get('verify_authorized') is True)
        else:
            raise ValueError('不支持这个配置操作。')
    print(json.dumps(result, ensure_ascii=False))


def _body():
    if sys.stdin.isatty():
        from getpass import getpass
        raw = getpass('配置 JSON（输入不回显）: ')
    else:
        raw = sys.stdin.readline(131073)
    if len(raw) > 131072:
        raise ValueError('配置输入过长。')
    data = json.loads(raw)
    fields = {'action', 'id', 'provider', 'model', 'api_key', 'base_url', 'auth_mode',
              'verify_authorized', 'native_config', 'environment'}
    if not isinstance(data, dict) or set(data) - fields:
        raise ValueError('输入包含不支持的配置字段。')
    for key, value in data.items():
        expected = bool if key == 'verify_authorized' else dict if key in {'native_config', 'environment'} else str
        if type(value) is not expected:
            raise ValueError('模型配置输入类型不正确。')
    return data


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = '输入或安装记录不是有效JSON。' if isinstance(error, json.JSONDecodeError) else str(error)
        if native_config is not None:
            message = native_config.redact(message)
        print(json.dumps({'ok': False, 'error': message[:400]}, ensure_ascii=False))
        raise SystemExit(1)
