# 18. 공용 시스템 사전 운영 가이드

사내 시스템(GSAMS, MES 등)의 이름·별칭·주소·화면·용어를 한 저장소에서 관리하고, Dogent·Claude Code·opencode가 같은 답을 쓰게 하는 방법입니다. 틀은 `templates/dogent-systems`에 있습니다.

## 1. 전체 그림

```
사내 GitHub 저장소 dogent-systems   ← 원본 (이것만 진짜)
  systems/<id>/SYSTEM.md
      │ PR → CI 검사 → 담당 부서 승인 → main
      ▼
시스템 MCP 서버 (사내 서버 1대, main을 몇 분마다 git pull)
      │ http://<서버>:8787/mcp
      ▼
Dogent 데스크탑 · 크롬 확장 · Claude Code · opencode   (읽기 + 신고만)
      │
      └─ 틀린 내용 → report_issue → 신고 파일 → 담당자가 PR로 수정
```

원칙: 클라이언트는 사전을 고치지 않는다. 고치는 길은 PR 하나뿐이다.

## 2. 역할

| 역할 | 하는 일 | 사내 GitHub 권한 |
|---|---|---|
| 사전 관리자 (1~2명) | 저장소·서버 운영, 도구 파일 갱신, 신고 확인 | Admin |
| 시스템 담당자 (부서별) | 자기 시스템의 SYSTEM.md 작성·승인 | Write + CODEOWNERS |
| 일반 사용자 | 사전을 쓰고, 틀리면 신고 | Read (서버가 대신 읽으므로 사실상 불필요) |

## 3. 사내 GitHub에 올리기 (처음 한 번)

사전 관리자가 한다. 사내 GitHub 주소를 `https://github.<사내도메인>`이라 가정한다.

### 3-1. 저장소 만들기

1. 사내 GitHub에서 새 저장소를 만든다. 이름은 `dogent-systems`, 공개 범위는 사내(Internal) 또는 비공개.
2. README나 .gitignore를 추가하지 않은 빈 저장소로 만든다.

### 3-2. 틀 올리기

Dogent 저장소의 `templates/dogent-systems` 폴더 **안의 내용**을 새 저장소의 루트로 올린다 (폴더 자체가 아니라 내용).

```powershell
# 1) 틀을 별도 폴더로 복사
Copy-Item -Recurse D:\code\samsung\dogent\templates\dogent-systems D:\code\dogent-systems
cd D:\code\dogent-systems

# 2) git 시작 후 사내 저장소로 올리기
git init -b main
git add .
git commit -m "공용 시스템 사전 처음 올림"
git remote add origin https://github.<사내도메인>/<조직>/dogent-systems.git
git push -u origin main
```

`.github` 폴더와 `.gitattributes`도 숨김 파일이라 빠지기 쉬우니, `git status`나 GitHub 화면에서 올라갔는지 확인한다.

### 3-3. 저장소 설정 (관리자)

Settings → Branches → main에 보호 규칙을 건다.

- Require a pull request before merging
- Require approvals: 1
- **Require review from Code Owners** (CODEOWNERS가 효과를 내는 스위치)
- Require status checks to pass → `systems` 워크플로 선택 (`.github/workflows/systems.yml`)

### 3-4. CODEOWNERS 고치기

`.github/CODEOWNERS`의 `@사전-관리자-팀`, `@GSAMS-담당-팀`을 사내 GitHub의 실제 팀·계정으로 바꾸고 시스템마다 한 줄씩 늘려 간다.

```
*                    @org/사전-관리자
/systems/gsams/      @org/gsams-담당
/systems/mes/        @org/mes-담당
/tools/              @org/사전-관리자
```

## 4. 시스템 하나 추가하기 (담당자)

1. 저장소를 받고 브랜치를 만든다.
   ```
   git clone https://github.<사내도메인>/<조직>/dogent-systems.git
   cd dogent-systems
   git switch -c add-mes
   ```
2. 틀을 복사한다. **폴더 이름이 곧 id**다.
   ```
   Copy-Item -Recurse systems\_template systems\mes
   ```
3. `systems/mes/SYSTEM.md`를 채운다. 아래 "작성 요령" 참고.
4. 검사한다 (Node 20 이상만 있으면 됨, `npm install` 불필요).
   ```
   node tools/system-check.mjs .
   ```
   오류가 0이어야 한다. 경고는 `draft`일 때 나와도 괜찮다.
5. 커밋하고 올려서 PR을 만든다. PR 템플릿의 체크 칸을 채운다.
6. CI 검사 통과 + 담당 부서 승인 → main에 머지.
7. 몇 분 뒤 서버가 받아 가고 모든 도구에 반영된다.

### 작성 요령

| 칸 | 쓰는 법 |
|---|---|
| `id` | 영문 소문자·숫자·하이픈. 폴더 이름과 같게 |
| `name` | 사람들이 부르는 정식 이름 |
| `description` | 무엇을 하는 시스템인지 한두 문장. 너무 짧으면 경고 |
| `aliases` | **가장 중요.** 사람들이 실제로 하는 말: 줄임말, 한글 발음, 업무 이름 ("방화벽 신청" 등). 이게 있어야 "방화벽 열어 줘"에서 GSAMS가 찾아진다 |
| `url`, `domains` | 처음 여는 주소와 이 시스템의 호스트. 화면 `url`이 `domains` 밖이면 오류 |
| `owner` | 담당 부서 |
| `login` | 로그인 방식. 비밀번호는 절대 쓰지 않는다 |
| `status` | 처음엔 `draft`, 담당자가 확인하면 `verified` |
| `screens` | 화면 이름, 메뉴 경로, 하는 일. 스킬 만들 때 길 안내가 된다 |
| `terms` | 사내 용어와 뜻 |
| 본문 | 주의사항: 승인이 필요한 버튼, 하지 말아야 할 것 |

