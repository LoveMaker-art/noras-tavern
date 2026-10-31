"""Durable, bounded-path recovery of one owned Tavern update transaction."""
import hashlib
from datetime import datetime
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
import time
import uuid

RECEIPT = 'nora-update-backup.json'
MAX_TRANSACTION_BYTES = 64 * 1024 * 1024
RECOVERABLE_STATES = ('prepared', 'recovery-failed')
SKILLS = {'creative/tavern','creative/tavern-ops','creative/nora-cardforge',
          'system/tavern-updater','system/model-provider-config','creative/nora-skill-library'}
RETIRED = {'tavern-world','tavern-runtime-plugins','tavern-continuity',
           'tavern-story-profile','tavern-frontend','tavern-world-visuals'}
MANAGED = {'SOUL.md','SOUL.nora-tavern.example.md','nora-installation.json',
           'cron/jobs.json','clawchat-skills','scripts/nora-instance.py',
           'scripts/nora-tavern-update-check.py','scripts/nora-tavern-card-send.py'}
CRON_RUNTIME_FIELDS = {'last_run_at','last_status','last_error','last_delivery_error',
                       'last_delivery_unverified','failure_streak','next_run_at',
                       'run_claim','fire_claim','last_dispatch','last_fire_error','monitor_state'}
SETUP_METADATA_KEY = 'install:tavern-updates/nora-system.json'


def cron_definition(path):
    """Keep every unknown/user field; omit only known unbounded recurring-run state.

    The packaged Hermes cron store owns updated_at and these run fields. Enabled,
    paused state, finite execution budgets, IDs and task definitions remain protected.
    Malformed/new formats never qualify for runtime-only admission.
    """
    value=read(path)
    if not isinstance(value,dict) or not isinstance(value.get('jobs'),list):
        raise ValueError('cron definition format')
    result={key:item for key,item in value.items() if key!='updated_at'};jobs=[];ids=set()
    for job in value['jobs']:
        if not isinstance(job,dict) or not isinstance(job.get('id'),str) or not job['id'] or job['id'] in ids:
            raise ValueError('cron definition identity')
        ids.add(job['id']);definition=dict(job)
        schedule=job.get('schedule');repeat=job.get('repeat')
        unbounded=(repeat is None or isinstance(repeat,dict) and repeat.get('times') is None)
        if (job.get('enabled') is True and isinstance(schedule,dict)
                and schedule.get('kind') in ('cron','interval') and unbounded):
            for key in CRON_RUNTIME_FIELDS:definition.pop(key,None)
            if job.get('state') in ('scheduled','error'):definition.pop('state',None)
            if isinstance(repeat,dict) and type(repeat.get('completed',0)) is int and repeat.get('completed',0)>=0:
                definition['repeat']={key:item for key,item in repeat.items() if key!='completed'}
        jobs.append(definition)
    result['jobs']=jobs
    return hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def _history_time(value):
    if not isinstance(value,str):raise RuntimeError('历史恢复时间格式无效')
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        if parsed.tzinfo is None:raise ValueError('missing timezone')
        return parsed.timestamp()
    except (ValueError,OverflowError):raise RuntimeError('历史恢复时间无法核验') from None


def _history_bytes(file,limit):
    file=_io_path(file);reject_links(file);before=file.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size>limit:raise RuntimeError('历史恢复来源不是有界文件')
    with file.open('rb') as stream:
        opened=os.fstat(stream.fileno())
        fields=lambda item:(item.st_dev,item.st_ino,item.st_size,item.st_mtime_ns,item.st_ctime_ns)
        if fields(opened)!=fields(before):raise RuntimeError('历史恢复来源在打开前变化')
        raw=stream.read(opened.st_size+1);after=os.fstat(stream.fileno());named=file.lstat()
    if fields(after)!=fields(opened) or fields(named)!=fields(opened) or len(raw)!=opened.st_size:
        raise RuntimeError('历史恢复来源在读取时变化')
    return raw


def _history_object(file,limit):
    value=json.loads(_history_bytes(file,limit))
    if not isinstance(value,dict):raise RuntimeError('历史恢复来源必须为对象')
    return value


def _verify_closure_relations(value,journal,nora):
    """Check sealed source relationships before retiring the last large backup.

    The original capture owns physical proof. These immutable relationships
    must remain consistent even when their old physical source was pruned.
    Current runtime and current system effects still have independent readers.
    """
    source=value['source'];saved=source['record'];producer=value['producer'];plan=journal.get('recoveryPlan',{});proof=source['proof']
    if (not isinstance(saved,dict) or not isinstance(plan,dict) or not isinstance(proof,dict)
            or not isinstance(plan.get('before'),dict) or not isinstance(plan.get('state'),dict)
            or not isinstance(plan.get('lifecycle'),dict) or not isinstance(plan.get('targets'),list)
            or any(not isinstance(item,dict) for item in plan['targets'])):
        raise RuntimeError('历史恢复固定来源格式无效')
    selected=saved.get('target',{}).get('releasePlan',{});before=plan.get('before',{})
    if (_history_time(saved.get('updatedAt'))>_history_time(producer.get('createdAt'))
            or _history_time(value.get('capturedAt'))<_history_time(producer.get('createdAt'))
            or type(saved.get('ownerEpoch')) is not int or saved['ownerEpoch']<1 or saved['ownerEpoch']>=producer['ownerEpoch']
            or saved.get('state')!='succeeded' or saved.get('verification')!='confirmed' or saved.get('effectState')!='changed'
            or saved.get('recoveryOutcome')!='not-required' or saved.get('result',{}).get('systemReady') is not True
            or saved.get('result',{}).get('updateVerified') is not True or selected.get('mode')!='install'
            or journal.get('version')!=selected.get('version') or saved.get('result',{}).get('version')!=selected.get('version')
            or saved.get('result',{}).get('commit')!=selected.get('commit') or proof.get('operationId')!=saved.get('operationId')
            or proof.get('ownerEpoch')!=saved['ownerEpoch'] or proof.get('version')!=selected.get('version')
            or proof.get('beforeVersion')!=saved.get('target',{}).get('currentVersion') or proof.get('backup')!=journal.get('backup')
            or before.get('version')!=saved.get('target',{}).get('currentVersion')
            or any(before.get(key) is not False for key in ('running','gatewayRunning','clawchatConnected'))
            or not re.fullmatch('[a-f0-9]{64}',str(plan.get('state',{}).get('savedDigest')))
            or not isinstance(plan.get('worlds'),dict) or plan.get('lifecycle',{}).get('before')!=before):
        raise RuntimeError('历史恢复固定来源关系已变化')
    source_runtime=_history_object(safe_path(nora,'installer/operations/'+saved['operationId']+'/runtime-bootstrap.json'),4*1024*1024)
    targets=[item for item in plan.get('targets',[]) if item.get('namespace')=='install'];observed=proof.get('targets')
    if not isinstance(observed,list) or len(observed)!=len(targets):raise RuntimeError('历史程序目标集合已变化')
    for target in observed:
        matches=[item for item in targets if all(item.get(key)==target.get(key) for key in ('name','namespace','relative'))]
        if (len(matches)!=1 or set(target)!={'name','namespace','relative','oldIdentity','oldDigest'}
                or target.get('oldIdentity')!=(None if matches[0].get('oldIdentity') is None else list(map(str,matches[0]['oldIdentity'])))
                or target.get('oldDigest')!=matches[0].get('oldDigest')):
            raise RuntimeError('历史程序目标证据已变化')
    for item in value['closed']:
        prior=item['record'];old=_history_object(safe_path(nora,'installer/operations/'+prior['operationId']+'/runtime-bootstrap.json'),4*1024*1024)
        snapshot=old.get('originalPartial');baseline=plan.get('partialBaseline')
        if (type(prior.get('ownerEpoch')) is not int or prior['ownerEpoch']<1 or prior['ownerEpoch']>=saved['ownerEpoch']
                or _history_time(prior.get('updatedAt'))>=_history_time(saved.get('createdAt'))
                or prior.get('state')!='rolled-back' or prior.get('effectState')!='restored' or prior.get('verification')!='confirmed'
                or prior.get('recoveryOutcome')!='restored-and-verified' or old.get('recoveryVerification')!='original-partial-confirmed'
                or old.get('status')!='rolled-back' or old.get('ownerEpoch')!=prior['ownerEpoch'] or old.get('newTreePreserved') is not True
                or not isinstance(snapshot,dict) or snapshot!=source_runtime.get('originalPartial')
                or old.get('previousSeal')!=source_runtime.get('previousSeal')
                or old.get('identities',{}).get('previous')!=source_runtime.get('identities',{}).get('previous')
                or old.get('partialSystemProof',{}).get('stateDigest')!=plan['state']['savedDigest']
                or set(snapshot.get('bindings',{}))!={'config','instance','manifest','nativeConfig','receipt','runtimeMarker','system'}):
            raise RuntimeError('历史运行时原损坏状态关系已变化')
        if baseline is not None:
            now=baseline.get('partialRepair',{})
            if (set(baseline)!={'schema','partialRepair','stateDigest','storyInventory','worlds','readerManifestSha256','readerCommit'}
                    or baseline.get('schema')!='nora-managed-partial-repair-baseline/1'
                    or baseline.get('stateDigest')!=plan['state']['savedDigest'] or baseline.get('worlds')!=plan['worlds']
                    or baseline.get('readerManifestSha256')!=selected.get('manifestSha256') or baseline.get('readerCommit')!=selected.get('commit')
                    or now!=plan.get('lifecycle',{}).get('partialRepair') or not isinstance(baseline.get('storyInventory'),dict)
                    or any(snapshot['bindings'][key]!=now.get('bindings',{}).get(key) for key in ('instance','config','manifest','nativeConfig','receipt','system'))
                    or snapshot.get('programs')!=now.get('programs') or snapshot.get('missing',{}).get('python') is not True
                    or now.get('missing',{}).get('python') is not False
                    or any(snapshot.get('missing',{}).get(key)!=now.get('missing',{}).get(key) for key in ('nativeRuntime','nativeLifecycle'))):
                raise RuntimeError('历史部分修复封存基线已变化')
        elif ('partialBaseline' in plan or proof.get('partialHistoryKind')!='python-only'
                or snapshot.get('missing')!={'nativeRuntime':False,'nativeLifecycle':False,'python':True}
                or before.get('systemReady') is not True or 'partialRepair' in plan.get('lifecycle',{})
                or proof.get('stateDigest')!=plan['state']['savedDigest']):
            raise RuntimeError('历史仅Python恢复来源不一致')
        for name,program in snapshot.get('programs',{}).items():
            matches=[target for target in observed if target['name']==name]
            if len(matches)>1 or matches and (matches[0]['oldIdentity']!=(program or {}).get('identity') or matches[0]['oldDigest']!=(program or {}).get('digest')):
                raise RuntimeError('历史程序目标与原程序快照不一致')


