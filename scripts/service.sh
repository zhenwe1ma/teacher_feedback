#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"
WEB_PID_FILE="$RUN_DIR/web.pid"
OLLAMA_PID_FILE="$RUN_DIR/ollama.pid"
WEB_LOG_FILE="$LOG_DIR/web.log"
OLLAMA_LOG_FILE="$LOG_DIR/ollama.log"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

load_env_file() {
  local env_file="$ROOT_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    return
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="$(trim "$line")"
    if [[ -z "$line" || "$line" == \#* || "$line" != *=* ]]; then
      continue
    fi
    local key="${line%%=*}"
    local value="${line#*=}"
    key="$(trim "$key")"
    value="$(trim "$value")"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -n "$key" && -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

read_pid() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi
  tr -d "[:space:]" < "$pid_file"
}

is_pid_running() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

cleanup_stale_pid() {
  local pid_file="$1"
  local pid
  pid="$(read_pid "$pid_file")"
  if [[ -n "$pid" ]] && ! is_pid_running "$pid"; then
    rm -f "$pid_file"
  fi
}

listener_pid_by_port() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

wait_for_port() {
  local port="$1"
  local seconds="${2:-15}"
  local index
  for ((index = 0; index < seconds; index += 1)); do
    if [[ -n "$(listener_pid_by_port "$port")" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

display_host() {
  if [[ "$HOST" == "0.0.0.0" ]]; then
    printf "127.0.0.1"
    return
  fi
  printf "%s" "$HOST"
}

extract_host_port() {
  local url="$1"
  url="${url#http://}"
  url="${url#https://}"
  printf "%s" "${url%%/*}"
}

extract_port() {
  local host_port="$1"
  if [[ "$host_port" == *:* ]]; then
    printf "%s" "${host_port##*:}"
    return
  fi
  printf "80"
}

needs_local_llm() {
  [[ "${AI_PROVIDER,,}" == "local" || "${DEFAULT_FEEDBACK_GENERATOR,,}" == "local_llm" ]]
}

uses_project_ollama() {
  [[ "$LOCAL_LLM_BASE_URL" =~ ^https?://(127\.0\.0\.1|localhost|0\.0\.0\.0):11434(/|$) ]]
}

start_ollama_if_needed() {
  if ! needs_local_llm; then
    return
  fi
  if ! uses_project_ollama; then
    echo "检测到本地 LLM 地址不是项目内 Ollama，跳过本地 LLM 启动。"
    return
  fi

  cleanup_stale_pid "$OLLAMA_PID_FILE"

  local host_port
  host_port="$(extract_host_port "$LOCAL_LLM_BASE_URL")"
  local llm_port
  llm_port="$(extract_port "$host_port")"
  local listener_pid
  listener_pid="$(listener_pid_by_port "$llm_port")"
  if [[ -n "$listener_pid" ]]; then
    echo "检测到本地 LLM 已在端口 $llm_port 运行，直接复用。PID=$listener_pid"
    return
  fi

  local ollama_bin="$ROOT_DIR/.local/ollama/bin/ollama"
  if [[ ! -x "$ollama_bin" ]]; then
    echo "未找到 $ollama_bin，无法自动启动本地 LLM。"
    exit 1
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR"
  OLLAMA_HOST="$host_port" OLLAMA_MODELS="$ROOT_DIR/.ollama/models" nohup setsid "$ollama_bin" serve >"$OLLAMA_LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$OLLAMA_PID_FILE"

  if ! wait_for_port "$llm_port" 15; then
    rm -f "$OLLAMA_PID_FILE"
    echo "本地 LLM 启动失败，请查看日志：$OLLAMA_LOG_FILE"
    tail -n 40 "$OLLAMA_LOG_FILE" || true
    exit 1
  fi
  echo "本地 LLM 已启动。PID=$pid 日志=$OLLAMA_LOG_FILE"
}

start_web() {
  cleanup_stale_pid "$WEB_PID_FILE"
  local existing_pid
  existing_pid="$(read_pid "$WEB_PID_FILE")"
  if [[ -n "$existing_pid" ]] && is_pid_running "$existing_pid"; then
    echo "Web 服务已在运行。PID=$existing_pid 地址=http://$(display_host):$PORT"
    return
  fi

  local listener_pid
  listener_pid="$(listener_pid_by_port "$PORT")"
  if [[ -n "$listener_pid" ]]; then
    echo "端口 $PORT 已被其他进程占用。PID=$listener_pid"
    exit 1
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR"
  (
    cd "$ROOT_DIR"
    nohup setsid node server.js >"$WEB_LOG_FILE" 2>&1 < /dev/null &
    echo "$!" > "$WEB_PID_FILE"
  )
  local pid
  pid="$(read_pid "$WEB_PID_FILE")"
  if ! wait_for_port "$PORT" 20; then
    rm -f "$WEB_PID_FILE"
    echo "Web 服务启动失败，请查看日志：$WEB_LOG_FILE"
    tail -n 60 "$WEB_LOG_FILE" || true
    exit 1
  fi
  echo "Web 服务已启动。PID=$pid 地址=http://$(display_host):$PORT"
  echo "日志路径：$WEB_LOG_FILE"
}

stop_pid_file() {
  local pid_file="$1"
  local label="$2"
  cleanup_stale_pid "$pid_file"
  local pid
  pid="$(read_pid "$pid_file")"
  if [[ -z "$pid" ]]; then
    echo "$label 未由脚本托管，无需关闭。"
    return
  fi
  if ! is_pid_running "$pid"; then
    rm -f "$pid_file"
    echo "$label 已停止。"
    return
  fi
  kill "$pid" 2>/dev/null || true
  local index
  for ((index = 0; index < 10; index += 1)); do
    if ! is_pid_running "$pid"; then
      rm -f "$pid_file"
      echo "$label 已关闭。"
      return
    fi
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pid_file"
  echo "$label 已强制关闭。"
}

show_status() {
  cleanup_stale_pid "$WEB_PID_FILE"
  cleanup_stale_pid "$OLLAMA_PID_FILE"

  local web_pid
  web_pid="$(read_pid "$WEB_PID_FILE")"
  if [[ -n "$web_pid" ]] && is_pid_running "$web_pid"; then
    echo "Web 服务: 运行中 PID=$web_pid 地址=http://$(display_host):$PORT"
  else
    local web_listener
    web_listener="$(listener_pid_by_port "$PORT")"
    if [[ -n "$web_listener" ]]; then
      echo "Web 服务: 端口 $PORT 已被外部进程占用 PID=$web_listener"
    else
      echo "Web 服务: 未运行"
    fi
  fi

  if needs_local_llm && uses_project_ollama; then
    local host_port
    host_port="$(extract_host_port "$LOCAL_LLM_BASE_URL")"
    local llm_port
    llm_port="$(extract_port "$host_port")"
    local ollama_pid
    ollama_pid="$(read_pid "$OLLAMA_PID_FILE")"
    if [[ -n "$ollama_pid" ]] && is_pid_running "$ollama_pid"; then
      echo "本地 LLM: 运行中 PID=$ollama_pid 地址=$LOCAL_LLM_BASE_URL"
      return
    fi
    local llm_listener
    llm_listener="$(listener_pid_by_port "$llm_port")"
    if [[ -n "$llm_listener" ]]; then
      echo "本地 LLM: 已运行但不是脚本托管 PID=$llm_listener 地址=$LOCAL_LLM_BASE_URL"
    else
      echo "本地 LLM: 未运行"
    fi
    return
  fi

  echo "本地 LLM: 当前配置不需要脚本托管"
}

usage() {
  cat <<EOF
用法：
  bash scripts/service.sh start
  bash scripts/service.sh stop
  bash scripts/service.sh restart
  bash scripts/service.sh status

说明：
  - start 会按当前 .env 启动 Web 服务
  - 当配置命中本机 Ollama 时，也会一并启动本地 LLM
  - stop 只会关闭当前脚本启动并托管的进程
EOF
}

main() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  load_env_file
  HOST="${HOST:-0.0.0.0}"
  PORT="${PORT:-5173}"
  AI_PROVIDER="${AI_PROVIDER:-mock}"
  DEFAULT_FEEDBACK_GENERATOR="${DEFAULT_FEEDBACK_GENERATOR:-local_llm}"
  LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-http://127.0.0.1:11434/v1}"

  local action="${1:-}"
  case "$action" in
    start)
      start_ollama_if_needed
      start_web
      ;;
    stop)
      stop_pid_file "$WEB_PID_FILE" "Web 服务"
      stop_pid_file "$OLLAMA_PID_FILE" "本地 LLM"
      ;;
    restart)
      stop_pid_file "$WEB_PID_FILE" "Web 服务"
      stop_pid_file "$OLLAMA_PID_FILE" "本地 LLM"
      start_ollama_if_needed
      start_web
      ;;
    status)
      show_status
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
