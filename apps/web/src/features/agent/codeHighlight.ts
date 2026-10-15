import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { Root } from 'hast'

const highlighter = createLowlight({ bash, c, cpp, css, diff, dockerfile, go, ini, java, javascript, json, markdown, nginx, powershell, python, rust, shell, sql, typescript, xml, yaml })
const encoder = new TextEncoder()
const MAX_HIGHLIGHT_BYTES = 64 * 1024

const languageLabels: Readonly<Record<string, string>> = {
  bash: 'Bash', sh: 'Bash', zsh: 'Bash',
  c: 'C', cpp: 'C++', 'c++': 'C++',
  css: 'CSS', diff: 'Diff', patch: 'Diff',
  dockerfile: 'Dockerfile', docker: 'Dockerfile',
  go: 'Go', golang: 'Go', ini: 'INI', toml: 'TOML',
  java: 'Java', javascript: 'JavaScript', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', markdown: 'Markdown', md: 'Markdown',
  nginx: 'Nginx', nginxconf: 'Nginx', powershell: 'PowerShell', ps1: 'PowerShell',
  python: 'Python', py: 'Python', rust: 'Rust', rs: 'Rust',
  shell: 'Shell', console: 'Shell', shellsession: 'Shell', sql: 'SQL',
  typescript: 'TypeScript', ts: 'TypeScript', tsx: 'TSX',
  xml: 'XML', html: 'HTML', xhtml: 'HTML', yaml: 'YAML', yml: 'YAML',
  text: '纯文本', txt: '纯文本', plaintext: '纯文本',
}

export function codeLanguageLabel(language: string): string {
  return Object.hasOwn(languageLabels, language) ? languageLabels[language]! : language || '纯文本'
}

/** 限制单次流式更新的着色工作量，未知语言和异常均保留完整原文。 */
export function highlightCode(value: string, language: string): Root | null {
  if (!language || value.length > MAX_HIGHLIGHT_BYTES || !highlighter.registered(language)) return null
  if (encoder.encode(value).byteLength > MAX_HIGHLIGHT_BYTES) return null
  try {
    return highlighter.highlight(language, value)
  } catch {
    return null
  }
}
