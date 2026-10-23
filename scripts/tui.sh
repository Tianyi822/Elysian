#!/usr/bin/env bash
# scripts/tui.sh —— install.sh / uninstall.sh 共用的终端渲染层（source 使用，无副作用）。
# 只负责颜色判定、显示宽度、阶段进度、摘要排版与状态标记；不执行任何安装或清理动作。

TUI_KV_WIDTH="${TUI_KV_WIDTH:-12}"

init_output() { # init_output <stdout 是否 TTY 0|1> <stderr 是否 TTY 0|1>
  local out_tty="$1" err_tty="$2" cols
  if [ "$out_tty" = 1 ] && [ "$err_tty" = 1 ] && [ "${TERM:-dumb}" != dumb ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
    C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'; C_GRAY=$'\033[90m'
  else
    C_RESET=''; C_BOLD=''; C_GREEN=''; C_RED=''; C_CYAN=''; C_YELLOW=''; C_GRAY=''
  fi
  if [ "$out_tty" = 1 ] && [ "$err_tty" = 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    TUI_LIVE=1
  else
    TUI_LIVE=0
  fi
  SPINNER_ENABLED="$TUI_LIVE"
  cols="$(tput cols 2>/dev/null || true)"
  case "$cols" in ''|*[!0-9]*) cols="$(stty size 2>/dev/null | awk '{print $2}' || true)" ;; esac
  case "$cols" in ''|*[!0-9]*) cols="${COLUMNS:-72}" ;; esac
  case "$cols" in ''|*[!0-9]*) cols=72 ;; esac
  [ "$cols" -ge 20 ] || cols=72
  TERM_COLS="$cols"
}

info() { printf '    %s→%s %s\n' "${C_CYAN:-}" "${C_RESET:-}" "$*"; }
ok()   { printf '    %s✓%s %s\n' "${C_GREEN:-}" "${C_RESET:-}" "$*"; }
skip() { printf '    %s−%s %s\n' "${C_GRAY:-}" "${C_RESET:-}" "$*"; }
warn() { printf '    %s!%s %s\n' "${C_YELLOW:-}" "${C_RESET:-}" "$*"; }
die()  { printf '\n  %s✗ %s：%s%s\n' "${C_RED:-}" "${TUI_FAIL_LABEL:-操作失败}" "$*" "${C_RESET:-}" >&2; exit 1; }

tui_wide_cp() { # <Unicode 码点>：东亚宽字符返回 0
  local cp="$1"
  [ "$cp" -ge 4352 ] || return 1
  [ "$cp" -le 4447 ] && return 0
  [ "$cp" -ge 11904 ] && [ "$cp" -le 42191 ] && return 0
  [ "$cp" -ge 44032 ] && [ "$cp" -le 55203 ] && return 0
  [ "$cp" -ge 63744 ] && [ "$cp" -le 64255 ] && return 0
  [ "$cp" -ge 65072 ] && [ "$cp" -le 65087 ] && return 0
  [ "$cp" -ge 65280 ] && [ "$cp" -le 65376 ] && return 0
  [ "$cp" -ge 65504 ] && [ "$cp" -le 65510 ] && return 0
  return 1
}

tui_width() { # <文本>：按终端显示列计数；不能依赖 ${#s}（locale 会改变语义）
  local text="$1" out width=0 i=0 n=0 b cp
  if command -v od >/dev/null 2>&1; then
    out="$(LC_ALL=C printf '%s' "$text" | od -An -tu1 -v 2>/dev/null | tr -s ' \n' ' ')"
    local -a bytes
    bytes=($out)
    n=${#bytes[@]}
    while [ "$i" -lt "$n" ]; do
      b=${bytes[$i]}
      if [ "$b" -lt 128 ]; then
        width=$((width + 1)); i=$((i + 1))
      elif [ $((b & 224)) -eq 192 ]; then
        width=$((width + 1)); i=$((i + 2))
      elif [ $((b & 240)) -eq 224 ]; then
        if [ $((i + 2)) -lt "$n" ]; then
          cp=$(( ((b & 15) << 12) | ((${bytes[$((i + 1))]} & 63) << 6) | (${bytes[$((i + 2))]} & 63) ))
          if tui_wide_cp "$cp"; then width=$((width + 2)); else width=$((width + 1)); fi
        else
          width=$((width + 1))
        fi
        i=$((i + 3))
      else
        width=$((width + 2)); i=$((i + 4))
      fi
    done
  else
    width="$(printf '%s' "$text" | LC_ALL=C wc -c | tr -d '[:space:]')"
    case "$width" in ''|*[!0-9]*) width=0 ;; esac
  fi
  printf '%s' "$width"
}

