#!/usr/bin/env python3
"""Enable and inspect one installed skill through the current Hermes configuration APIs."""
import argparse,json,os,sys,uuid
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('id');p.add_argument('--hermes-root');p.add_argument('--platform');args=p.parse_args()
home=Path(os.environ['HERMES_HOME']).resolve();root=Path(args.hermes_root).resolve() if args.hermes_root else home/'hermes-agent'
result={'ok':False,'code':'HERMES_UNAVAILABLE','message':'找不到当前实例的 Hermes 程序；文件安装与启用尚需分别核对'}
try:
 if not (root/'tools/skills_tool.py').is_file():raise RuntimeError('runtime missing')
 sys.path.insert(0,str(root));os.chdir(home)
 if args.platform:os.environ['HERMES_PLATFORM']=args.platform
 from hermes_cli.config import read_raw_config,save_config,get_config_path
 from hermes_cli.skills_config import _normalize_skill_names
 from tools.skills_tool import _find_all_skills,skill_view
 target=home/'skills/creative'/args.id
 if not (target/'SKILL.md').is_file():raise RuntimeError('skill missing')
 cfg=read_raw_config() or {};skills=cfg.get('skills') or {};changed=False;backup=None
 global_disabled=_normalize_skill_names(skills.get('disabled'))
 platform=args.platform or os.getenv('HERMES_PLATFORM') or os.getenv('HERMES_SESSION_PLATFORM')
 if args.id in global_disabled:
  skills['disabled']=sorted(global_disabled-{args.id});changed=True
 if platform:
  by_platform=skills.get('platform_disabled') or {};disabled=_normalize_skill_names(by_platform.get(platform))
  if args.id in disabled:
   by_platform[platform]=sorted(disabled-{args.id});skills['platform_disabled']=by_platform;changed=True
 if changed:
  cfg['skills']=skills;path=get_config_path()
  if path.resolve()!=home/'config.yaml':raise RuntimeError('config ownership mismatch')
  if path.exists():
   directory=home/'.nora-skill-library/backups';directory.mkdir(parents=True,mode=0o700,exist_ok=True)
   backup=directory/('config-'+str(uuid.uuid4())+'.yaml')
   with backup.open('xb') as f:os.chmod(backup,0o600);f.write(path.read_bytes())
  save_config(cfg,strip_defaults=False,merge_existing=True)
 found={s['name'] for s in _find_all_skills()}
 if args.id not in found:
  result={'ok':False,'code':'NOT_VISIBLE','message':'技能文件存在，但在当前 Hermes 平台或环境中仍不可见；未执行技能','config_changed':changed,'backup':str(backup) if backup else None}
 else:
  detail=json.loads(skill_view(args.id,preprocess=False))
  if detail.get('success') and Path(detail.get('skill_dir','')).resolve()==target.resolve():
   result={'ok':True,'status':'enabled','enabled':True,'hermes_visible':True,'hermes_readable':True,'agent_context_loaded':False,'config_changed':changed,'backup':str(backup) if backup else None}
  else:result={'ok':False,'code':'LOAD_NOT_CONFIRMED','message':'当前技能加载失败或被同名的其他来源遮挡；未执行技能','config_changed':changed,'backup':str(backup) if backup else None}
except Exception:
 result={'ok':False,'code':'ACTIVATION_FAILED','message':'无法通过当前 Hermes 确认启用，请核对运行环境与配置；不要据此重装其他实例'}
print(json.dumps(result,ensure_ascii=False));sys.exit(0 if result['ok'] else 1)
