#!/usr/bin/env python3
"""Parse authored HTML and ask Node to check JS syntax only; never run card code."""
import json
import os
import re
import subprocess
import sys
from html.parser import HTMLParser


class Scripts(HTMLParser):
    # HTMLParser only treats script/style as raw text by default.
    CDATA_CONTENT_ELEMENTS = ("script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.snippets = []
        self.script = None

    def handle_starttag(self, tag, attrs):
        # HTML uses the first duplicate attribute, not the last.
        attributes = {}
        for name, value in attrs:
            attributes.setdefault(name, value or "")
        line = self.getpos()[0]
        for name, value in attributes.items():
            if name.startswith("on"):
                self.snippets.append((f"{tag}.{name} line {line}", "commonjs",
                                      "function handler(event) {\n" + value + "\n}"))
        if tag != "script":
            return
        kind = attributes.get("type", "").strip().lower()
        language = attributes.get("language", "").strip().lower()
        if not kind and language:
            kind = "text/" + language
        js_mimes = {"", "module", "text/javascript", "application/javascript", "text/ecmascript",
                    "application/ecmascript", "text/jscript", "text/livescript",
                    "application/x-javascript", "application/x-ecmascript", "text/x-javascript", "text/x-ecmascript"}
        is_js = kind in js_mimes or bool(re.fullmatch(r"text/javascript1\.[0-5]", kind))
        self.script = {"label": f"script line {line}", "mode": "module" if kind == "module" else "commonjs",
                       "check": is_js and "src" not in attributes, "body": []}

    def handle_startendtag(self, tag, attrs):
        # In HTML a slash does not close a script element.
        if tag == "script":
            self.handle_starttag(tag, attrs)
            self.set_cdata_mode(tag)
        else:
            super().handle_startendtag(tag, attrs)

    def handle_data(self, data):
        if self.script is not None:
            self.script["body"].append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.script is not None:
            script = self.script
            if script["check"]:
                self.snippets.append((script["label"], script["mode"], "".join(script["body"])))
            self.script = None


def check(html, node):
    parser = Scripts()
    parser.feed(html)
    parser.close()
    issues = []
    if parser.script is not None:
        issues.append({"severity": "error", "title": f"脚本未闭合：{parser.script['label']}"})
    if len(parser.snippets) > 128:
        return {"checked": 0, "issues": [{"severity": "error", "title": "脚本检查数量超过 128 个上限"}]}
    env = {key: value for key, value in os.environ.items() if key != "NODE_OPTIONS"}
    checked = 0
    for label, mode, source in parser.snippets:
        # Classic browser scripts are not CommonJS modules (top-level return is
        # illegal). vm.Script compiles only; module --check does not link imports.
        command = [node, "--check", "--input-type=module"] if mode == "module" else [
            node, "-e", 'new (require("node:vm").Script)(require("node:fs").readFileSync(0,"utf8"))']
        result = subprocess.run(command, input=source,
                                encoding="utf-8", capture_output=True, timeout=5, env=env)
        checked += 1
        if result.returncode:
            message = next((line for line in result.stderr.splitlines() if "SyntaxError:" in line),
                           "Node syntax check failed")
            issues.append({"severity": "error", "title": f"脚本语法错误（{label}）：{message[:300]}"})
    return {"checked": checked, "issues": issues}


if __name__ == "__main__":
    try:
        print(json.dumps(check(sys.stdin.read(), sys.argv[1]), ensure_ascii=False))
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"checked": 0, "issues": [{"severity": "error", "title": f"脚本语法检查不可用：{error}"}]}, ensure_ascii=False))
        sys.exit(2)