def operation_owner(home,root):
    home,root=Path(home).resolve(),Path(root).resolve()
    marker=safe_path(home,'nora-instance.json')
    if _io_path(marker).is_file():
        value=read_object(marker)
        owner=Path(value.get('noraHome',''))
        if (value.get('schema')!=1 or Path(value.get('hermesHome',''))!=home
                or Path(value.get('installRoot',''))!=root or not owner.is_absolute()
                or owner==Path(owner.anchor)):
            raise RuntimeError('维护历史所属实例无法确认')
        return owner
    # A desktop marker is the evidence for a parent owner. Directory spelling
    # alone is not: an unmarked cloud home owns its own operations.
    return home


def effect_closure_refs(home,root,*,operation_id=None):
    """Preserve guard-bound opaque closure references; Node owns their proof.

    No status label is used as a historical permission. The producer's exact
    file SHA and fixed plan, preserved source records/runtimes, and owner are
    checked here before the unique system journal can be replaced/pruned.
    """
    home,root=Path(home).resolve(),Path(root).resolve();nora=operation_owner(home,root)
    references={};files=[];current=safe_path(root,'tavern-updates/transaction.json')
    if _io_path(current).exists():files.append(_history_object(current,MAX_TRANSACTION_BYTES).get('recoveryPlan',{}))
    directory=safe_path(nora,'installer/operations')
    if _io_path(directory).exists():
        for entry in _io_path(directory).iterdir():
            if not re.fullmatch('[a-f0-9-]{36}',entry.name,re.I):continue
            file=safe_path(nora,'installer/operations/'+entry.name+'/operation.json')
            if _io_path(file).exists():files.append(_history_object(file,256*1024))
    for value in files:
        refs=value.get('effectClosureRefs',[])
        if not isinstance(refs,list) or len(refs)>128:raise RuntimeError('历史恢复引用容量或格式无效')
        for ref in refs:
            if (not isinstance(ref,dict) or set(ref)!={'path','sha256'}
                    or not re.fullmatch('installer/operations/[a-f0-9-]{36}/partial-history.json',str(ref.get('path')),re.I)
                    or not re.fullmatch('[a-f0-9]{64}',str(ref.get('sha256')))):
                raise RuntimeError('历史恢复引用无法归属')
            prior=references.get(ref['path'])
            if prior is not None and prior!=ref:raise RuntimeError('历史恢复引用发生冲突')
            references[ref['path']]=ref
    if len(references)>128:raise RuntimeError('历史恢复引用超出安全容量')
    for ref in references.values():
        file=safe_path(nora,ref['path']);reject_links(file)
        raw=_history_bytes(file,MAX_TRANSACTION_BYTES)
        if len(raw)>MAX_TRANSACTION_BYTES or hashlib.sha256(raw).hexdigest()!=ref['sha256']:
            raise RuntimeError('历史恢复证明内容已变化')
        value=json.loads(raw)
        if not isinstance(value,dict):raise RuntimeError('历史恢复证明必须为对象')
        producer=value.get('producer',{});source=value.get('source',{})
        owner=read_object(safe_path(nora,'nora-owner.json'),max_bytes=65536)
        if (not isinstance(value,dict) or set(value)!={'schema','noraHome','owner','producer','source','closed','capturedAt'}
                or value.get('schema')!='nora-partial-effects-closure/1' or value.get('noraHome')!=str(nora)
                or value.get('owner')!=owner.get('id') or set(producer)!={'operationId','ownerEpoch','planDigest','createdAt'}
                or ref['path']!='installer/operations/'+str(producer.get('operationId'))+'/partial-history.json'
                or set(source)!={'record','runtimeSha256','systemJournal','systemJournalSha256','proof','reader'}
                or not isinstance(value.get('closed'),list) or not value['closed'] or len(value['closed'])>128
                or not isinstance(source.get('record'),dict) or not isinstance(source.get('proof'),dict)
                or not isinstance(source.get('reader'),dict) or set(source['reader'])!={'launcherVersion','platform','arch','channel'}
                or any(not isinstance(item,dict) or set(item)!={'record','runtimeSha256'} or not isinstance(item.get('record'),dict) for item in value['closed'])):
            raise RuntimeError('历史恢复证明归属或结构无效')
        record=_history_object(safe_path(nora,'installer/operations/'+producer['operationId']+'/operation.json'),256*1024)
        if (type(record.get('ownerEpoch')) is not int or type(producer.get('ownerEpoch')) is not int or not 1<=producer['ownerEpoch']<=9007199254740991
                or not producer['ownerEpoch']<=record['ownerEpoch']<=9007199254740991 or record.get('planDigest')!=producer.get('planDigest')
                or record.get('createdAt')!=producer.get('createdAt') or record.get('planSelected') is not True
                or ref not in record.get('effectClosureRefs',[])):
            raise RuntimeError('历史恢复证明不属于原固定计划')
        text=source.get('systemJournal')
        if not isinstance(text,str) or hashlib.sha256(text.encode()).hexdigest()!=source.get('systemJournalSha256'):
            raise RuntimeError('历史系统来源封存已变化')
        journal=json.loads(text);saved=source['record']
        if (journal.get('operationId')!=saved.get('operationId') or journal.get('ownerEpoch')!=saved.get('ownerEpoch')
                or journal.get('status')!='committed' or source.get('proof',{}).get('journalSha256')!=source.get('systemJournalSha256')):
            raise RuntimeError('历史系统来源不一致')
        for item in [{'record':saved,'runtimeSha256':source['runtimeSha256']}]+value['closed']:
            prior=item.get('record',{});identifier=prior.get('operationId')
            if not re.fullmatch('[a-f0-9-]{36}',str(identifier),re.I):raise RuntimeError('历史效果操作身份无效')
            live=_history_object(safe_path(nora,'installer/operations/'+identifier+'/operation.json'),256*1024)
            stable=('schema','operationId','kind','ownerEpoch','createdAt','state','effectState','recoveryOutcome',
                    'verification','planDigest','planSelected','attempt','totalAttempts')
            if any(live.get(key)!=prior.get(key) for key in stable):raise RuntimeError('历史效果终态事实已变化')
            if not live.get('archived') and (live.get('target')!=prior.get('target') or live.get('result')!=prior.get('result') or live.get('updatedAt')!=prior.get('updatedAt')):
                raise RuntimeError('历史固定来源已变化')
            if live.get('archived') and (live.get('target')!={} or _history_time(live.get('archivedAt'))<_history_time(prior.get('updatedAt'))):
                raise RuntimeError('历史归档来源不一致')
            runtime=safe_path(nora,'installer/operations/'+identifier+'/runtime-bootstrap.json')
            reject_links(runtime)
            if hashlib.sha256(_history_bytes(runtime,4*1024*1024)).hexdigest()!=item.get('runtimeSha256'):
                raise RuntimeError('历史运行时来源已变化')
        _verify_closure_relations(value,journal,nora)
    return list(references.values())


