import type { ChatMessage, LlmPort } from './types';

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** API가 response_format: json_object 를 지원하면 켠다. */
  jsonMode: boolean;
  /** 제한 시간 배율. CPU로 도는 로컬 모델처럼 느린 환경에서 올린다. */
  timeoutScale: number;
  /** 도구와 인자가 스킬에 적힌 단계는 모델을 부르지 않고 바로 실행한다. */
  skillDirect: boolean;
  /** 모델이 정한 동작으로 성공한 경로를 저장해 두고 다음 실행에서 모델 없이 다시 쓴다. */
  pathCache: boolean;
  /** 공유 스킬 저장소의 목록 파일(index.json) 주소. 비어 있으면 확장에 든 스킬만 쓴다. */
  skillsUrl: string;
  /**
   * 요청 헤더의 틀. 주면 Authorization 대신 이 헤더들을 보낸다. 값의 자리표시자는 부를 때마다 채운다.
   * {key} API 키, {userId} 사용자 ID, {userType} 사용자 유형, {uuid} 요청마다 새로 만든 UUID.
   * 배포 빌드(.env.local의 WXT_LLM_HEADERS)에서만 들어오고 브라우저 저장소에는 남기지 않는다.
   */
  headers?: Record<string, string>;
  /** 헤더 틀의 {userId}. 사내 게이트웨이가 요청한 사람을 구분할 때 쓰는 ID (예: SSO ID) */
  userId?: string;
  /** 헤더 틀의 {userType} */
  userType?: string;
}

const PLACEHOLDER = /\{(key|userId|userType|uuid)\}/g;
const PLACEHOLDER_LABEL = { key: 'API 키', userId: '사용자 ID', userType: '사용자 유형' } as const;

/** 헤더 틀이 쓰는 자리표시자. 설정 화면에서 어떤 칸을 보여 줄지 정한다. */
export function headerPlaceholders(headers: Record<string, string> | undefined): Set<string> {
  const used = new Set<string>();
  for (const value of Object.values(headers ?? {})) for (const m of value.matchAll(PLACEHOLDER)) used.add(m[1]);
  return used;
}

/**
 * 모델 API에 보낼 헤더. 헤더 틀이 없으면 OpenAI 방식(Authorization: Bearer 키)이다.
 * 틀에 쓴 값이 비어 있으면 요청하지 않고 무엇을 채워야 하는지 알린다.
 */
export function buildHeaders(settings: LlmSettings, uuid: () => string = () => crypto.randomUUID()): Record<string, string> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!settings.headers) return settings.apiKey ? { ...base, Authorization: `Bearer ${settings.apiKey}` } : base;
  const missing = new Set<string>();
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(settings.headers)) {
    const value = template.replace(PLACEHOLDER, (_, k: 'key' | 'userId' | 'userType' | 'uuid') => {
      if (k === 'uuid') return uuid();
      const v = k === 'key' ? settings.apiKey : k === 'userId' ? settings.userId : settings.userType;
      if (!v) missing.add(PLACEHOLDER_LABEL[k]);
      return v ?? '';
    });
    // 헤더에는 한글 같은 글자를 넣을 수 없다 (fetch가 거절한다).
    if (/[^\x20-\x7e]/.test(value)) throw new Error(`모델 API 헤더 ${name}의 값에 영문·숫자·기호가 아닌 글자가 있습니다`);
    out[name] = value;
  }
  if (missing.size > 0) {
    throw new Error(`모델 API 헤더에 필요한 값이 비어 있습니다: ${[...missing].join(', ')}. 패널 → 설정에서 입력하세요`);
  }
  // 틀에 Content-Type이 있으면 그것을 쓴다 (대소문자만 다른 헤더를 둘 보내지 않는다).
  const named = new Set(Object.keys(out).map((n) => n.toLowerCase()));
  for (const [n, v] of Object.entries(base)) if (!named.has(n.toLowerCase())) out[n] = v;
  return out;
}

const CALL_TIMEOUT_MS = 60_000;

/** OpenAI 호환 /chat/completions 엔드포인트용 클라이언트. */
export class OpenAiCompatClient implements LlmPort {
  constructor(
    private settings: LlmSettings,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    /** 답의 최대 길이. 동작 하나를 정할 때는 짧아도 되고, 스킬을 다듬을 때는 길게 준다. */
    private maxTokens = 1024,
  ) {}

  async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const { baseUrl, model, jsonMode } = this.settings;
    const headers = buildHeaders(this.settings);
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS * Math.max(1, this.settings.timeoutScale || 1));
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: this.maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((e: unknown) => {
      // 중지·시간 초과는 그대로 올리고, 네트워크에 닿지 못한 것만 원인을 짚어 준다.
      if (!(e instanceof TypeError)) throw e;
      throw new Error(
        `모델 API에 닿지 못했습니다 (${url}): ${e.message}. 주소가 맞는지, 그 호스트를 넣어 다시 빌드했는지, 사내망·프록시에서 열리는지 확인하세요`,
      );
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`모델 API 오류 ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('모델 API 응답에 choices[0].message.content가 없습니다');
    return content;
  }
}
