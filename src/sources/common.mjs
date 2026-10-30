import { basename } from 'node:path';
import { mask, oneLine } from '../text.mjs';

export const MAX_EVENTS = 40;

export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function pushEvent(state, at, kind, text) {
  const t = mask(oneLine(text));
  if (!t) return;
  state.events.push({ at: at ? Date.parse(at) || Date.now() : Date.now(), kind, text: t });
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

const short = (p) => (p ? basename(String(p)) : '');

// 도구 호출을 "무엇을 하는지" 한 줄로 줄인다. Claude·Codex 도구 이름을 모두 다룬다.
// 도구 설명은 화면·--json 어디로 나가든 비밀값을 가린 뒤 한 줄로 만든다.
export function describeTool(name, input = {}) {
  return mask(oneLine(rawDescribeTool(name, input)));
}

function rawDescribeTool(name, input) {
  if (typeof input === 'string') {
    const file = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    return file ? `${name} ${short(file[1])}` : name;
  }
  switch (name) {
    case 'Bash':
    case 'exec_command':
    case 'shell':
      return `$ ${input.description ?? input.cmd ?? input.command ?? ''}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${name} ${short(input.file_path ?? input.notebook_path)}`;
    case 'Grep':
    case 'Glob':
      return `${name} ${input.pattern ?? ''}`;
    case 'WebFetch':
      return `WebFetch ${(input.url ?? '').replace(/^https?:\/\//, '').split('/')[0]}`;
    case 'WebSearch':
      return `WebSearch ${input.query ?? ''}`;
    case 'Agent':
    case 'Task':
      return `▸ ${input.subagent_type ?? 'agent'}: ${input.description ?? ''}`;
    case 'TodoWrite':
      return 'TodoWrite';
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? `${name} ${first}` : name;
    }
  }
}

export function isNoisePrompt(text) {
  return /^\s*(<|\[Request interrupted|Caveat:|This session is being continued from a previous conversation)/.test(text);
}
