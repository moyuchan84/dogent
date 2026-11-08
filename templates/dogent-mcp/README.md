# dogent-mcp — 사내 MCP 서버 템플릿

Dogent(와 Claude Code, opencode)가 부를 사내 도구를 **파일 하나(`server.mjs`)**로 만드는 출발점입니다. 의존 패키지가 없고 Node 20만 있으면 됩니다.

## 5분 순서

1. 이 폴더를 복사해 새 저장소(또는 `mcp-<이름>/`)를 만듭니다.
2. `server.mjs`의 `TOOLS`에서 예시를 지우고 내 도구를 씁니다. 도구 하나 = `name`, `description`, `inputSchema`, `readOnly`, `handler`.
   - `readOnly: true`(읽기만 함)는 Dogent가 바로 부르고, `false`(바꿈)는 부르기 전에 사람에게 묻습니다.
   - `description`을 **무엇을 언제 쓰는지** 구체적으로 쓰세요. 사내 모델은 이 글로 도구를 고릅니다.
3. 내 PC에서 시험:
   ```
   dogent mcp add my-mcp -- node D:\path\to\server.mjs
   dogent mcp test my-mcp          # 도구 목록이 보이면 연결 성공
   dogent "my-mcp로 7라인 Lot 목록 보여줘"
   ```
4. 서버에 올려 여럿이 쓰려면 HTTP로 띄웁니다.
   ```
   MCP_TOKEN=<토큰> node server.mjs --http 8800        # http://호스트:8800/mcp
   docker build -t my-mcp . && docker run -p 8800:8800 -e MCP_TOKEN=<토큰> my-mcp
   ```
   앞단에 사내 HTTPS를 두세요. 토큰(`MCP_TOKEN`)은 코드가 아니라 환경 변수·Secret으로 넣습니다.
5. 카탈로그에 올려 모두가 설치하게 합니다. `server.json`을 고쳐서 팀 스킬 저장소(`dogent-skills`)의 `mcp/<id>/server.json`으로 넣고 `node tools/mcp-index.mjs mcp` 후 PR을 올립니다. 그러면 사용자는 `dogent mcp install <id>` 한 줄이면 됩니다.

## 지킬 것

- 바꾸는 도구(저장, 상신, 삭제, 홀드)는 `readOnly: false`로 두고, `server.json`의 `permissions`에서도 `ask`로 둡니다.
- 도구 안에서 입력값을 다시 검증하세요 (모델이 만든 값입니다). 위험한 일은 서버 쪽 권한 검사를 따로 합니다.
- 응답에 개인정보·비밀을 필요 이상으로 싣지 마세요. 모델과 로그에 남습니다.
- 토큰을 `server.json`이나 코드에 적지 않습니다 (카탈로그 검사기가 막습니다).
