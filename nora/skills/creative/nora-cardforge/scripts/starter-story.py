"""Stage an explicitly selected built-in card; importing remains a Nora MCP operation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile


def stage(home, resources, story, request_id):
    home = Path(home).resolve()
    if not (home / 'nora-instance.json').is_file():
        configuration = runpy.run_path(str(home / 'scripts/nora-instance.py'))['configuration']
        instance = configuration(home)
        root = Path(instance['installRoot']).resolve()
        if root != home:
            raise ValueError('独立安装的样例必须位于当前 Hermes 目录内')
    else:
        instance = json.loads((home / 'nora-instance.json').read_text(encoding='utf-8'))
        root = Path(instance['installRoot']).resolve()
        parent = Path(instance['noraHome']).resolve()
        if (instance.get('schema') != 1 or Path(instance['hermesHome']).resolve() != home
                or not home.is_relative_to(parent) or home == parent
                or not root.is_relative_to(parent) or root == parent or root == home):
            raise ValueError('样例必须在本次隔离安装中加载')
    manifest = json.loads((resources / 'manifest.json').read_text(encoding='utf-8'))
    item = next((item for item in manifest['stories'] if item['id'] == story), None)
    if not item or not request_id or len(request_id) > 256:
        raise ValueError('样例或创建标识无效')
    source = (resources / item['file']).resolve()
    if not source.is_relative_to(resources.resolve()):
        raise ValueError('样例文件越界')
    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != item['sha256']:
        raise ValueError('样例文件未通过完整性检查')
    card = json.loads(content)
    if card.get('spec') != 'chara_card_v2' or card.get('data', {}).get('name') != item['name']:
        raise ValueError('样例内容不匹配')
    destination = root / 'tavern-state/imports'
    if not destination.resolve().is_relative_to(root):
        raise ValueError('上传目录越界')
    destination.mkdir(parents=True, exist_ok=True)
    key = 'starter-' + hashlib.sha256((story + ':' + request_id).encode()).hexdigest()
    target = destination / (key + '.json')
    if target.is_symlink():
        raise ValueError('拒绝覆盖链接文件')
    if target.exists() and target.read_bytes() != content:
        raise ValueError('本次请求已有不同内容，未覆盖')
    if not target.exists():
        fd, temporary = tempfile.mkstemp(prefix='.starter-', dir=destination)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {'ok': True, 'name': item['name'], 'filePath': str(target), 'idempotencyKey': key, 'imported': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--story', required=True)
    parser.add_argument('--request-id', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(stage(Path(os.environ['HERMES_HOME']), Path(__file__).resolve().parents[1] / 'resources/starter-stories',
                               args.story, args.request_id), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
