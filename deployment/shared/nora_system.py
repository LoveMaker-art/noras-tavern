"""Nora installation facts, independent of launcher UI and process state."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile

SKILLS = ("creative/tavern", "creative/tavern-ops", "creative/nora-cardforge", "system/tavern-updater",
          "system/model-provider-config")
MANAGED_FILES = ("hooks/tavern-liveware-register/HOOK.yaml", "hooks/tavern-liveware-register/handler.py",
                 "scripts/nora-instance.py", "scripts/nora-tavern-update-check.py", "scripts/nora-tavern-card-send.py")
CLAWCHAT_SKILLS = ("clawchat-core", "clawchat-liveware", "clawchat-liveware-dev",
                   "clawchat-liveware-sample", "clawchat-set-greeting")
PROOFS = ("hermesContext", "mcpInstanceRead", "managedConfiguration", "clawchatRegistration")


def install_greeting(home, source):
    spec = importlib.util.spec_from_file_location("nora_managed_context", source / "ops/updater/managed_context.py")
    context = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(context)
    with tempfile.TemporaryDirectory(prefix="greeting-", dir=home) as temporary:
        swaps, report = context.prepare_greeting(home, source, Path(temporary))
        for _, prepared, target in swaps:
            context.atomic(target, prepared.read_bytes())
    return report


def record_files_ready(home):
    files = inventory(home)
    files.update({name: digest(home / name) for name in MANAGED_FILES})
    save_json(home / "nora-installation.json", {"schema": 1, "files": files})


def files_ready(home):
    record = read_json(home / "nora-installation.json")
    files = record.get("files")
    if record.get("schema") != 1 or not isinstance(files, dict) or not files:
        return False
    for name, expected in files.items():
        path = (home / name).resolve()
        if not path.is_relative_to(home.resolve()) or not path.is_file() or digest(path) != expected:
            return False
    return all((home / name).is_file() and (home / name).stat().st_size for name in ("SOUL.md", "AGENTS.md", "clawchat/greeting.md"))


def configure_managed(home, root, nora_home, port, source, python, env):
    save_json(home / "nora-instance.json", {"schema": 1, "noraHome": str(nora_home),
              "hermesHome": str(home), "installRoot": str(root), "port": port,
              "releaseChannel": os.environ.get("NORA_RELEASE_CHANNEL", "stable")})
    install_greeting(home, source)
    seed_clawchat_skills(home, python, env)


def seed_clawchat_skills(home, python, env):
    # Use the plugin's supported seeding/registration API, retaining newer managed skills.
    probe = '''
import sys
from pathlib import Path
home = Path.cwd()
sys.path.insert(0, str(home / "plugins/clawchat"))
from clawchat_gateway import skill_update as skills
assert skills.bundled_skill_ids(), "No bundled ClawChat skills"
for name in skills.bundled_skill_ids():
    skills.seed_managed_skill(name, skills.bundled_skills_dir() / name / "SKILL.md")
skills.ensure_external_skills_dir()
'''
    result = subprocess.run([python, "-B", "-c", probe], cwd=home, env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("ClawChat 技能初始化失败")


def managed_problems(home, root, port):
    import yaml
    problems = []
    instance = read_json(home / "nora-instance.json")
    if (instance.get("schema") != 1 or instance.get("port") != port
            or instance.get("hermesHome") != str(home) or instance.get("installRoot") != str(root)):
        problems.append("Hook / 定时任务未绑定当前实例")
    for name in MANAGED_FILES:
        if not (home / name).is_file():
            problems.append("缺少托管组件：" + name)
    try:
        hook = yaml.safe_load((home / MANAGED_FILES[0]).read_text(encoding="utf-8"))
        if hook.get("events") != ["gateway:startup"]:
            problems.append("Nora 启动 Hook 未注册")
        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
        external = config.get("skills", {}).get("external_dirs", [])
        if not any((home / item).resolve() == (home / "clawchat-skills").resolve() for item in external):
            problems.append("ClawChat 技能未加入 Hermes 搜索路径")
    except (OSError, ValueError, TypeError, AttributeError, yaml.YAMLError):
        problems.append("Hook / ClawChat 技能配置无效")
    for name in CLAWCHAT_SKILLS:
        file = home / "clawchat-skills" / name / "SKILL.md"
        if not file.is_file() or not file.read_text(encoding="utf-8").strip():
            problems.append("缺少 ClawChat 技能：" + name)
    greeting = home / "clawchat/greeting.md"
    if not greeting.is_file() or not greeting.read_text(encoding="utf-8").strip():
        problems.append("缺少 Nora 首次问候配置")
    samples = home / "skills/creative/nora-cardforge/resources/starter-stories"
    stories = read_json(samples / "manifest.json").get("stories", [])
    expected = {"suzhou-rain", "xiamen-breeze"}
    if not isinstance(stories, list) or {item.get("id") for item in stories if isinstance(item, dict)} != expected:
        problems.append("内置故事资源清单不完整")
    else:
        for item in stories:
            if not isinstance(item, dict):
                problems.append("内置故事清单格式错误")
                continue
            file = (samples / str(item.get("file", ""))).resolve()
            if not file.is_relative_to(samples.resolve()) or not file.is_file() or digest(file) != item.get("sha256"):
                problems.append("内置故事资源校验失败")
                continue
            card = read_json(file)
            data = card.get("data", {})
            if card.get("spec") != "chara_card_v2" or not all(data.get(key) for key in ("name", "description", "scenario", "first_mes")):
                problems.append("内置故事卡内容不完整")
    for name in ("references/starter-stories.md", "scripts/starter-story.py"):
        if not (home / "skills/creative/nora-cardforge" / name).is_file():
            problems.append("缺少故事按需导入组件：" + name)
    jobs = read_json(home / "cron/jobs.json").get("jobs", [])
    if not isinstance(jobs, list):
        problems.append("Nora 定时任务记录格式错误")
        jobs = []
    selected = [job for job in jobs if isinstance(job, dict) and
                job.get("script") in ("nora-tavern-update-check.py", "nora-tavern-update-check.sh")]
    if len(selected) != 1 or not all((
            selected[0].get("script") == "nora-tavern-update-check.py",
            selected[0].get("enabled") is True, selected[0].get("no_agent") is True,
            selected[0].get("deliver") == "local",
            isinstance(selected[0].get("schedule"), dict) and selected[0]["schedule"].get("expr") == "0 9 * * *")):
        problems.append("Nora 定时检查任务缺失、重复或配置错误")
    return problems


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".nora-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(home):
    files = {}
    for skill in SKILLS:
        root = home / "skills" / skill
        if not (root / "SKILL.md").is_file():
            raise RuntimeError("缺少 Nora 技能：" + skill)
        for file in root.rglob("*"):
            if file.is_file():
                files[str(file.relative_to(home)).replace(os.sep, "/")] = digest(file)
    return files


def inspect(home, root, port):
    """Read-only structural check; custom SOUL/AGENTS edits are not overwritten."""
    import yaml
    problems = []
    record = read_json(root / "tavern-updates/nora-system.json")
    receipt = read_json(root / "tavern-updates/installed.json")
    if record.get("schema") != 1:
        problems.append("Nora 初始化尚未验证")
    proof = record.get("proof") if isinstance(record.get("proof"), dict) else {}
    if not all(proof.get(name) for name in PROOFS):
        problems.append("缺少 Nora 实际加载检查结果")
    problems.extend(managed_problems(home, root, port))
    managed = record.get("managed") if isinstance(record.get("managed"), dict) else {}
    for name in MANAGED_FILES:
        file = home / name
        if not file.is_file() or managed.get(name) != digest(file):
            problems.append("托管组件未通过完整性检查：" + name)
    skills = record.get("skills") if isinstance(record.get("skills"), dict) else {}
    if not skills:
        problems.append("缺少技能完整性记录")
    for relative, expected in skills.items():
        file = (home / relative).resolve()
        if not file.is_relative_to((home / "skills").resolve()) or not file.is_file() or digest(file) != expected:
            problems.append("技能文件缺失或已修改：" + relative)
    for skill in SKILLS:
        if not (home / "skills" / skill / "SKILL.md").is_file():
            problems.append("缺少技能：" + skill)
    soul = home / "SOUL.md"
    if not soul.is_file() or not soul.read_text(encoding="utf-8").strip():
        problems.append("缺少 Nora SOUL")
    agents = home / "AGENTS.md"
    if not agents.is_file() or not agents.read_text(encoding="utf-8").strip():
        problems.append("缺少 Nora AGENTS 指令")
    try:
        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
        mcp = config["mcp_servers"]["nora"]
        env = mcp["env"]
        if env.get("NORA_MCP_BASE_URL") != f"http://127.0.0.1:{port}" or Path(env.get("NORA_MCP_STATE_ROOT", "")).resolve() != (root / "tavern-state").resolve():
            problems.append("MCP 未绑定当前酒馆实例")
        if mcp.get("args") != [str(root / "apps/nora-mcp/dist/server.js")] or not Path(mcp["command"]).is_file():
            problems.append("MCP 启动配置无效")
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError):
        problems.append("MCP 配置缺失或无效")
    for name in ("apps/nora-mcp/dist/server.js", "apps/tavern-runtime/native_lifecycle.py", "apps/tavern-runtime/story_profile_runtime/manifest.json"):
        if not (root / name).is_file():
            problems.append("缺少系统组件：" + name)
    if record.get("commit") != receipt.get("commit"):
        problems.append("系统版本与初始化记录不一致")
    runtime = read_json(home / "hermes-agent/.hermes-bootstrap-complete")
    components = read_json(home / "nora-components.json")
    if not runtime.get("sha256") or not components.get("files"):
        problems.append("缺少完整 Hermes / ClawChat 运行环境记录")
    component_files = components.get("files") if isinstance(components.get("files"), dict) else {}
    if not component_files:
        problems.append("运行组件清单无效")
    for relative in component_files:
        file = (home / relative).resolve()
        if not file.is_relative_to(home.resolve()) or not file.is_file():
            problems.append("运行组件缺失或越界：" + relative)
    venv = home / "hermes-agent/venv"
    if not any((venv / relative).is_file() for relative in ("bin/python3", "Scripts/python.exe")):
        problems.append("Hermes Python 运行环境缺失")
    return {"ready": not problems, "problems": problems, "version": receipt.get("version"),
            "setupCompleted": bool(record.get("setupCompleted")) and not problems}


def verify_runtime(home, root, port, python, env):
    """Exercise Hermes loaders and a read-only MCP request, never a model call."""
    import yaml
    problems = managed_problems(home, root, port)
    if problems:
        raise RuntimeError("；".join(problems))
    result = subprocess.run([python, "-B", str(home / "scripts/nora-instance.py"), "check"],
                            cwd=home, env=env, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Nora 跨平台实例入口检查失败")
    result = subprocess.run([python, "-B", str(home / "nora-clawchat-check.py")],
                            cwd=home, env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("ClawChat 插件、工具或 Liveware 运行环境检查失败")
    prompt_probe = '''
from pathlib import Path
from agent.prompt_builder import load_soul_md, build_context_files_prompt, build_skills_system_prompt
home = Path.cwd()
soul = home.joinpath("SOUL.md").read_text().strip()
assert soul and soul in (load_soul_md(home_override=home) or ""), "SOUL not loaded"
context = build_context_files_prompt(cwd=str(home), home_override=home)
agents = home.joinpath("AGENTS.md").read_text(encoding="utf-8").strip()
assert agents and agents in context, "Complete AGENTS not loaded"
skills = build_skills_system_prompt(skills_dir_override=home / "skills")
assert all(name in skills for name in ("tavern", "tavern-ops", "nora-cardforge", "tavern-updater", "model-provider-config")), "skills not loaded"
external = build_skills_system_prompt(skills_dir_override=home / "clawchat-skills")
assert all(name in external for name in ("clawchat-core", "clawchat-liveware", "clawchat-set-greeting")), "ClawChat skills not loaded"
from unittest.mock import patch
from gateway.hooks import _load_hook_dir
loaded = _load_hook_dir(home / "hooks/tavern-liveware-register")
assert loaded and "gateway:startup" in loaded[1], "Hook not loaded by Hermes"
handle = loaded[2]
with patch.object(handle.__globals__["subprocess"], "Popen") as spawn:
    handle("gateway:startup", {})
    command = spawn.call_args.args[0]
    assert command[1:] == ["-B", str(home / "scripts/nora-instance.py"), "recover-existing"], "Hook runner mismatch"
'''
    result = subprocess.run([python, "-B", "-c", prompt_probe], cwd=home, env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Hermes 未能加载完整 Nora 身份、指令或技能；初始化未完成。")
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    mcp = config["mcp_servers"]["nora"]
    if mcp["env"].get("NORA_MCP_BASE_URL") != f"http://127.0.0.1:{port}":
        raise RuntimeError("MCP 端口与当前酒馆不一致")
    probe = '''
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const config = JSON.parse(process.argv[1]);
const client = new Client({ name: 'nora-install-check', version: '1.0.0' });
const transport = new StdioClientTransport({ ...config, env: { ...process.env, ...config.env }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'nora.world.list')) throw new Error('missing world tool');
  const result = await client.callTool({ name: 'nora.world.list', arguments: {} });
  if (result.isError) throw new Error('instance read failed');
} finally { await client.close(); }
'''
    result = subprocess.run([mcp["command"], "--input-type=module", "-e", probe, json.dumps({
        "command": mcp["command"], "args": mcp["args"], "env": mcp["env"]})],
        cwd=root / "apps/nora-mcp", env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Nora MCP 未能读取当前酒馆实例；初始化未完成。")
    return {name: True for name in PROOFS}


def record_initialization(home, root, manifest, proof):
    save_json(root / "tavern-updates/nora-system.json", {
        "schema": 1, "version": manifest.get("versions", {}).get("tavern"), "commit": manifest.get("commit"),
        "skills": inventory(home), "soulSha256": digest(home / "SOUL.md"), "proof": proof,
        "managed": {name: digest(home / name) for name in MANAGED_FILES},
        "setupCompleted": False,
    })


def mark_setup_complete(root):
    file = root / "tavern-updates/nora-system.json"
    record = read_json(file)
    proof = record.get("proof") if isinstance(record.get("proof"), dict) else {}
    if record.get("schema") != 1 or not all(proof.get(name) for name in PROOFS):
        raise RuntimeError("Nora 初始化未通过验证")
    save_json(file, {**record, "setupCompleted": True})
