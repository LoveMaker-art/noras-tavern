"""Durable, bounded-path recovery of one owned Tavern update transaction."""
import hashlib
from contextlib import contextmanager
import json
import ntpath
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import uuid

RECEIPT = 'nora-update-backup.json'
MAX_TRANSACTION_BYTES = 64 * 1024 * 1024
RECOVERABLE_STATES = ('prepared', 'recovery-failed')
SKILLS = {'creative/tavern','creative/tavern-ops','creative/nora-cardforge',
          'system/tavern-updater','system/model-provider-config'}
RETIRED = {'tavern-world','tavern-runtime-plugins','tavern-continuity',
           'tavern-story-profile','tavern-frontend','tavern-world-visuals'}
MANAGED = {'SOUL.md','SOUL.nora-tavern.example.md','nora-installation.json',
           'cron/jobs.json','clawchat-skills','scripts/nora-instance.py',
           'scripts/nora-tavern-update-check.py','scripts/nora-tavern-card-send.py'}


def _io_path(path):
    """Adapt I/O only; persisted identities keep their ordinary logical paths.

    Mirrors bootstrap.filesystem_path using only stdlib: recovery must remain
    loadable when an interrupted update has removed the installed ops modules.
    """
    value=os.fspath(path)
    if os.name=='nt':
        value=ntpath.normpath(ntpath.abspath(value.replace('/','\\')))
        if not value.startswith('\\\\?\\'):
            value='\\\\?\\UNC\\'+value[2:] if value.startswith('\\\\') else '\\\\?\\'+value
    return Path(value)