def require_partial_history_before_replace(home,root,previous,refs):
    if not previous or previous.get('status')!='committed':return
    nora=operation_owner(home,root);identifier=previous.get('operationId')
    if not identifier:return
    record_file=safe_path(nora,'installer/operations/'+identifier+'/operation.json')
    runtime_file=safe_path(nora,'installer/operations/'+identifier+'/runtime-bootstrap.json')
    if not _io_path(record_file).exists() or not _io_path(runtime_file).exists():return
    owner=read_object(record_file,max_bytes=256*1024);successor=read_object(runtime_file,max_bytes=4*1024*1024)
    if owner.get('state')!='succeeded' or owner.get('verification')!='confirmed' or not successor.get('originalPartial'):return
    closed=set()
    for ref in refs:
        proof=read_object(safe_path(nora,ref['path']),max_bytes=MAX_TRANSACTION_BYTES)
        closed.update(item['record']['operationId'] for item in proof['closed'])
    for folder in _io_path(safe_path(nora,'installer/operations')).iterdir():
        if not re.fullmatch('[a-f0-9-]{36}',folder.name,re.I):continue
        runtime=safe_path(nora,'installer/operations/'+folder.name+'/runtime-bootstrap.json')
        if not _io_path(runtime).exists():continue
        old=read_object(runtime,max_bytes=4*1024*1024)
        if (old.get('status')=='rolled-back' and old.get('originalPartial')
                and old.get('identities',{}).get('previous')==successor.get('identities',{}).get('previous')
                and old['originalPartial']==successor['originalPartial'] and folder.name not in closed):
            raise RuntimeError('原部分安装恢复尚未封存完整后继证明，禁止覆盖最后系统来源')


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


def _atomic_file_identity(path):
    try:
        item=os.lstat(path)
    except FileNotFoundError:
        return None
    return (item.st_dev,item.st_ino,item.st_mode,item.st_size,item.st_mtime_ns,item.st_ctime_ns,
            getattr(item,'st_file_attributes',0))


def _publish_json(source, target):
    # Windows readers can briefly prevent replacing a closed JSON file. Keep
    # the original and complete temporary file intact; never truncate in place.
    # A changed source/target or a persistent denial remains a real failure.
    source_identity=_atomic_file_identity(source)
    target_identity=_atomic_file_identity(target)
    deadline=time.monotonic()+2.0
    delay=.01
    while True:
        try:
            os.replace(source,target)
            return
        except OSError as error:
            if sys.platform!='win32' or getattr(error,'winerror',None) not in (5,32,33):
                raise
            if (_atomic_file_identity(source)!=source_identity
                    or _atomic_file_identity(target)!=target_identity
                    or time.monotonic()>=deadline):
                raise
            time.sleep(min(delay,max(0,deadline-time.monotonic())))
            # Check again after waiting, before granting another replace.
            if (_atomic_file_identity(source)!=source_identity
                    or _atomic_file_identity(target)!=target_identity):
                raise
            delay=min(.1,delay*2)


def atomic_json(path, value):
    path=_io_path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as stream:
            json.dump(value,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
        _publish_json(name,path)
    finally:
        if os.path.lexists(name):os.unlink(name)


def copy_startup_backup(source, target, expected):
    """Publish a complete verified settings backup, never a partial file."""
    source,target=_io_path(source),_io_path(target)
    target.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix='.nora-settings-',dir=target.parent);os.close(fd)
    try:
        shutil.copyfile(source,name)
        with open(name,'r+b') as stream:stream.flush();os.fsync(stream.fileno())
        shutil.copystat(source,name)
        if digest(name)!=expected:raise RuntimeError('自动设置备份复制校验失败')
        if os.path.lexists(target):raise RuntimeError('设置备份目标已出现，未覆盖现有文件')
        os.replace(name,target)
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


