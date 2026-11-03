# dogent-office (오피스 도구)

문서 보안(NASCA)이 걸린 문서는 라이브러리로 직접 열 수 없고, 권한 있는 사용자의 Office가 열어야 합니다 (docs/09 D5). 이 도구는 사용자의 **Excel, Word, PowerPoint**를 COM으로 다뤄 문서를 열고, 읽고, 쓰고, 그 프로그램으로 저장합니다. Dogent 클라이언트와 Claude Code가 같은 방식(MCP, stdio)으로 씁니다.

## 빌드

```bash
pnpm office:build        # office/dist/dogent-office.exe
```

- 윈도우에 기본으로 있는 C# 컴파일러(.NET Framework 4.x의 `csc.exe`)로 빌드합니다. Visual Studio나 .NET SDK를 설치하지 않아도 됩니다.
- 그래서 C# 5 문법만 씁니다 (문자열 보간 `$""`, `?.` 없음).
- Excel은 늦은 바인딩(`dynamic`)으로 부르므로 Interop DLL이 필요 없습니다. Excel이 설치된 PC면 됩니다.

## 도구 (MCP)

| 도구 | 하는 일 |
|---|---|
| `excel_open` | 경로(또는 Excel이 직접 여는 http(s) 주소)의 문서를 이 도구 전용 Excel로 연다. 기본 읽기 전용. 시트 목록과 사용 범위를 돌려줌 |
| `excel_new` | 새 통합 문서 |
| `excel_read` | 시트의 표 읽기 (첫 행은 열 이름, 날짜 서식은 `2026-10-01`, 앞자리 0은 글자 그대로) |
| `excel_write` | 시트에 표 쓰기 (시작 칸, 열 이름, 행). 시트가 없으면 만듦 |
| `excel_save` | Excel로 저장. 다른 이름으로 저장할 때 있는 파일은 `overwrite`가 있어야 덮어씀. 읽기 전용 문서는 그 자리에 저장하지 않음 |
| `excel_close` | 닫기 (저장 안 한 변경은 버림) |
| `excel_user_workbooks` | 사용자의 Excel에 지금 열린 문서 |
| `excel_attach` | 사용자의 Excel에 이미 열린 문서를 잡음 (아래 EDM) |

- `excel_attach`로 잡은 사용자의 문서를 다른 이름으로 저장하면 사용자 창의 파일 이름이 바뀌지 않도록 **사본(SaveCopyAs)만** 만듭니다. 그래서 같은 형식(`.xlsx` → `.xlsx`)만 됩니다.
- 사용자가 띄운 Excel과 섞이지 않도록 전용 Excel을 숨겨서 띄우고, 끝날 때 연 문서는 저장하지 않고 닫은 뒤 Excel을 끝냅니다.
- Excel이 바빠 호출을 거절하면(문서를 여는 중, 칸 편집 중) 최대 60초 동안 다시 부릅니다.
- 문서 보안 프로그램이 Excel 창을 요구하면 `DOGENT_OFFICE_VISIBLE=1`로 띄웁니다.

## Word·PowerPoint 도구

Excel과 같은 모양(열기, 새로 만들기, 목록, 저장, 닫기, 사용자가 연 문서 잡기)에 문서 종류별 읽기·쓰기가 붙습니다. 문서 번호는 `doc`(Word `wd1`, PowerPoint `pp1`)입니다.

| 도구 | 하는 일 |
|---|---|
| `word_open` / `word_new` / `word_list` | 문서를 열기(기본 읽기 전용), 새 문서, 이 도구가 연 문서 목록 |
| `word_read` | 문단(글, 스타일 이름)과 표(첫 줄은 열 이름)를 읽기. 표 안의 글은 문단에서 빠지고 표로만 나옴 |
| `word_write` | `replace`로 문서 전체에서 찾아 바꾸기(바꿀 글 250자까지), `append`로 끝에 문단 덧붙이기(글 또는 `{text, style}`, style: normal/title/heading1~3/bullet/number), `table`로 끝에 표 붙이기 |
| `word_save` | 저장 (`.docx .docm .doc .pdf .rtf .txt`). 읽기 전용 문서는 그 자리에 저장하지 않음 |
| `word_user_docs` / `word_attach` | 사용자의 Word에 열린 문서 보기, 이름으로 잡기 |
| `ppt_open` / `ppt_new` / `ppt_list` | 위와 같음 (창 없이 열림) |
| `ppt_read` | 슬라이드별 제목, 글 상자, 표, 발표자 메모 |
| `ppt_write` | `replace`로 모든 슬라이드 글에서 찾아 바꾸기, `slides`로 끝에 슬라이드 덧붙이기(`{title, bullets, table, notes}`), `notes`로 기존 슬라이드의 발표자 메모 정하기 |
| `ppt_save` | 저장 (`.pptx .pptm .ppt .pdf`) |
| `ppt_user_docs` / `ppt_attach` | 사용자의 PowerPoint에 열린 문서 보기, 잡기 |