def atomic_json(path, value):
    path=_io_path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as stream:
            json.dump(value,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
    finally:
        if os.path.lexists(name):os.unlink(name)


def read(path,*,max_bytes=2*1024*1024):
    path=_io_path(path)
    if linked(path) or path.stat().st_size>max_bytes:raise RuntimeError('恢复记录不是有效文件')
    return json.loads(path.read_text(encoding='utf-8'))


def read_object(path,*,max_bytes=2*1024*1024):
    value=read(path,max_bytes=max_bytes)
    if not isinstance(value,dict):raise RuntimeError('恢复记录必须是 JSON 对象，已保留现场')
    return value


def linked(path):
    try:
        value=_io_path(path).lstat()
        return stat.S_ISLNK(value.st_mode) or bool(getattr(value,'st_file_attributes',0)&0x400)
    except FileNotFoundError:return False


def identity(path):
    try:value=_io_path(path).lstat()
    except FileNotFoundError:return None
    if linked(path) or value.st_ino<=0:raise RuntimeError('恢复目标的文件身份无法安全确认')
    return [value.st_dev,value.st_ino]


def safe_path(root, relative):
    if not isinstance(relative,str) or '\\' in relative or ':' in relative:
        raise RuntimeError('恢复计划路径无效')
    parts=PurePosixPath(relative).parts
    if not parts or PurePosixPath(relative).is_absolute() or any(p in ('.','..') for p in parts):
        raise RuntimeError('恢复计划路径越过安装目录')
    current=Path(root)
    if linked(current):raise RuntimeError('恢复目录不能是链接')
    for part in parts:
        current=current/part
        if linked(current):raise RuntimeError('恢复路径包含链接')
    return current


@contextmanager
def recovery_lock(root):
    """Share the installer's nonblocking, first-byte lock without ops imports."""
    root=Path(root).resolve();_io_path(root).mkdir(parents=True,exist_ok=True)
    path=_io_path(safe_path(root,'tavern-installer.lock'))
    with path.open('a+') as stream:
        try:
            if os.name=='nt':
                import msvcrt
                if path.stat().st_size==0:stream.write('\0');stream.flush()
                stream.seek(0);msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('另一项安装或更新操作正在进行，请结束后再恢复。') from error
        try:yield
        finally:
            if os.name=='nt':
                stream.seek(0);msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(stream.fileno(),fcntl.LOCK_UN)


def digest(path):
    """Hash regular bytes and link names without following nested junctions."""
    path=_io_path(path);result=hashlib.sha256()
    def visit(current,relative):
        value=current.lstat()
        if linked(current):
            result.update(b'L'+relative.encode()+b'\0'+os.fsencode(os.readlink(current)));return
        if stat.S_ISDIR(value.st_mode):
            result.update(b'D'+relative.encode()+b'\0')
            for child in sorted(current.iterdir(),key=lambda p:p.name):visit(child,relative+'/'+child.name)
        elif stat.S_ISREG(value.st_mode):
            result.update(b'F'+relative.encode()+b'\0')
            with current.open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
        else:raise RuntimeError('恢复备份含不支持的文件类型')
    visit(path,'');return result.hexdigest()


def reject_links(path):
    """Copy-only snapshots cannot contain links or Windows junctions."""
    path=_io_path(path)
    if linked(path):raise RuntimeError('配置或剧情快照包含链接，未读取目录外文件')
    if path.is_dir():
        for child in path.iterdir():reject_links(child)


def restore_permissions(saved,target):
    saved,target=_io_path(saved),_io_path(target)
    shutil.copystat(saved,target,follow_symlinks=False)
    if saved.is_dir():
        for child in saved.iterdir():restore_permissions(child,target/child.name)


def story_inventory(state):
    state=_io_path(state);result={}
    # Operational pid/status/log files change during a verified restart.
    # Story resources must retain their exact original bytes.
    native=state/'native'
    directories=[]
    if native.is_dir():
        for user in native.iterdir():
            if linked(user):raise RuntimeError('剧情备份包含目录链接')
            if user.is_dir():
                directories.extend(user/relative for relative in (
                    'nora-world-core/worlds','chats','group chats','worlds','characters',
                    'backups','nora-story-ledger','nora-world-core/operations'))
    directories.extend(path for path in state.iterdir()
                       if path.is_file() and path.name not in ('.lock',))
    for directory in directories:
        if not directory.exists():continue
        files=[directory] if directory.is_file() else directory.rglob('*')
        for file in files:
            if linked(file):raise RuntimeError('剧情备份包含文件链接')
            if file.is_file():result[file.relative_to(state).as_posix()]=digest(file)
    return result


def allowed_target(name, namespace, relative):
    if not all(isinstance(value,str) for value in (name,namespace,relative)):return False
    if namespace=='install':
        return {'app':'apps/tavern-runtime','ops':'apps/tavern-ops',
                'nora-mcp':'apps/nora-mcp'}.get(name)==relative
    if namespace!='hermes':return False
    if name.startswith('skill-'):
        return any(name=='skill-'+s.replace('/','-') and relative=='skills/'+s for s in SKILLS)
    if name.startswith('retired-'):
        return any(name=='retired-'+s and relative=='skills/creative/'+s for s in RETIRED)
    if name=='host-hook-tavern-liveware-register':return relative=='hooks/tavern-liveware-register'
    if name.startswith('clawchat-greeting-'):
        stem=name[len('clawchat-greeting-'):]
        return stem in ('adapter','storage') and relative=='plugins/clawchat/clawchat_gateway/'+stem+'.py'
    return bool(re.fullmatch(r'nora-context-\d+',name)) and relative in {
        'clawchat/greeting.md','clawchat/greeting.nora-example.md',
        'clawchat/nora-greeting.json','scripts/nora-instance.py'}


class Journal:
    def __init__(self,home,root,record):
        self.home=Path(home).resolve();self.root=Path(root).resolve();self.record=record
        if (not isinstance(record,dict) or not isinstance(record.get('recoveryPlan'),dict)
                or not isinstance(record.get('backup'),str)):
            raise RuntimeError('更新记录缺少完整恢复计划，已保留现场')
        self.plan=record['recoveryPlan'];self.backup=Path(record['backup'])
        self.file=self.root/'tavern-updates/transaction.json'

    @classmethod
    def create(cls,home,root,backup,swaps,*,version,before,state=None,lifecycle=None):
        home,root,backup=map(lambda p:Path(p).resolve(),(home,root,backup))
        targets=[]
        for name,source,target in swaps:
            target=Path(target).absolute()
            namespace='install' if target.is_relative_to(root) else 'hermes'
            owner=root if namespace=='install' else home
            relative=target.relative_to(owner).as_posix()
            if not allowed_target(name,namespace,relative):raise RuntimeError('恢复计划含未受管目标：'+name)
            target=safe_path(owner,relative)
            targets.append({'name':name,'namespace':namespace,'relative':relative,
                'oldIdentity':identity(target),'oldDigest':digest(target) if _io_path(target).exists() else None,
                'newIdentity':identity(source) if source is not None else None,'phase':'pending'})
        metadata={name:digest(backup/name) for name in ('host','agents-rollback','managed') if _io_path(backup/name).exists()}
        plan={'schema':1,'hermesHome':str(home),'installRoot':str(root),
              'before':dict(before),'lifecycle':lifecycle,'targets':targets,'metadata':metadata,
              'phase':'prepared','metadataPhase':'pending','metadataIntents':[],'state':None}
        if state is not None:
            if Path(state).resolve()!=root/'tavern-state':raise RuntimeError('剧情状态恢复路径不匹配')
            plan['state']={'oldIdentity':identity(state),'oldDigest':None,'savedIdentity':None,
                           'savedDigest':None,'newIdentity':None,'phase':'pending','mode':'copy'}
        if lifecycle:
            instance=safe_path(home,'nora-instance.json')
            plan['instanceDigest']=digest(instance)
        record={'schema':1,'status':'prepared','version':version,'backup':str(backup),'recoveryPlan':plan}
        gate=getattr(sys,'_nora_operation_delegate',None)
        if gate is not None:
            gate.assert_active()
            record.update(operationId=gate.operation_id,ownerEpoch=gate.owner_epoch)
        journal=cls(home,root,record).bind_sources(swaps);journal.validate();journal.save();return journal

    def save(self,status=None):
        if status is not None:self.record['status']=status
        # Never replace a readable checkpoint with a record our loader rejects.
        encoded=json.dumps(self.record,ensure_ascii=False,indent=2).encode('utf-8')
        if len(encoded)>MAX_TRANSACTION_BYTES:
            raise RuntimeError('恢复计划超出安全容量，已保留上一次恢复检查点')
        atomic_json(self.file,self.record)

    def target(self,item):
        return safe_path(self.root if item['namespace']=='install' else self.home,item['relative'])

    def validate(self,*,full=True):
        if (type(self.record.get('schema')) is not int or self.record['schema']!=1
                or type(self.plan.get('schema')) is not int or self.plan['schema']!=1):
            raise RuntimeError('更新记录缺少完整恢复计划，已保留现场')
        if self.plan.get('hermesHome')!=str(self.home) or self.plan.get('installRoot')!=str(self.root):
            raise RuntimeError('恢复计划与当前安装身份不一致')
        if 'operationId' in self.record and (not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',str(self.record['operationId']),re.I)
                or type(self.record.get('ownerEpoch')) is not int or not 0<self.record['ownerEpoch']<=2**53-1):
            raise RuntimeError('恢复计划的操作身份无效')
        if self.backup.parent!=self.root/'tavern-backups' or not _io_path(self.backup).is_dir():
            raise RuntimeError('受管恢复备份缺失或越过安装目录')
        safe_path(self.root,'tavern-backups/'+self.backup.name)
        receipt=read_object(safe_path(self.backup,RECEIPT))
        if (receipt.get('schema')!='nora-update-backup/1' or receipt.get('owner')!='nora-tavern-updater'
                or receipt.get('installRoot')!=str(self.root) or receipt.get('backupId')!=self.backup.name
                or receipt.get('status') not in ('prepared','committed','recovery-failed','restored')):
            raise RuntimeError('恢复备份归属无法确认')
        before=self.plan.get('before')
        if not isinstance(before,dict) or not isinstance(before.get('version'),str) or not before['version']:
            raise RuntimeError('恢复计划缺少旧版本身份')
        if any(type(before.get(key)) is not bool for key in ('running','gatewayRunning','clawchatConnected')):
            raise RuntimeError('恢复计划缺少原服务状态')
        receipt_path=safe_path(self.backup,'host/update-receipts/installed.json')
        if read_object(receipt_path).get('version')!=before['version']:
            raise RuntimeError('恢复备份版本与原安装不一致')
        if self.plan.get('lifecycle') is not None and not isinstance(self.plan['lifecycle'],dict):
            raise RuntimeError('恢复记录的启动器服务计划格式无效')
        if self.plan.get('lifecycle'):
            lifecycle=self.plan['lifecycle']
            if (lifecycle.get('hermesHome')!=str(self.home) or lifecycle.get('installRoot')!=str(self.root)
                    or Path(lifecycle.get('noraHome','')).resolve()!=self.root.parent
                    or self.home!=self.root.parent/'hermes' or self.root!=self.root.parent/'tavern'
                    or not isinstance(lifecycle.get('before'),dict)
                    or type(lifecycle.get('port')) is not int or not 1024<=lifecycle['port']<=65535):
                raise RuntimeError('启动器实例身份与恢复计划不一致')
            instance_path=safe_path(self.home,'nora-instance.json');instance=read_object(instance_path)
            if (type(instance.get('schema')) is not int or instance['schema']!=1 or type(instance.get('port')) is not int
                    or any(instance.get(key)!=lifecycle.get(key) for key in ('noraHome','hermesHome','installRoot','port'))
                    or any(lifecycle['before'].get(key)!=before.get(key) for key in
                           ('version','running','gatewayRunning','clawchatConnected','systemReady'))
                    or (full and digest(instance_path)!=self.plan.get('instanceDigest'))):
                raise RuntimeError('启动器实例身份或原服务计划与恢复记录不一致')
        if not isinstance(self.plan.get('metadata'),dict) or 'host' not in self.plan['metadata'] or 'agents-rollback' not in self.plan['metadata']:
            raise RuntimeError('恢复计划缺少配置备份')
        for name,expected in self.plan['metadata'].items():
            if full and name in ('host','agents-rollback','managed'):reject_links(safe_path(self.backup,name))
            if (name not in ('host','agents-rollback','managed')
                    or not _io_path(safe_path(self.backup,name)).is_dir()
                    or (full and digest(safe_path(self.backup,name))!=expected)):
                raise RuntimeError('配置恢复备份缺失或已变化')
        metadata_items=self.metadata_items()  # Validate before stopping or changing files.
        if 'metadataIntents' in self.plan:
            intents=self.plan['metadataIntents']
            allowed={self.metadata_key(target) for target,_ in metadata_items}
            if not isinstance(intents,list) or len(intents)!=len(set(intents)) or any(key not in allowed for key in intents):
                raise RuntimeError('配置恢复变更意图无效')
        names=set();paths=set()
        if not isinstance(self.plan.get('targets'),list):raise RuntimeError('恢复计划目标列表格式无效')
        for item in self.plan['targets']:
            if not isinstance(item,dict) or not allowed_target(item.get('name',''),item.get('namespace'),item.get('relative')):
                raise RuntimeError('恢复计划目标不在受管范围')
            pair=(item['namespace'],item['relative'])
            if item['name'] in names or pair in paths:raise RuntimeError('恢复计划包含重复目标')
            names.add(item['name']);paths.add(pair)
            self.check_tree(item,self.target(item),safe_path(self.backup,'trees/'+item['name']),full=full)
        state=self.plan.get('state')
        if state is not None and not isinstance(state,dict):raise RuntimeError('剧情状态恢复计划格式无效')
        if state:
            active=safe_path(self.root,'tavern-state');saved=safe_path(self.backup,'state')
            if state.get('phase') in ('pending','copying','untouched'):
                if identity(active)!=state.get('oldIdentity'):raise RuntimeError('未完成状态备份且原数据身份已变化')
            else:self.check_tree(state,active,saved,state=True,full=full)
        return self

    def check_tree(self,item,target,saved,*,state=False,full=True):
        old=item.get('savedIdentity') if state and item.get('mode')=='copy' else item.get('oldIdentity')
        expected=item.get('savedDigest') if state and item.get('mode')=='copy' else item.get('oldDigest')
        saved_id=identity(saved);current_id=identity(target)
        if saved_id is not None:
            if saved_id!=old or (full and digest(saved)!=expected):raise RuntimeError('旧文件备份身份或内容不一致')
            accepted=(item.get('newIdentity'),item.get('oldIdentity')) if state else (item.get('newIdentity'),)
            if current_id is not None and current_id not in accepted:raise RuntimeError('当前目标身份未知，未覆盖文件')
        elif old is not None:
            if current_id!=old:raise RuntimeError('旧备份缺失且原目标尚未安全恢复')
            if full and state and item.get('phase')=='restored':
                for relative,expected_file in item.get('storyInventory',{}).items():
                    current=safe_path(target,relative)
                    if not _io_path(current).is_file() or digest(current)!=expected_file:raise RuntimeError('恢复后原有剧情数据发生变化')
            elif full and digest(target)!=expected:raise RuntimeError('原目标内容与旧备份不一致')
        elif current_id is not None and current_id!=item.get('newIdentity'):
            raise RuntimeError('新建目标身份未知，未覆盖文件')

    def swap(self,name):
        item=next(i for i in self.plan['targets'] if i['name']==name)
        source=self._sources[name];target=self.target(item);saved=safe_path(self.backup,'trees/'+name)
        # A context/script swap can also replace a metadata-snapshotted file.
        # Record it once before its write so later metadata checks do not
        # mistake our own replacement for an external configuration change.
        if self.metadata_key(target) in {self.metadata_key(path) for path,_ in self.metadata_items()}:
            self.mark_metadata([target])
        item['phase']='moving-old';self.save();_io_path(saved).parent.mkdir(parents=True,exist_ok=True)
        if item['oldIdentity'] is not None:os.replace(_io_path(target),_io_path(saved))
        item['phase']='installing-new';self.save()
        if source is not None:
            _io_path(target).parent.mkdir(parents=True,exist_ok=True);os.replace(_io_path(source),_io_path(target))
        item['phase']='applied';self.save()

    def bind_sources(self,swaps):
        self._sources={name:Path(source) if source is not None else None for name,source,_ in swaps}
        return self

    def metadata_key(self,target):
        owner=self.root if target.is_relative_to(self.root) else self.home
        return ('install:' if owner==self.root else 'hermes:')+target.relative_to(owner).as_posix()

    def check_metadata_before_write(self,items):
        for target,saved in items:
            current=digest(target) if _io_path(target).exists() else None
            original=digest(saved) if _io_path(saved).exists() else None
            if current!=original:
                error=RuntimeError('准备更新后配置已发生变化，当前配置已保留。请重新检查并准备更新。')
                error.code='CONDITIONS_CHANGED';raise error

    def seal_offline(self,proof):
        if not isinstance(proof,dict) or proof.get('offline') is not True:
            raise RuntimeError('未确认服务停止状态，未激活更新。')
        for item in self.plan['targets']:
            target=self.target(item)
            if item['phase']!='pending' or identity(target)!=item['oldIdentity']:
                error=RuntimeError('更新目标身份发生变化，未激活更新。');error.code='CONDITIONS_CHANGED';raise error
            item['oldDigest']=digest(target) if identity(target) is not None else None
        self.save()
        self.check_metadata_before_write(self.metadata_items())

    def mark_metadata(self,targets):
        items={self.metadata_key(target):(target,saved) for target,saved in self.metadata_items()}
        keys=[self.metadata_key(Path(target).absolute()) for target in targets]
        if any(key not in items for key in keys):raise RuntimeError('配置变更目标超出受管范围')
        fresh=[key for key in keys if key not in self.plan.get('metadataIntents',[])]
        self.check_metadata_before_write([items[key] for key in fresh])
        self.plan.setdefault('metadataIntents',[]).extend(fresh)
        self.plan['metadataPhase']='applying';self.save()

    def snapshot_state(self):
        item=self.plan['state']
        if item is None:return
        source=safe_path(self.root,'tavern-state');saved=safe_path(self.backup,'state')
        reject_links(source)
        item['oldDigest']=digest(source);item['phase']='copying';self.save()
        shutil.copytree(_io_path(source),_io_path(saved),symlinks=True)
        item['savedIdentity']=identity(saved);item['savedDigest']=digest(saved)
        item['storyInventory']=story_inventory(saved)
        if item['savedDigest']!=item['oldDigest']:raise RuntimeError('剧情数据快照校验失败')
        item['phase']='saved';self.save()

    def apply_state(self,source):
        item=self.plan['state'];target=safe_path(self.root,'tavern-state');saved=safe_path(self.backup,'state')
        item.update(mode='move',oldDigest=digest(target),newIdentity=identity(source),phase='moving-old')
        self.save();os.replace(_io_path(target),_io_path(saved))
        item.update(savedIdentity=identity(saved),savedDigest=digest(saved),storyInventory=story_inventory(saved),phase='installing-new')
        self.save();os.replace(_io_path(source),_io_path(target));item['phase']='applied';self.save()

    def restore_tree(self,item,target,saved,failed,*,state=False):
        if item.get('phase')=='restored':self.check_tree(item,target,saved,state=state);return
        if state and item.get('phase') in ('pending','copying','untouched'):
            item['phase']='untouched';self.save();return
        self.check_tree(item,target,saved,state=state)
        old=item.get('savedIdentity') if state and item.get('mode')=='copy' else item.get('oldIdentity')
        if identity(saved) is None and identity(target)==old:
            item['phase']='restored';self.save();return
        item['phase']='restoring';self.save()
        if identity(target) is not None:
            if _io_path(failed).exists():raise RuntimeError('失败现场目标已存在且当前目标未恢复，未覆盖证据')
            _io_path(failed).parent.mkdir(parents=True,exist_ok=True);os.replace(_io_path(target),_io_path(failed))
        if identity(saved) is not None:
            _io_path(target).parent.mkdir(parents=True,exist_ok=True);os.replace(_io_path(saved),_io_path(target))
        item['phase']='restored';self.save()

    def metadata_items(self):
        items=[]
        def add(namespace,relative,snapshot):
            owner=self.root if namespace=='install' else self.home
            target=safe_path(owner,relative);saved=safe_path(self.backup,snapshot)
            items.append((target,saved))
        add('hermes','config.yaml','host/config.yaml')
        add('install','tavern-state/native-runtime/dependencies.json','host/native-runtime/dependencies.json')
        for name in ('installed.json','installed-manifest.json','nora-system.json'):
            add('install','tavern-updates/'+name,'host/update-receipts/'+name)
        for name in ('AGENTS.md','AGENTS.md.bak'):add('hermes',name,'agents-rollback/'+name)
        if 'managed' in self.plan['metadata']:
            records=read(safe_path(self.backup,'managed/snapshot.json'))
            if not isinstance(records,list):raise RuntimeError('受管配置快照格式无效')
            names=set()
            for record in records:
                # Existing Windows snapshot writers use str(Path), not as_posix.
                # Normalize separators only before the exact managed whitelist.
                relative=record.get('path') if isinstance(record,dict) else None
                relative=relative.replace('\\','/') if isinstance(relative,str) else None
                if (relative not in MANAGED or type(record.get('existed')) is not bool or relative in names):
                    raise RuntimeError('受管配置快照路径无效')
                names.add(relative);add('hermes',relative,'managed/targets/'+relative)
                if record['existed'] != _io_path(items[-1][1]).exists():raise RuntimeError('受管配置备份缺失')
        return items

    def restore_metadata(self):
        for index,(target,saved) in enumerate(self.metadata_items()):
            if 'metadataIntents' in self.plan and self.metadata_key(target) not in self.plan['metadataIntents']:continue
            if _io_path(target).exists() and _io_path(saved).exists() and digest(target)==digest(saved):
                restore_permissions(saved,target);continue
            if not _io_path(target).exists() and not _io_path(saved).exists():continue
            archive=safe_path(self.backup,'failed-new/metadata/'+uuid.uuid4().hex+'/'+str(index))
            if _io_path(target).exists():
                _io_path(archive).parent.mkdir(parents=True,exist_ok=True);os.replace(_io_path(target),_io_path(archive))
            if _io_path(saved).exists():
                _io_path(target).parent.mkdir(parents=True,exist_ok=True)
                temporary=target.with_name('.nora-restore-'+uuid.uuid4().hex)
                if _io_path(saved).is_dir():shutil.copytree(_io_path(saved),_io_path(temporary),symlinks=True)
                else:shutil.copy2(_io_path(saved),_io_path(temporary))
                os.replace(_io_path(temporary),_io_path(target))

    def receipt_status(self,status):
        path=safe_path(self.backup,RECEIPT);receipt=read_object(path)
        if (receipt.get('owner')!='nora-tavern-updater' or receipt.get('schema')!='nora-update-backup/1'
                or receipt.get('installRoot')!=str(self.root) or receipt.get('backupId')!=self.backup.name):
            raise RuntimeError('恢复备份归属无法确认，未改写记录')
        receipt['status']=status;atomic_json(path,receipt)


def load(home,root,*,full=True):
    root=Path(root).resolve();home=Path(home).resolve()
    record=read_object(safe_path(root,'tavern-updates/transaction.json'),max_bytes=MAX_TRANSACTION_BYTES)
    if not isinstance(record.get('recoveryPlan'),dict):raise RuntimeError('旧更新记录缺少完整恢复计划，已保留现场')
    return Journal(home,root,record).validate(full=full)


def recovery_block_reason(status):
    if status in RECOVERABLE_STATES:return None
    if status=='committed':return '更新已提交，无需恢复'
    if status=='restored':return '旧版本已恢复，无需重复恢复'
    return '更新事务状态未知，已保留现场'


def assess(home,root):
    try:
        journal=load(home,root,full=False)
        reason=recovery_block_reason(journal.record.get('status'))
        if reason:return {'canRecover':False,'reason':reason}
        return {'canRecover':True,'reason':'','version':journal.plan['before']['version']}
    except (OSError,ValueError,KeyError,TypeError,RuntimeError) as error:
        return {'canRecover':False,'reason':str(error)}


def effects(home,root):
    """Read-only evidence of remaining writes, not an inference from status."""
    try:
        journal=load(home,root,full=False);plan=journal.plan
        # Read-only assessment may omit live managed-code byte inventories,
        # but must still authenticate the immutable recovery sources.
        for name,expected in plan['metadata'].items():
            saved=safe_path(journal.backup,name);reject_links(saved)
            if digest(saved)!=expected:raise RuntimeError('配置恢复备份已变化')
        for item in plan['targets']:
            saved=safe_path(journal.backup,'trees/'+item['name'])
            if identity(saved) is not None and digest(saved)!=item.get('oldDigest'):
                raise RuntimeError('旧程序恢复备份已变化')
        state=plan.get('state')
        if state and state.get('savedDigest'):
            saved=safe_path(journal.backup,'state')
            if identity(saved) is not None and digest(saved)!=state['savedDigest']:
                raise RuntimeError('剧情状态恢复备份已变化')
        phases=[item.get('phase') for item in plan['targets']]
        if state and state.get('phase') not in ('pending','copying','saved','untouched','restored','moving-old','installing-new','applied','restoring'):
            raise RuntimeError('剧情状态变更意图未知')
        metadata=plan.get('metadataPhase')
        if metadata is None and plan.get('phase') in ('prepared','stopping','stopped') and all(value=='pending' for value in phases):
            metadata='pending'  # Old prepared records have not reached host writes.
        if metadata not in ('pending','applying','restored') or any(value not in
                ('pending','moving-old','installing-new','applied','restoring','restored') for value in phases):
            raise RuntimeError('更新变更意图缺少可核验记录')
        state_phase=state.get('phase') if state else 'untouched'
        if metadata=='pending' and all(value=='pending' for value in phases) and state_phase in ('pending','copying','saved','untouched'):
            effect='untouched'
        elif metadata=='restored' and all(value in ('pending','restored') for value in phases) and state_phase in ('pending','copying','untouched','restored'):
            effect='restored'
        else: effect='changed'
        outcome='not-required' if effect=='untouched' else 'restored-and-verified' if journal.record.get('status')=='restored' else 'files-restored-start-failed' if effect=='restored' else 'recovery-required'
        return {'effectState':effect,'recoveryOutcome':outcome,'reason':'',
                'canRecover':journal.record.get('status') in RECOVERABLE_STATES,
                'status':journal.record.get('status'),'operationId':journal.record.get('operationId')}
    except (OSError,ValueError,KeyError,TypeError,RuntimeError) as error:
        return {'effectState':'unknown','recoveryOutcome':'recovery-required','canRecover':False,'reason':str(error)}


def recover(home,root,*,stop,resume,verify):
    journal=load(home,root);plan=journal.plan;backup=journal.backup
    gate=getattr(sys,'_nora_operation_delegate',None)
    if gate is not None:
        gate.assert_active()
        if journal.record.get('operationId') and journal.record['operationId']!=gate.operation_id:
            raise RuntimeError('更新事务属于另一次操作，未覆盖当前文件。请从原操作恢复入口继续。')
    original_effect=effects(home,root)['effectState']
    reason=recovery_block_reason(journal.record.get('status'))
    if reason:raise RuntimeError(reason)
    try:
        plan['phase']='stopping';journal.save('recovery-failed')
        stopped=stop(plan,backup)
        if not isinstance(stopped,dict) or stopped.get('offline') is not True:
            raise RuntimeError('未确认服务停止状态，未恢复文件。请重新检查状态并保留备份。')
        plan['phase']='restoring-files';journal.save()
        for item in reversed(plan['targets']) if original_effect!='untouched' else []:
            journal.restore_tree(item,journal.target(item),safe_path(backup,'trees/'+item['name']),
                                 safe_path(backup,'failed-new/'+item['name']))
        if plan.get('state') and original_effect!='untouched':
            journal.restore_tree(plan['state'],safe_path(journal.root,'tavern-state'),safe_path(backup,'state'),
                                 safe_path(backup,'failed-new/state'),state=True)
        elif plan.get('state'):
            plan['state']['phase']='untouched';journal.save()
        plan['phase']='restoring-metadata';journal.save();journal.restore_metadata()
        plan['metadataPhase']='restored';journal.save()
        # Authoritative backup and managed bytes are checked while services are
        # offline. Running code may legitimately create cache/generated files.
        journal.validate()
        plan['phase']='resuming-services';journal.save();resume(plan,backup)
        proof=verify(plan,backup)
        before=plan['before']
        if not isinstance(proof,dict) or proof.get('version')!=before['version']:
            raise RuntimeError('恢复后的旧版本核验失败')
        for key in ('running','gatewayRunning','clawchatConnected'):
            if type(proof.get(key)) is not bool:raise RuntimeError('恢复后缺少明确服务状态：'+key)
        for key in ('running','gatewayRunning'):
            if before[key]!=proof[key]:raise RuntimeError('未恢复原服务状态：'+key)
        if before.get('clawchatConnected') and not proof['clawchatConnected']:
            raise RuntimeError('未恢复原服务状态：clawchatConnected')
        # Identity remains strict after start, without whole-tree byte checks.
        journal.validate(full=False)
        state=plan.get('state')
        if state and state.get('phase')=='restored':
            for relative,expected in state.get('storyInventory',{}).items():
                current=safe_path(journal.root/'tavern-state',relative)
                if not _io_path(current).is_file() or digest(current)!=expected:
                    raise RuntimeError('恢复后原有剧情数据发生变化')
        plan['phase']='restored';journal.record['recovery']='restored';journal.record.pop('error',None)
        journal.save('restored')
        journal.receipt_status('restored')
        return {'status':'restored','version':before['version'],'backup':str(backup),'state':proof}
    except Exception as error:
        journal.record['error']=str(error)[-2000:]
        try:journal.save('recovery-failed')
        except (OSError,ValueError,RuntimeError) as saving:
            error.secondary_errors=[*getattr(error,'secondary_errors',()),saving]
        try:journal.receipt_status('recovery-failed')
        except (OSError,ValueError,RuntimeError) as saving:
            error.secondary_errors=[*getattr(error,'secondary_errors',()),saving]
        raise