def digest(path,*,on_progress=None):
    """Hash regular bytes and link names without following nested junctions.

    Optional progress reports actual (bytes_read, entries_confirmed) increments.
    """
    path=_io_path(path);result=hashlib.sha256()
    def visit(current,relative):
        value=current.lstat()
        if linked(current):
            result.update(b'L'+relative.encode()+b'\0'+os.fsencode(os.readlink(current)))
            if on_progress is not None:on_progress(0,1)
            return
        if stat.S_ISDIR(value.st_mode):
            result.update(b'D'+relative.encode()+b'\0')
            if on_progress is not None:on_progress(0,1)
            for child in sorted(current.iterdir(),key=lambda p:p.name):visit(child,relative+'/'+child.name)
        elif stat.S_ISREG(value.st_mode):
            result.update(b'F'+relative.encode()+b'\0')
            if on_progress is not None:on_progress(0,1)
            with current.open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):
                    result.update(block)
                    if on_progress is not None:on_progress(len(block),0)
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

    @staticmethod
    def device(path):
        path = _io_path(path)
        while not path.exists():
            path = path.parent
        return path.stat().st_dev

    def local_workspace(self, target, *, create=False):
        # The journal grants no arbitrary backup path. Derive a private sibling
        # from its authenticated installation, backup ID and whitelisted target.
        target = Path(target)
        key = hashlib.sha256((str(self.backup) + '\0' + str(target)).encode()).hexdigest()[:24]
        directory = safe_path(target.parent, '.nora-maintenance-' + key)
        receipt = directory / 'owner.json'
        expected = {'schema': 1, 'installRoot': str(self.root), 'backup': str(self.backup), 'target': str(target)}
        if create and not _io_path(directory).exists():
            _io_path(directory).mkdir(mode=0o700, parents=True)
            atomic_json(receipt, expected)
        if _io_path(directory).exists() and (linked(directory) or read_object(receipt) != expected):
            raise RuntimeError('目标卷的维护目录归属无法确认，未覆盖文件。')
        return directory

    def tree_storage(self, item, kind='saved', *, state=False, create=False):
        if 'targetVolume' in item and item['targetVolume'] is not True:
            raise RuntimeError('目标卷恢复记录无效')
        if item.get('targetVolume'):
            target = self.state_root() if state else self.target(item)
            return safe_path(self.local_workspace(target, create=create), kind)
        relative = ('state' if state else 'trees/' + item['name']) if kind == 'saved' else (
            'failed-new/state' if state else 'failed-new/' + item['name']) if kind == 'failed' else (
            'staged-state' if state else 'staged/' + item['name'])
        return safe_path(self.backup, relative)

    def state_backup(self):
        return self.tree_storage(self.plan['state'] or {}, state=True)

    def seal_volume_backups(self):
        entries=[]
        for item in self.plan['targets'] + ([self.plan['state']] if self.plan.get('state') else []):
            if not item.get('targetVolume'):continue
            state = item is self.plan.get('state')
            target = self.state_root() if state else self.target(item)
            folder = self.local_workspace(target)
            if not _io_path(folder).exists():continue
            entries.append({'state':state,'name':item.get('name'),'namespace':item.get('namespace'),
                            'relative':item.get('relative'),'identity':identity(folder),'digest':digest(folder)})
        if entries:
            atomic_json(self.backup/'target-volume-backups.json',{'schema':1,'entries':entries})

    def staged_tree(self, source, item, *, state=False):
        target = self.state_root() if state else self.target(item)
        if self.device(source) == self.device(target.parent):
            return source
        staged = self.tree_storage(item, 'staged', state=state, create=True)
        if _io_path(staged).exists():
            raise RuntimeError('目标卷已有未确认的暂存文件，已保留现场。')
        _io_path(staged).parent.mkdir(parents=True, exist_ok=True)
        if _io_path(source).is_dir():
            shutil.copytree(_io_path(source), _io_path(staged), symlinks=True)
        else:
            shutil.copy2(_io_path(source), _io_path(staged), follow_symlinks=False)
        if digest(source) != digest(staged):
            raise RuntimeError('目标卷暂存内容校验失败，未替换原文件。')
        item['newIdentity'] = identity(staged)
        self.save()  # Record the actual target-volume inode before any swap.
        return staged

    def state_root(self):
        value = self.plan.get('stateRoot')
        if value is None:
            return safe_path(self.root, 'tavern-state')
        # A journal must not grant authority over an arbitrary saved path.
        # Reconcile its explicit data target with this installation's binding.
        import runpy
        resolver = Path(__file__).resolve().parents[1] / 'scripts/nora-instance.py'
        binding = runpy.run_path(str(resolver))['configuration'](self.home)
        target = Path(value)
        if (not target.is_absolute() or target == Path(target.anchor)
                or Path(binding['installRoot']) != self.root or target != Path(binding['stateRoot'])):
            raise RuntimeError('剧情状态恢复路径与当前实例绑定不匹配')
        return safe_path(target, 'native-runtime').parent

    @classmethod
    def create(cls,home,root,backup,swaps,*,version,before,state=None,lifecycle=None,data_root=None):
        home,root,backup=map(lambda p:Path(p).resolve(),(home,root,backup))
        targets=[]
        for name,source,target in swaps:
            target=Path(target).absolute()
            # Independent installations may keep Hermes and Tavern in the
            # same root. The declared, whitelisted target owns its namespace.
            namespace='install' if name in ('app','ops','nora-mcp') else 'hermes'
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
              'phase':'prepared','metadataPhase':'pending','metadataIntents':[],
              'metadataWrites':{},'state':None}
        if data_root is not None and Path(data_root).resolve() != root/'tavern-state':
            plan['stateRoot'] = str(Path(data_root).resolve())
        if state is not None:
            if Path(state).resolve()!=root/'tavern-state':
                plan['stateRoot'] = str(Path(state).resolve())
            plan['state']={'oldIdentity':identity(state),'oldDigest':None,'savedIdentity':None,
                           'savedDigest':None,'newIdentity':None,'phase':'pending','mode':'copy'}
        for item, target in [(item, safe_path(root if item['namespace'] == 'install' else home, item['relative'])) for item in targets] + (
                [(plan['state'], Path(state))] if state is not None else []):
            if _io_path(target).exists() and cls.device(target) != cls.device(target.parent):
                raise RuntimeError('更新目标本身是挂载点，不能原子替换：' + str(target)
                    + '；请使用挂载卷内可替换的程序／数据子目录，原文件未移动。')
            if cls.device(target.parent) != cls.device(backup):
                item['targetVolume'] = True
        if lifecycle:
            instance=safe_path(home,'nora-instance.json')
            plan['instanceDigest']=digest(instance)
        refs=effect_closure_refs(home,root)
        previous=read_object(safe_path(root,'tavern-updates/transaction.json'),max_bytes=MAX_TRANSACTION_BYTES) if _io_path(safe_path(root,'tavern-updates/transaction.json')).exists() else None
        require_partial_history_before_replace(home,root,previous,refs)
        if refs:plan['effectClosureRefs']=refs
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
        if self.plan.get('effectClosureRefs') is not None:
            refs=effect_closure_refs(self.home,self.root)
            if any(ref not in refs for ref in self.plan['effectClosureRefs']):raise RuntimeError('系统历史引用缺失')
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
        standalone = before.get('scope') == 'standalone-tavern'
        instance_file = self.home / 'nora-instance.json'
        core = instance_file.is_file() and read_object(instance_file).get('deployment') == 'core'
        if standalone and (self.plan.get('lifecycle') is not None or (instance_file.exists() and not core)
                           or (self.root/'tavern-updates/nora-system.json').exists() and not core):
            raise RuntimeError('独立恢复计划不能接管启动器管理的实例')
        service_keys = ('running',) if standalone else ('running','gatewayRunning','clawchatConnected')
        if any(type(before.get(key)) is not bool for key in service_keys):
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
        runtime=self.plan.get('runtimeMetadata',{})
        if (not isinstance(runtime,dict) or any(key!='hermes:cron/jobs.json' for key in runtime)
                or not set(runtime)<=set(self.metadata_key(target) for target,_ in metadata_items)):
            raise RuntimeError('运行状态恢复快照无效')
        for target,saved in metadata_items:
            if self.metadata_key(target) in runtime:self.metadata_saved(target,saved)
        restores=self.plan.get('metadataRestores',{})
        allowed_restores={self.metadata_key(target) for target,_ in metadata_items}
        if (not isinstance(restores,dict) or not set(restores)<=allowed_restores
                or 'metadataIntents' in self.plan and not set(restores)<=set(self.plan['metadataIntents'])):
            raise RuntimeError('配置恢复检查点无效')
        archives=set()
        for target,saved in metadata_items:
            entry,_=self.metadata_restore_entry(target,saved)
            if entry is not None:
                if entry['archive'] in archives:raise RuntimeError('配置恢复归档路径重复')
                archives.add(entry['archive'])
        if 'metadataIntents' in self.plan:
            intents=self.plan['metadataIntents']
            allowed={self.metadata_key(target) for target,_ in metadata_items}
            if not isinstance(intents,list) or len(intents)!=len(set(intents)) or any(key not in allowed for key in intents):
                raise RuntimeError('配置恢复变更意图无效')
            writes=self.plan.get('metadataWrites')
            if writes is not None:
                if not isinstance(writes,dict) or set(writes)!=set(intents):
                    raise RuntimeError('配置写入收据与变更意图不一致')
                for key,entry in writes.items():
                    if (not isinstance(entry,dict) or set(entry)-{'before','after','afterDefinitionDigest','completed'}
                            or 'before' not in entry or 'after' not in entry
                            or type(entry.get('completed')) is not bool
                            or any(value is not None and not re.fullmatch('[a-f0-9]{64}',str(value)) for name,value in entry.items() if name!='completed')):
                        raise RuntimeError('配置写入收据无效')
        self.setup_metadata_intent()
        names=set();paths=set()
        if not isinstance(self.plan.get('targets'),list):raise RuntimeError('恢复计划目标列表格式无效')
        for item in self.plan['targets']:
            if not isinstance(item,dict) or not allowed_target(item.get('name',''),item.get('namespace'),item.get('relative')):
                raise RuntimeError('恢复计划目标不在受管范围')
            pair=(item['namespace'],item['relative'])
            if item['name'] in names or pair in paths:raise RuntimeError('恢复计划包含重复目标')
            names.add(item['name']);paths.add(pair)
            self.check_tree(item,self.target(item),self.tree_storage(item),full=full)
        state=self.plan.get('state')
        if state is not None and not isinstance(state,dict):raise RuntimeError('剧情状态恢复计划格式无效')
        if state:
            if state.get('verifiedBeforeResume') is not None:self.story_writes_released()
            active=self.state_root();saved=self.state_backup()
            if state.get('phase') in ('pending','copying','untouched'):
                if identity(active)!=state.get('oldIdentity'):raise RuntimeError('未完成状态备份且原数据身份已变化')
            else:self.check_tree(state,active,saved,state=True,full=full)
        return self

    def check_tree(self,item,target,saved,*,state=False,full=True):
        verify_current=full and not (state and self.story_writes_released())
        old=item.get('savedIdentity') if state and item.get('mode')=='copy' else item.get('oldIdentity')
        expected=item.get('savedDigest') if state and item.get('mode')=='copy' else item.get('oldDigest')
        saved_id=identity(saved);current_id=identity(target)
        if saved_id is not None:
            if saved_id!=old or (full and digest(saved)!=expected):raise RuntimeError('旧文件备份身份或内容不一致')
            accepted=(item.get('newIdentity'),item.get('oldIdentity')) if state else (item.get('newIdentity'),)
            if current_id is not None and current_id not in accepted:raise RuntimeError('当前目标身份未知，未覆盖文件')
        elif old is not None:
            if current_id!=old:raise RuntimeError('旧备份缺失且原目标尚未安全恢复')
            if verify_current and state and item.get('phase')=='restored':
                self.verify_story_inventory(target)
            elif verify_current and digest(target)!=expected:raise RuntimeError('原目标内容与旧备份不一致')
        elif current_id is not None and current_id!=item.get('newIdentity'):
            raise RuntimeError('新建目标身份未知，未覆盖文件')

    def story_checkpoint(self):
        state=self.plan.get('state')
        if not state or state.get('phase') not in ('restored','untouched'):return None
        inventory=json.dumps(state.get('storyInventory',{}),sort_keys=True,separators=(',',':')).encode()
        copied=state.get('phase')=='restored' and state.get('mode')=='copy'
        return {'schema':1,'phase':state['phase'],'identity':state.get('savedIdentity') if copied else state.get('oldIdentity'),
                'digest':state.get('savedDigest') if copied else state.get('oldDigest'),
                'inventorySha256':hashlib.sha256(inventory).hexdigest()}

    def story_writes_released(self):
        state=self.plan.get('state') or {};checkpoint=state.get('verifiedBeforeResume')
        if checkpoint is not None:
            identity_value=checkpoint.get('identity') if isinstance(checkpoint,dict) else None
            if (not isinstance(checkpoint,dict) or type(checkpoint.get('schema')) is not int
                    or identity_value is not None and (not isinstance(identity_value,list) or len(identity_value)!=2
                        or any(type(value) is not int for value in identity_value))
                    or checkpoint!=self.story_checkpoint()):
                raise RuntimeError('恢复数据验收检查点与原来源不一致')
            return True
        # Older writers also validated offline before these durable phases.
        # Preserve that boundary when continuing an interrupted service restart.
        return (state.get('phase') in ('restored','untouched') and self.plan.get('metadataPhase')=='restored'
                and all(item.get('phase') in ('pending','restored') for item in self.plan.get('targets',[]))
                and (self.plan.get('phase')=='restored' and self.record.get('status')=='restored'
                     or self.plan.get('phase')=='resuming-services' and self.record.get('status') in RECOVERABLE_STATES))

    def mark_story_verified(self):
        checkpoint=self.story_checkpoint()
        if checkpoint is not None:self.plan['state']['verifiedBeforeResume']=checkpoint

    def verify_story_inventory(self,target):
        for relative,expected in (self.plan.get('state') or {}).get('storyInventory',{}).items():
            current=safe_path(target,relative)
            if _io_path(current).is_file() and digest(current)==expected:continue
            if not _io_path(current).exists() and self.startup_backup(relative,expected) is not None:
                continue  # A verified maintenance archive retains the rotating copy.
            kind='changed' if _io_path(current).exists() else 'missing'
            error=RuntimeError('恢复后原有剧情数据发生变化 '
                               f'[relative={relative}; reason={kind}; expected={expected}]')
            error.code='RECOVERY_DATA_UNCONFIRMED';error.relative_path=relative
            raise error

    def automatic_chat_backup(self,relative,expected,*,prepare=False):
        """Recognize committed v1 automatic pairs, without duplicating retention.

        The chat store owns expiration/count/byte decisions. Retain exact original
        bytes here before resuming it; protected, legacy and unknown files never
        acquire this exception merely by living under a backups directory.
        """
        parts=Path(relative).parts
        if len(parts)<4 or parts[0]!='native' or parts[2]!='backups':return None
        match=(re.fullmatch(r'chat_nora1_([a-f0-9-]{36})\.jsonl',parts[3]) if len(parts)==4
               else re.fullmatch(r'([a-f0-9-]{36})\.json',parts[4])
               if len(parts)==5 and parts[3]=='.nora-chat' else None)
        if match is None:return None
        backup_id=match[1];base=Path('native')/parts[1]/'backups'
        pair=[(base/f'chat_nora1_{backup_id}.jsonl').as_posix(),(base/'.nora-chat'/f'{backup_id}.json').as_posix()]
        inventory=(self.plan.get('state') or {}).get('storyInventory',{})
        if inventory.get(relative)!=expected or any(name not in inventory for name in pair):return None
        archive=safe_path(self.backup,'startup-chat-backups')

        def verified(root):
            data,metadata=[safe_path(root,name) for name in pair]
            if any(not _io_path(file).is_file() for file in (data,metadata)):return False
            if any(digest(file)!=inventory[name] for name,file in zip(pair,(data,metadata))):return False
            try:value=read_object(metadata,max_bytes=65536)
            except (OSError,ValueError,RuntimeError):return False
            if (type(value.get('version')) is not int or value['version']!=1
                    or value.get('id')!=backup_id or value.get('protected') is not False
                    or not re.fullmatch('[a-f0-9]{64}',str(value.get('sha256','')))
                    or not re.fullmatch('[a-f0-9]{64}',str(value.get('sessionKey','')))
                    or any(type(value.get(key)) is not int or value[key]<minimum or value[key]>2**53-1
                           for key,minimum in (('bytes',0),('createdAt',0),('sequence',1)))
                    or value['bytes']>256*1024*1024 or value['bytes']!=_io_path(data).stat().st_size
                    or value.get('consistency')!='chat-only'
                    or (value.get('mvuState') if value.get('mvuState') is not None else 'unverified')
                        not in ('unverified','pending','incomplete','confirmed')
                    or any(key not in value or value[key] is not None and not isinstance(value[key],str)
                           for key in ('worldId','sessionId'))):return False
            actual=hashlib.sha256()
            with _io_path(data).open('rb') as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b''):actual.update(chunk)
            return actual.hexdigest()==value['sha256']

        present=[_io_path(safe_path(archive,name)).exists() for name in pair]
        if any(present):
            for name,exists in zip(pair,present):
                if exists and digest(safe_path(archive,name))!=inventory[name]:
                    raise RuntimeError('启动前封存的聊天备份已变化，已保留现场')
            if all(present):
                if not verified(archive):raise RuntimeError('启动前封存的聊天备份无法核验，已保留现场')
                return safe_path(archive,relative)
        if not prepare:return None
        for root in (self.state_root(),self.state_backup(),self.tree_storage(self.plan['state'], 'failed', state=True)):
            if not verified(root):continue
            for name,exists in zip(pair,present):
                if not exists:copy_startup_backup(safe_path(root,name),safe_path(archive,name),inventory[name])
            if not verified(archive):raise RuntimeError('启动前封存的聊天备份无法核验，未启动旧版本')
            return safe_path(archive,relative)
        return None

    def startup_backup(self,relative,expected,*,prepare=False):
        parts=Path(relative).parts
        # SillyTavern rotates exactly these automatic settings backups at
        # startup. Preserve their bytes, rather than weakening story checks.
        if (len(parts)!=4 or parts[0]!='native' or parts[2]!='backups'
                or re.fullmatch('settings_'+re.escape(parts[1])+r'_[0-9]{8}-[0-9]{6}\.json',parts[3]) is None):
            return self.automatic_chat_backup(relative,expected,prepare=prepare)
        archive=safe_path(self.backup,'startup-settings-backups/'+Path(relative).as_posix())
        if _io_path(archive).exists():
            if not _io_path(archive).is_file() or digest(archive)!=expected:
                raise RuntimeError('启动前封存的设置备份已变化，已保留现场')
            return archive
        if not prepare:return None
        for root in (self.state_root(),self.state_backup(),self.tree_storage(self.plan['state'], 'failed', state=True)):
            source=safe_path(root,Path(relative).as_posix())
            if _io_path(source).is_file() and digest(source)==expected:
                copy_startup_backup(source,archive,expected)
                return archive
        raise RuntimeError('无法封存原有自动设置备份，未启动旧版本')

    def preserve_startup_backups(self,*,restore=False):
        for relative,expected in (self.plan.get('state') or {}).get('storyInventory',{}).items():
            saved=self.startup_backup(relative,expected,prepare=not restore)
            if saved is None or not restore:continue
            if saved.relative_to(self.backup).parts[0]=='startup-chat-backups':
                continue  # Keep normal retention in effect; recovery evidence stays archived.
            target=safe_path(self.state_root(),Path(relative).as_posix())
            if not _io_path(target).exists():
                copy_startup_backup(saved,target,expected)

    def swap(self,name):
        item=next(i for i in self.plan['targets'] if i['name']==name)
        source=self._sources[name];target=self.target(item);saved=self.tree_storage(item, create=True)
        if source is not None:source=self.staged_tree(source,item)
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
        if self.metadata_key(target) in self.plan.get('metadataIntents',[]):self.finish_metadata([target])

    def bind_sources(self,swaps):
        self._sources={name:Path(source) if source is not None else None for name,source,_ in swaps}
        return self

    def metadata_key(self,target):
        if self.plan.get('stateRoot') and target == self.state_root() / 'native-runtime/dependencies.json':
            return 'state:native-runtime/dependencies.json'
        owner=self.root if target.is_relative_to(self.root) else self.home
        return ('install:' if owner==self.root else 'hermes:')+target.relative_to(owner).as_posix()

    def metadata_role(self,target):
        key=self.metadata_key(target)
        if key=='hermes:cron/jobs.json':return 'hermes-cron','task-definitions-and-runtime-state'
        if key.startswith(('install:', 'state:')):return 'nora-updater','installation-receipt'
        if key in ('hermes:config.yaml','hermes:AGENTS.md','hermes:AGENTS.md.bak'):
            return 'user','user-configuration'
        return 'nora-updater-and-user','managed-configuration'

    def metadata_saved(self,target,saved):
        entry=self.plan.get('runtimeMetadata',{}).get(self.metadata_key(target))
        if entry is None:return saved
        if (self.metadata_key(target)!='hermes:cron/jobs.json' or not isinstance(entry,dict)
                or set(entry)!= {'snapshot','digest','definitionDigest'}
                or entry.get('snapshot')!='runtime-state/cron-jobs.json'):
            raise RuntimeError('运行状态恢复快照无效')
        snapshot=safe_path(self.backup,entry['snapshot'])
        if (not _io_path(snapshot).is_file() or linked(snapshot) or digest(snapshot)!=entry.get('digest')
                or cron_definition(snapshot)!=entry.get('definitionDigest')
                or cron_definition(saved)!=entry.get('definitionDigest')):
            raise RuntimeError('运行状态恢复快照缺失或已变化')
        return snapshot

    def metadata_diagnostics(self):
        """Expose only fixed relative paths, ownership, classifications and hashes."""
        result=[]
        for target,saved in self.metadata_items():
            key=self.metadata_key(target);entry=self.plan.get('runtimeMetadata',{}).get(key)
            if entry is not None:
                owner,kind=self.metadata_role(target)
                result.append(f'path={key}; owner={owner}; type={kind}; classification=runtime-state-only; '
                    f'before={digest(saved)}; after={entry["digest"]}; definition={entry["definitionDigest"]}')
        return result

    def check_metadata_before_write(self,items,*,offline=False):
        for target,saved in items:
            saved=self.metadata_saved(target,saved)
            current=digest(target) if _io_path(target).exists() else None
            original=digest(saved) if _io_path(saved).exists() else None
            if current!=original:
                key=self.metadata_key(target);owner,kind=self.metadata_role(target)
                if offline and key=='hermes:cron/jobs.json' and key not in self.plan.get('runtimeMetadata',{}):
                    try:before=cron_definition(saved);after=cron_definition(target)
                    except (OSError,ValueError,RuntimeError):before=after=None
                    if before is not None and before==after:
                        snapshot=safe_path(self.backup,'runtime-state/cron-jobs.json')
                        _io_path(snapshot).parent.mkdir(parents=True,exist_ok=True)
                        shutil.copy2(_io_path(target),_io_path(snapshot),follow_symlinks=False)
                        if linked(snapshot) or digest(snapshot)!=current or digest(target)!=current:
                            raise RuntimeError('停服运行状态在封存期间变化，未替换配置。')
                        self.plan.setdefault('runtimeMetadata',{})[key]={'snapshot':'runtime-state/cron-jobs.json',
                            'digest':current,'definitionDigest':before}
                        continue
                # Only a whitelisted logical path, ownership and hashes reach logs.
                error=RuntimeError('准备更新后配置已发生变化，当前配置已保留。请重新检查并准备更新。 '
                    f'[path={key}; owner={owner}; type={kind}; before={original}; after={current}]')
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
        self.check_metadata_before_write(self.metadata_items(),offline=True)
        self.save()

    def setup_metadata_intent(self):
        """Authorize only the exact first-setup postimage declared before its write."""
        intent=self.plan.get('setupMetadataIntent')
        if intent is None:return None
        def reject():raise RuntimeError('初始化写入意图无法核验，当前记录已保留。')
        if (not isinstance(intent,dict) or set(intent)!={'schema','key','beforeText','before','after','newline','operationId','ownerEpoch'}
                or intent['schema']!='nora-setup-metadata-intent/1' or intent['key']!=SETUP_METADATA_KEY
                or not isinstance(intent['beforeText'],str) or intent['newline'] not in ('\n','\r\n')
                or type(intent['operationId']) is not type(self.record.get('operationId'))
                or type(intent['ownerEpoch']) is not type(self.record.get('ownerEpoch'))
                or intent['operationId']!=self.record.get('operationId') or intent['ownerEpoch']!=self.record.get('ownerEpoch')):
            reject()
        try:
            encoded=intent['beforeText'].encode('utf-8')
            if len(encoded)>2*1024*1024:reject()
            original=json.loads(intent['beforeText'])
            if (not isinstance(original,dict) or type(original.get('schema')) is not int or original['schema']!=1
                    or original.get('setupCompleted') is not False or original.get('version')!=self.record.get('version')
                    or not re.fullmatch('[a-f0-9]{40}',str(original.get('commit','')))
                    or not isinstance(original.get('proof'),dict)
                    or any(original['proof'].get(name) is not True for name in
                           ('hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'))):reject()
            expected=json.dumps({**original,'setupCompleted':True},ensure_ascii=False,indent=2,allow_nan=False).replace('\n',intent['newline']).encode('utf-8')
        except (UnicodeError,ValueError,TypeError):reject()
        entry=self.plan.get('metadataWrites',{}).get(SETUP_METADATA_KEY)
        before=self.plan.get('before');lifecycle=self.plan.get('lifecycle')
        if (not isinstance(entry,dict) or entry.get('completed') is not True
                or SETUP_METADATA_KEY not in self.plan.get('metadataIntents',[])
                or self.plan.get('metadataPhase') not in ('applying','restored')
                or hashlib.sha256(b'F\0'+encoded).hexdigest()!=intent['before']
                or hashlib.sha256(b'F\0'+expected).hexdigest()!=intent['after']
                or entry.get('after') not in (intent['before'],intent['after'])
                or not isinstance(before,dict) or not isinstance(lifecycle,dict) or not isinstance(lifecycle.get('before'),dict)
                or any(before.get(name) is not True or lifecycle['before'].get(name) is not True
                       for name in ('running','gatewayRunning'))):reject()
        return intent

    def prepare_setup_metadata(self,before_text):
        original=json.loads(before_text)
        expected=json.dumps({**original,'setupCompleted':True},ensure_ascii=False,indent=2,allow_nan=False).replace('\n',os.linesep).encode('utf-8')
        intent={'schema':'nora-setup-metadata-intent/1','key':SETUP_METADATA_KEY,'beforeText':before_text,
            'before':hashlib.sha256(b'F\0'+before_text.encode('utf-8')).hexdigest(),
            'after':hashlib.sha256(b'F\0'+expected).hexdigest(),'newline':os.linesep,
            'operationId':self.record.get('operationId'),'ownerEpoch':self.record.get('ownerEpoch')}
        previous=self.plan.get('setupMetadataIntent')
        if previous is not None and (self.setup_metadata_intent()!=intent):
            raise RuntimeError('初始化写入意图已经变化，当前记录已保留。')
        self.plan['setupMetadataIntent']=intent
        try:
            self.setup_metadata_intent()
            self.save()  # The verifier must not run until this intent is durable.
        except BaseException:
            if previous is None:self.plan.pop('setupMetadataIntent',None)
            else:self.plan['setupMetadataIntent']=previous
            raise
        return intent

    def mark_metadata(self,targets):
        items={self.metadata_key(target):(target,saved) for target,saved in self.metadata_items()}
        keys=[self.metadata_key(Path(target).absolute()) for target in targets]
        if any(key not in items for key in keys):raise RuntimeError('配置变更目标超出受管范围')
        fresh=[key for key in keys if key not in self.plan.get('metadataIntents',[])]
        self.check_metadata_before_write([items[key] for key in fresh])
        if 'metadataWrites' in self.plan:
            for key in keys:
                target,_=items[key]
                if key in self.plan['metadataWrites']:self.check_owned_metadata(target)
                self.plan['metadataWrites'][key]={'before':digest(target) if _io_path(target).exists() else None,'after':None,'completed':False}
        self.plan.setdefault('metadataIntents',[]).extend(fresh)
        self.plan['metadataPhase']='applying';self.save()

    def finish_metadata(self,targets):
        """Record successful owned-writer outputs, not unverified future changes."""
        if 'metadataWrites' not in self.plan:return
        for target in targets:
            target=Path(target).absolute();key=self.metadata_key(target)
            if key not in self.plan.get('metadataIntents',[]):raise RuntimeError('配置写入缺少变更意图')
            entry=self.plan['metadataWrites'].setdefault(key,{'before':None,'after':None,'completed':False})
            entry['after']=digest(target) if _io_path(target).exists() else None
            if key=='hermes:cron/jobs.json' and _io_path(target).exists():
                # Old stores can contain a noncanonical/invalid document. Its exact
                # owned write remains recoverable; it gains no semantic exemption.
                entry.pop('afterDefinitionDigest',None)
                try:entry['afterDefinitionDigest']=cron_definition(target)
                except (OSError,ValueError,RuntimeError):pass
            entry['completed']=True
        self.save()

    def metadata_restore_entry(self,target,saved):
        entry=self.plan.get('metadataRestores',{}).get(self.metadata_key(target))
        if entry is None:return None,False
        if (not isinstance(entry,dict) or set(entry)-{'targetVolume'}!={'archive','currentDigest','currentIdentity','savedDigest','phase'}
                or 'targetVolume' in entry and entry['targetVolume'] is not True
                or not isinstance(entry['archive'],str)
                or not re.fullmatch(r'failed-new/metadata/[a-f0-9]{32}/(?:0|[1-9][0-9]*)',entry['archive'])
                or entry['phase'] not in ('intent','archived','restored')
                or any(value is not None and not re.fullmatch('[a-f0-9]{64}',str(value))
                       for value in (entry['currentDigest'],entry['savedDigest']))
                or (entry['currentDigest'] is None) != (entry['currentIdentity'] is None)
                or entry['currentIdentity'] is not None and (not isinstance(entry['currentIdentity'],list)
                    or len(entry['currentIdentity'])!=2 or any(type(value) is not int for value in entry['currentIdentity']))):
            raise RuntimeError('配置恢复检查点无效')
        saved=self.metadata_saved(target,saved)
        if entry['savedDigest']!=(digest(saved) if _io_path(saved).exists() else None):
            raise RuntimeError('配置恢复快照与检查点不一致')
        archive=self.metadata_archive(target,entry);archived=_io_path(archive).exists()
        if archived:
            if (entry['currentDigest'] is None or identity(archive)!=entry['currentIdentity']
                    or digest(archive)!=entry['currentDigest']):
                raise RuntimeError('配置恢复归档身份或内容已变化，已保留现场。')
        elif entry['currentDigest'] is not None and (entry['phase']!='intent' or not _io_path(target).exists()):
            raise RuntimeError('配置恢复归档缺失，已保留现场。')
        return entry,archived

    def metadata_archive(self,target,entry,*,create=False):
        if entry.get('targetVolume'):
            return safe_path(self.local_workspace(target,create=create),'metadata-original')
        return safe_path(self.backup,entry['archive'])

    def check_owned_metadata(self,target):
        key=self.metadata_key(target)
        current=digest(target) if _io_path(target).exists() else None
        for candidate,saved in self.metadata_items():
            if candidate==target:
                restoring,archived=self.metadata_restore_entry(target,saved);break
        else:restoring,archived=None,False
        if restoring is not None:
            if restoring['phase']=='restored':return  # Never overwrite later user edits on retry.
            if current==restoring['savedDigest']:return
            if archived and current is None:return
            if not archived and current==restoring['currentDigest'] and identity(target)==restoring['currentIdentity']:return
            owner,kind=self.metadata_role(target)
            error=RuntimeError('配置恢复期间出现未归属的变化，当前配置已保留。 '
                f'[path={key}; owner={owner}; type={kind}; expected={restoring["savedDigest"]}; after={current}]')
            error.code='CONDITIONS_CHANGED';raise error
        if 'metadataWrites' not in self.plan:return  # Existing journals keep their original contract.
        entry=self.plan['metadataWrites'].get(key)
        if entry is None:raise RuntimeError('配置恢复缺少写入收据，当前配置已保留。')
        setup_intent=self.setup_metadata_intent()
        if current==entry['before'] or entry['completed'] and current==entry['after']:return
        if key==SETUP_METADATA_KEY and setup_intent is not None and current==setup_intent['after']:return
        for candidate,saved in self.metadata_items():
            if candidate==target:
                saved=self.metadata_saved(target,saved)
                if current==(digest(saved) if _io_path(saved).exists() else None):return
                break
        if key=='hermes:cron/jobs.json' and entry.get('afterDefinitionDigest'):
            try:
                if cron_definition(target)==entry['afterDefinitionDigest']:return
            except (OSError,ValueError,RuntimeError):pass
        owner,kind=self.metadata_role(target)
        error=RuntimeError('配置写入后出现未归属的变化，当前配置已保留。 '
            f'[path={key}; owner={owner}; type={kind}; expected={entry["after"]}; after={current}]')
        error.code='CONDITIONS_CHANGED';raise error

    def snapshot_state(self):
        item=self.plan['state']
        if item is None:return
        source=self.state_root();saved=self.tree_storage(item, state=True, create=True)
        reject_links(source)
        item['oldDigest']=digest(source);item['phase']='copying';self.save()
        shutil.copytree(_io_path(source),_io_path(saved),symlinks=True)
        item['savedIdentity']=identity(saved);item['savedDigest']=digest(saved)
        item['storyInventory']=story_inventory(saved)
        if item['savedDigest']!=item['oldDigest']:raise RuntimeError('剧情数据快照校验失败')
        item['phase']='saved';self.save()

    def apply_state(self,source):
        item=self.plan['state'];target=self.state_root();saved=self.tree_storage(item, state=True, create=True)
        source=self.staged_tree(source,item,state=True)
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
        items.append((self.state_root() / 'native-runtime/dependencies.json', safe_path(self.backup,'host/native-runtime/dependencies.json')))
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
        # Check all configuration first. A later conflict must not partially overwrite
        # other user changes before it is noticed.
        if self.plan.get('metadataPhase')=='restored':return
        for target,_ in self.metadata_items():
            if self.metadata_key(target) in self.plan.get('metadataIntents',[]):self.check_owned_metadata(target)
        for index,(target,saved) in enumerate(self.metadata_items()):
            if 'metadataIntents' in self.plan and self.metadata_key(target) not in self.plan['metadataIntents']:continue
            saved=self.metadata_saved(target,saved)
            key=self.metadata_key(target);entry,archived=self.metadata_restore_entry(target,saved)
            if entry is not None and entry['phase']=='restored':continue
            if _io_path(target).exists() and _io_path(saved).exists() and digest(target)==digest(saved):
                restore_permissions(saved,target)
                if entry is not None:entry['phase']='restored';self.save()
                continue
            if not _io_path(target).exists() and not _io_path(saved).exists():
                if entry is not None:entry['phase']='restored';self.save()
                continue
            if entry is None:
                entry={'archive':'failed-new/metadata/'+uuid.uuid4().hex+'/'+str(index),
                    'currentDigest':digest(target) if _io_path(target).exists() else None,
                    'currentIdentity':identity(target),'savedDigest':digest(saved) if _io_path(saved).exists() else None,
                    'phase':'intent'}
                if self.device(target.parent) != self.device(self.backup):
                    entry['targetVolume'] = True
                self.plan.setdefault('metadataRestores',{})[key]=entry;self.save()
            archive=self.metadata_archive(target,entry,create=True)
            if _io_path(target).exists():
                self.check_owned_metadata(target)
                if archived:raise RuntimeError('配置恢复目标与归档同时存在，当前配置已保留。')
                _io_path(archive).parent.mkdir(parents=True,exist_ok=True);os.replace(_io_path(target),_io_path(archive))
            entry['phase']='archived';self.save()
            if _io_path(saved).exists():
                _io_path(target).parent.mkdir(parents=True,exist_ok=True)
                temporary=target.with_name('.nora-restore-'+uuid.uuid4().hex)
                if _io_path(saved).is_dir():shutil.copytree(_io_path(saved),_io_path(temporary),symlinks=True)
                else:shutil.copy2(_io_path(saved),_io_path(temporary))
                if _io_path(target).exists():
                    error=RuntimeError('配置恢复期间目标重新出现，当前配置已保留。');error.code='CONDITIONS_CHANGED';raise error
                os.replace(_io_path(temporary),_io_path(target))
            entry['phase']='restored';self.save()

    def receipt_status(self,status):
        path=safe_path(self.backup,RECEIPT);receipt=read_object(path)
        if (receipt.get('owner')!='nora-tavern-updater' or receipt.get('schema')!='nora-update-backup/1'
                or receipt.get('installRoot')!=str(self.root) or receipt.get('backupId')!=self.backup.name):
            raise RuntimeError('恢复备份归属无法确认，未改写记录')
        receipt['status']=status;atomic_json(path,receipt)