- **사용자 창의 문서를 다른 이름으로 저장할 때**: PowerPoint는 사본(`SaveCopyAs`)만 만들어 창의 문서 이름이 바뀌지 않습니다. Word에는 사본 저장이 없어 **PDF 내보내기만** 허용하고, 같은 문서를 고쳐 저장하려면 `path` 없이 저장합니다.
- PowerPoint는 이미 실행 중이면 그 프로그램에 붙습니다(단일 인스턴스). 그래서 끝날 때 사용자의 문서가 열려 있으면 프로그램을 끝내지 않습니다.
- PowerPoint는 창을 숨길 수 없어 문서를 창 없이 엽니다. 보안 프로그램이 창을 요구하면 `DOGENT_OFFICE_VISIBLE=1`.
- `word_write`의 표 덧붙이기와 `ppt_write`의 슬라이드는 서식을 단순하게 둡니다(표 테두리, 머리글 굵게). 회사 양식에 맞추려면 양식 문서를 열어 `replace`로 채우는 방식이 낫습니다.
- 에이전트(자유 요청, 스킬)는 `word_read/word_write/word_save`, `ppt_read/ppt_write/ppt_save`로 씁니다. 쓰기와 열린 곳에 저장은 `--allow-write`(R3)와 사용자 허락이 있을 때만이고, 다른 이름 저장은 허락만 받으면 됩니다. 아직 없는 `.docx`/`.pptx` 경로를 쓰기에 주면 새 문서를 만들고 저장하면 그 경로에 생깁니다.

## 사내 문서 공유망(EDM) 문서

공유받은 링크에서 **읽기·편집** 버튼을 누르면 사용자의 Excel이 문서를 엽니다. 경로를 알 수 없으므로 `excel_attach`로 그 문서를 잡습니다.

```
1. (브라우저 도구) EDM 화면에서 "편집" 버튼을 누른다
2. excel_attach { name: "문서 이름 일부", wait_sec: 60 }   ← Excel에 열리기를 기다렸다가 잡음
3. excel_read / excel_write
4. excel_save { workbook }                              ← 열린 곳(EDM)에 저장
5. excel_close { workbook }                             ← 사용자의 문서는 닫지 않고 놓기만 함
```

- Excel 창이 여러 개(여러 프로세스)여도 찾습니다. Excel이 연 문서를 등록하는 윈도우의 실행 중인 개체 테이블(ROT)에서 찾기 때문입니다.
- 링크가 Excel이 직접 여는 주소(WebDAV, SharePoint 형식)라면 `excel_open`에 그 주소를 그대로 줘도 됩니다.
- 실제 EDM 화면에서는 아직 확인하지 못했습니다. 버튼이 Excel을 여는 방식(파일을 내려받아 열기, `ms-excel:` 링크, 전용 프로그램)에 따라 2번의 이름과 기다리는 시간이 달라질 수 있습니다.

## 클라이언트에서

```bash
pnpm client excel D:\자료\재공.xlsx                     # Excel로 열어 시트와 앞부분 보기 (문서 보안 문서 확인)
pnpm client excel docs                                  # 사용자의 Excel에 열린 문서 (EDM에서 연 문서 등)
pnpm client excel resave D:\자료\원본.xlsx D:\자료\다시저장.xlsx   # Excel로 다시 저장
pnpm client config saveThroughExcel true                # 결과 엑셀을 Excel을 거쳐 저장
```

- 스킬의 엑셀 파일 입력은 먼저 파일을 직접 읽고, 안 되면(문서 보안 파일, 구형 xls) Excel로 엽니다.
- **문서 보안(NASCA)이 Excel로 저장한 파일을 다시 암호화하는지는 아직 확인하지 못했습니다.** 위의 `excel resave`로 저장한 파일을 탐색기와 다른 PC에서 열어 확인해 주세요. 암호화된다면 `saveThroughExcel`을 켜면 결과 엑셀도 같은 규정을 따릅니다.

## Claude Code에서

```bash
claude mcp add dogent-office -- D:\code\dogent\office\dist\dogent-office.exe
```

## 시험

```bash
pnpm office:build && pnpm e2e:office            # 숨긴 Excel·Word·PowerPoint로 열기·읽기·쓰기·저장
pnpm e2e:office --attach                        # EDM처럼 사용자 프로그램에 열린 문서 잡기 (Excel·Word·PowerPoint 창이 잠깐 뜸)
```

시험은 Excel에 더해 Word·PowerPoint가 설치된 PC에서 돕니다. 저장한 .docx/.pptx는 압축을 풀어 글자까지 확인합니다. 시험이 띄운 Word·PowerPoint가 남을 수 있으니, 끝난 뒤 작업 관리자에서 확인하세요.

