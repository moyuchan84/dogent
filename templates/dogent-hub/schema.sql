-- Dogent Hub의 PostgreSQL 스키마 (문서용 — 아직 구현은 없다. docs/20 7-1).
-- 지금 서버(tools/hub.mjs)는 파일 저장소(state.json, runs.jsonl, audit.jsonl)를 쓴다.
-- DB로 옮길 때는 tools/hub-core.ts 의 Store 인터페이스를 이 테이블에 맞춰 구현한다.
--
-- 원칙: 개인정보·업무 데이터를 저장하지 않는다. runs에는 표의 값, 화면 글자, 입력값, 요청 문장을 넣을 칸이 없다.

CREATE TABLE users (
  id           text PRIMARY KEY,            -- SSO ID (지금은 클라이언트가 보낸 userId)
  department   text,
  last_seen_at timestamptz,
  client_version text,
  status       text NOT NULL DEFAULT 'active'
);

CREATE TABLE runs (
  run_id       text PRIMARY KEY,            -- 멱등 키: 같은 run_id는 한 번만 저장 (INSERT ... ON CONFLICT DO NOTHING)
  user_id      text NOT NULL,
  skill_id     text NOT NULL,
  skill_version text,
  risk         text NOT NULL CHECK (risk IN ('R1','R2','R3')),
  result       text NOT NULL CHECK (result IN ('ok','fail','aborted','blocked')),
  started_at   timestamptz NOT NULL,
  duration_ms  integer,
  model_calls  integer,
  error_class  text,                        -- 짧은 분류어 (timeout, login, llm, browser, office, killswitch, expired, other …)
  approved     boolean,                     -- 승인했다/안 했다만 남긴다
  client_version text
);
CREATE INDEX runs_skill_started ON runs (skill_id, started_at DESC);
CREATE INDEX runs_started ON runs (started_at);

-- 일 단위 집계. 화면 변경으로 깨진 스킬을 찾는다 (runs를 매일 집계하는 작업이 채운다)
CREATE TABLE skill_stats (
  skill_id     text NOT NULL,
  day          date NOT NULL,
  runs         integer NOT NULL,
  ok           integer NOT NULL,
  avg_duration_ms integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY (skill_id, day)
);

CREATE TABLE policies (
  version      integer PRIMARY KEY,
  body         jsonb NOT NULL,              -- { ttlSec, notice, ... }
  ttl_sec      integer NOT NULL,
  author       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kill_switches (
  id           text PRIMARY KEY,
  scope        text NOT NULL CHECK (scope IN ('skill','system','all')),
  target       text NOT NULL,               -- 스킬 id, 시스템 id, 전체면 '*'
  reason       text NOT NULL,
  author       text,
  since        timestamptz NOT NULL DEFAULT now(),
  cleared_at   timestamptz                  -- NULL이면 지금 걸려 있음
);

CREATE TABLE issue_reports (
  id           bigserial PRIMARY KEY,
  system_id    text NOT NULL,
  body         text NOT NULL,
  reporter     text,
  status       text NOT NULL DEFAULT 'open',
  handler      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 관리 행위 감사. 앱 계정에는 INSERT/SELECT만 주고 UPDATE/DELETE 권한은 주지 않는다 (삭제 불가).
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  action       text NOT NULL,               -- policy.update, killswitch.set, killswitch.clear …
  detail       jsonb NOT NULL DEFAULT '{}'
);