넣으면 안 되는 것: 비밀번호·토큰, 개인 정보, 내부 IP 대역 목록 같은 민감 데이터.

## 5. 고치기·신고 처리

- **고칠 때:** 브랜치 → 수정 → `updated`를 오늘 날짜로 → 검사 → PR.
- **신고 처리:** 서버의 신고 파일(`--reports`)을 주 1회 확인한다. 한 줄이 JSON 하나다. 맞는 신고면 PR로 고치고, 아니면 무시한다.
  ```
  Get-Content /var/dogent-systems/issues.jsonl
  ```
- **없어진 시스템:** 폴더를 삭제하는 PR. 이력은 git에 남는다.

## 6. 서버 띄우기 (관리자, 사내 서버 1대)

```
git clone https://github.<사내도메인>/<조직>/dogent-systems.git /opt/dogent-systems
cd /opt/dogent-systems
SYSTEMS_MCP_TOKEN=<긴 무작위 문자열> \
node tools/systems-mcp.mjs --root . --host 0.0.0.0 --port 8787 --pull 300 \
  --reports /var/dogent-systems/issues.jsonl
```

- 서버에 저장소를 읽을 수 있는 계정(배포 키나 읽기 전용 토큰)이 있어야 `--pull`이 된다.
- 계속 돌리려면 systemd나 pm2 등으로 등록한다.
- 확인: `http://<서버>:8787/health` → 판 번호와 시스템 수가 나오면 정상.
- 토큰을 쓰면 클라이언트에 `Authorization: Bearer <토큰>`을 함께 설정한다.

## 7. 각 도구에서 붙이기 (사용자)

### 7-1. Dogent 앱·터미널: 받아서 자동으로 쓰기 (권장)

```
dogent config systemsUrl http://<서버>:8787     # 또는 …/mcp 주소 그대로
dogent config systemsToken <토큰>               # 서버에 토큰을 걸었을 때
dogent sync                                     # 지금 받기
dogent systems                                  # [공용] 항목이 보이면 성공
```

- 서버의 `GET /systems.json`에서 사전 전체를 받아 `~/.dogent/systems-cache`에 두고, 요청에 시스템 이름이 나오면 그 설명을 모델에 함께 보여 줍니다. 앱은 켤 때와 한 시간마다, 터미널은 명령을 쓸 때 한 시간에 한 번 받습니다 (판 번호가 같으면 서버가 304로 답해 내려받지 않습니다).
- 서버가 꺼져 있어도 마지막으로 받아 둔 사전으로 동작합니다.
- 같은 id는 개인 > **공용** > 팀 > 기본 순서입니다. 공용 사전이 정본이므로, 팀 스킬 저장소의 `systems/`에는 같은 시스템을 따로 적지 않습니다.
- 회사 빌드에 기본값으로 넣으려면 `.env.company.local`의 `WXT_SYSTEMS_URL`. 토큰은 각자 `config systemsToken`으로 넣습니다.

### 7-2. 다른 도구(Claude Code, opencode)와 모델이 직접 부르기 (MCP)

```
dogent mcp add systems http://<서버>:8787/mcp --transport http
claude mcp add --transport http systems http://<서버>:8787/mcp
```

토큰을 쓰면 `--header "Authorization: Bearer <토큰>"`을 붙인다. Dogent 데스크탑은 커넥터 화면에서 같은 주소를 붙여 넣어도 된다.

붙은 뒤 시험: "GSAMS가 뭐야?"나 "방화벽 신청은 어디서 해?"라고 물어서 사전 내용이 나오면 성공이다.

## 8. 운영 규칙

1. 새 항목은 `draft`로 넣고, 담당자가 확인한 뒤에만 `verified`로 올린다.
2. `tools/` 아래 파일은 고치지 않는다. Dogent 저장소에서 새로 생성한 것을 통째로 교체한다.
3. 시스템마다 담당 부서를 CODEOWNERS에 반드시 둔다. 승인할 사람이 없는 항목은 반영되지 않는다.
4. 신고는 주 1회 확인한다.
5. 분기마다 `updated`가 오래된 항목을 점검한다.

## 9. 문제 해결

| 증상 | 확인 |
|---|---|
| PR이 계속 실패 | `node tools/system-check.mjs .` 출력의 오류 줄. 폴더 이름 ≠ id, 주소가 domains 밖, 다른 시스템과 별칭 중복이 흔함 |
| 머지했는데 안 나옴 | `/health`의 판 번호가 바뀌었는지. `--pull` 간격(기본 300초)을 기다렸는지. 서버의 git 인증 |
| 한 시스템이 안 나옴 | `/health`의 "오류로 뺀 파일 수". 형식 오류가 있는 파일은 빼고 나머지만 돈다 |
| 클라이언트에서 401 | 토큰 설정 확인 |