def retire_volume_backups(home,root,backup,state):
    """Prune only unchanged committed sidecars bound to current managed targets.

    Changed/missing evidence retains the backup; it never blocks an update.
    """
    home,root,backup,state=map(Path,(home,root,backup,state))
    index=safe_path(backup,'target-volume-backups.json')
    if not _io_path(index).exists():return
    value=read_object(index)
    if value.get('schema')!=1 or not isinstance(value.get('entries'),list):
        raise RuntimeError('目标卷备份索引无效，保留旧备份。')
    journal=Journal(home,root,{'backup':str(backup),'recoveryPlan':{}})
    folders=[]
    for entry in value['entries']:
        if entry.get('state') is True:
            target=state
        elif entry.get('state') is False and allowed_target(entry.get('name'),entry.get('namespace'),entry.get('relative')):
            target=safe_path(root if entry['namespace']=='install' else home,entry['relative'])
        else:raise RuntimeError('目标卷备份目标无法确认，保留旧备份。')
        folder=journal.local_workspace(target)
        if folder in folders or identity(folder)!=entry.get('identity') or digest(folder)!=entry.get('digest'):
            raise RuntimeError('目标卷备份已变化，保留旧备份。')
        folders.append(folder)
    for folder in folders:shutil.rmtree(_io_path(folder))


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
            saved=journal.tree_storage(item)
            if identity(saved) is not None and digest(saved)!=item.get('oldDigest'):
                raise RuntimeError('旧程序恢复备份已变化')
        state=plan.get('state')
        if state and state.get('savedDigest'):
            saved=journal.state_backup()
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
        data_pending=state and state.get('phase')=='restored' and not journal.story_writes_released()
        outcome=('not-required' if effect=='untouched' else 'recovery-required' if data_pending
                 else 'restored-and-verified' if journal.record.get('status')=='restored'
                 else 'files-restored-start-failed' if effect=='restored' else 'recovery-required')
        return {'effectState':effect,'recoveryOutcome':outcome,'reason':'',
                'canRecover':journal.record.get('status') in RECOVERABLE_STATES,
                'status':journal.record.get('status'),'operationId':journal.record.get('operationId')}
    except (OSError,ValueError,KeyError,TypeError,RuntimeError) as error:
        return {'effectState':'unknown','recoveryOutcome':'recovery-required','canRecover':False,'reason':str(error)}


