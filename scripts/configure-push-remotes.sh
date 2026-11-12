#!/usr/bin/env bash
# Explicit, idempotent local Git configuration; no credentials and no push.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
github=https://github.com/Tianyi822/Elysian.git
gitee=https://gitee.com/Chentyit/Elysian.git
[ "$(git remote get-url origin)" = "$github" ] || { echo 'origin 拉取地址不是预期 GitHub 仓库，保留原配置' >&2; exit 1; }
while IFS= read -r address; do
  [ "$address" = "$github" ] || [ "$address" = "$gitee" ] || { echo '存在其他推送地址，保留原配置' >&2; exit 1; }
done < <(git remote get-url --push --all origin)
if git remote get-url gitee >/dev/null 2>&1; then
  [ "$(git remote get-url gitee)" = "$gitee" ] || { echo 'gitee remote 已被其他仓库占用' >&2; exit 1; }
  while IFS= read -r address; do
    [ "$address" = "$gitee" ] || { echo 'gitee remote 存在其他推送地址，保留原配置' >&2; exit 1; }
  done < <(git remote get-url --push --all gitee)
else
  git remote add gitee "$gitee"
fi
git config --local --replace-all remote.origin.pushurl "$github"
git config --local --add remote.origin.pushurl "$gitee"
echo 'origin 从 GitHub 拉取，每次 push 向 GitHub、Gitee 推送；gitee remote 可用于单站补推。'
git remote -v