tui_pad() { # <文本> <目标显示宽度>
  local text="$1" target="$2" width pad
  width="$(tui_width "$text")"
  pad=$((target - width))
  [ "$pad" -ge 0 ] || pad=0
  printf '%s%*s' "$text" "$pad" ''
}

tui_kv() { # <键> <值...>
  local label="$1" pad
  shift
  pad=$((TUI_KV_WIDTH - $(tui_width "$label")))
  [ "$pad" -ge 1 ] || pad=1
  printf '  %s%s%s%*s%s\n' "${C_BOLD:-}" "$label" "${C_RESET:-}" "$pad" '' "$*"
}

tui_rule() { # <字符> [宽度]
  local char="$1" width="${2:-${TERM_COLS:-72}}" line='' i=0
  [ "$width" -gt 100 ] && width=100
  [ "$width" -ge 0 ] || width=0
  while [ "$i" -lt "$width" ]; do line+="$char"; i=$((i + 1)); done
  printf '%s' "$line"
}

tui_stage() { # <当前> <总数> <名称>
  local current="$1" total="$2" name="$3" bar_width filled empty filled_bar empty_bar
  if [ "${TUI_LIVE:-0}" = 1 ] && [ "$total" -gt 0 ] && [ "${TERM_COLS:-72}" -ge 48 ]; then
    bar_width=20
    [ "${TERM_COLS:-72}" -lt 64 ] && bar_width=12
    filled=$((current * bar_width / total))
    empty=$((bar_width - filled))
    filled_bar="$(tui_rule '█' "$filled")"
    empty_bar="$(tui_rule '░' "$empty")"
    printf '\n%s[%2d/%d]%s %s%s%s%s%s %s%s%s\n' \
      "${C_CYAN:-}" "$current" "$total" "${C_RESET:-}" \
      "${C_GREEN:-}" "$filled_bar" "${C_RESET:-}" \
      "${C_GRAY:-}" "$empty_bar" "${C_RESET:-}${C_BOLD:-}" "$name" "${C_RESET:-}"
    return 0
  fi
  printf '\n[%2d/%d] %s\n' "$current" "$total" "$name"
}

tui_section() { # <标题>
  local title="$1" width="${TERM_COLS:-72}" used remain
  [ "$width" -gt 100 ] && width=100
  used=$((2 + 3 + $(tui_width "$title") + 1))
  remain=$((width - used))
  [ "$remain" -ge 3 ] || remain=3
  printf '\n  %s── %s %s%s\n' "${C_BOLD:-}" "$title" "$(tui_rule '─' "$remain")" "${C_RESET:-}"
}

tui_banner() { # <标题> [副标题]
  local title="$1" subtitle="${2:-}" rule_width
  rule_width=$(( ${TERM_COLS:-72} - 2 ))
  [ "$rule_width" -ge 1 ] || rule_width=1
  printf '\n  %s%s%s\n' "${C_BOLD:-}" "$(tui_rule '━' "$rule_width")" "${C_RESET:-}"
  printf '  %s%s%s\n' "${C_BOLD:-}" "$title" "${C_RESET:-}"
  [ -z "$subtitle" ] || printf '  %s\n' "$subtitle"
  printf '  %s%s%s\n' "${C_BOLD:-}" "$(tui_rule '━' "$rule_width")" "${C_RESET:-}"
}

tui_duration() { # <秒数>
  local seconds="${1:-0}"
  case "$seconds" in ''|*[!0-9]*) seconds=0 ;; esac
  if [ "$seconds" -ge 60 ]; then
    printf '%dm%02ds' $((seconds / 60)) $((seconds % 60))
  else
    printf '%ds' "$seconds"
  fi
}

tui_footer() { # <秒数>
  printf '    %s└ 用时 %s%s\n' "${C_GRAY:-}" "$(tui_duration "${1:-0}")" "${C_RESET:-}"
}

tui_begin_stage() {
  STAGE_STARTED_AT=$SECONDS
  STAGE_FINISHED=0
}

tui_finish_stage() {
  [ -n "${STAGE_STARTED_AT:-}" ] || return 0
  [ "${STAGE_FINISHED:-0}" = 1 ] && return 0
  tui_footer "$((SECONDS - STAGE_STARTED_AT))"
  STAGE_FINISHED=1
}

clear_progress_line() {
  if [ "${TUI_LIVE:-0}" = 1 ]; then
    printf '\r%*s\r' "${TERM_COLS:-72}" ''
  fi
}
