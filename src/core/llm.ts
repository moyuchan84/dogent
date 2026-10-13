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
}

const CALL_TIMEOUT_MS = 60_000;

/** OpenAI 호환 /chat/completions 엔드포인트용 클라이언트. */
export class OpenAiCompatClient implements LlmPort {
  constructor(
    private settings: LlmSettings,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const { baseUrl, apiKey, model, jsonMode } = this.settings;
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS * Math.max(1, this.settings.timeoutScale || 1));
    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 1024,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