def recover(home,root,*,stop,resume,verify,verify_files=None):
    journal=load(home,root);plan=journal.plan;backup=journal.backup
    gate=getattr(sys,'_nora_operation_delegate',None)
    if gate is not None:
        gate.assert_active()
        if journal.record.get('operationId') and journal.record['operationId']!=gate.operation_id:
            raise RuntimeError('更新事务属于另一次操作，未覆盖当前文件。请从原操作恢复入口继续。')
    reason=recovery_block_reason(journal.record.get('status'))
    if reason:raise RuntimeError(reason)
    original_effect=effects(home,root)['effectState']
    data_released=journal.story_writes_released()
    if data_released:journal.mark_story_verified()
    try:
        plan['phase']='stopping';journal.save('recovery-failed')
        stopped=stop(plan,backup)
        if not isinstance(stopped,dict) or stopped.get('offline') is not True:
            raise RuntimeError('未确认服务停止状态，未恢复文件。请重新检查状态并保留备份。')
        plan['phase']='restoring-files';journal.save()
        for item in reversed(plan['targets']) if original_effect!='untouched' else []:
            journal.restore_tree(item,journal.target(item),journal.tree_storage(item),
                                 journal.tree_storage(item,'failed',create=True))
        if plan.get('state') and original_effect!='untouched':
            journal.restore_tree(plan['state'],journal.state_root(),journal.state_backup(),
                                 journal.tree_storage(plan['state'],'failed',state=True,create=True),state=True)
        elif plan.get('state'):
            plan['state']['phase']='untouched';journal.save()
        plan['phase']='restoring-metadata';journal.save();journal.restore_metadata()
        plan['metadataPhase']='restored';journal.save()
        # Authoritative backup and managed bytes are checked while services are
        # offline. Running code may legitimately create cache/generated files.
        journal.validate()
        if verify_files is not None and not data_released:verify_files(plan,backup)
        journal.preserve_startup_backups()
        journal.mark_story_verified()
        plan['phase']='resuming-services';journal.save();resume(plan,backup)
        journal.preserve_startup_backups(restore=True)
        proof=verify(plan,backup)
        before=plan['before']
        if not isinstance(proof,dict) or proof.get('version')!=before['version']:
            raise RuntimeError('恢复后的旧版本核验失败')
        standalone = before.get('scope') == 'standalone-tavern'
        for key in (('running',) if standalone else ('running','gatewayRunning','clawchatConnected')):
            if type(proof.get(key)) is not bool:raise RuntimeError('恢复后缺少明确服务状态：'+key)
        for key in (('running',) if standalone else ('running','gatewayRunning')):
            if before[key]!=proof[key]:raise RuntimeError('未恢复原服务状态：'+key)
        if before.get('clawchatConnected') and not proof['clawchatConnected']:
            raise RuntimeError('未恢复原服务状态：clawchatConnected')
        # Identity remains strict after start, without whole-tree byte checks.
        journal.validate(full=False)
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
