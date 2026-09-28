#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for APP in "$DIR/诺拉·酒馆.app" "$DIR/desktop/dist/mac-arm64/诺拉·酒馆.app" "$DIR/desktop/dist/mac/诺拉·酒馆.app"; do
  if [ -d "$APP" ]; then
    exec open "$APP" --args "$@"
  fi
done
printf '%s\n' '此目录没有桌面启动器。请从项目 Releases 下载对应芯片的 macOS 启动器，打开“诺拉·酒馆.app”。'
exit 1
