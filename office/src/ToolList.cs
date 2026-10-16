using System.Collections.Generic;

namespace Dogent.Office
{
    /// <summary>MCP tools/list에 나가는 도구 목록. 이름과 인자는 client/src/office.ts와 맞춘다.</summary>
    internal static class ToolList
    {
        private static Dictionary<string, object> Prop(string type, string description)
        {
            return new Dictionary<string, object> { { "type", type }, { "description", description } };
        }

        private static Dictionary<string, object> Tool(string name, string description, Dictionary<string, object> props, params string[] required)
        {
            return new Dictionary<string, object>
            {
                { "name", name },
                { "description", description },
                { "inputSchema", new Dictionary<string, object> { { "type", "object" }, { "properties", props }, { "required", required } } },
            };
        }

        private static readonly Dictionary<string, object> Workbook = Prop("string", "excel_open이나 excel_new가 돌려준 번호 (예: wb1)");

        public static object[] All()
        {
            return new object[]
            {
                Tool("excel_open", "엑셀 문서를 사용자의 Excel로 연다. 문서 보안(NASCA)이 걸린 문서도 사용자의 Excel이 열 수 있으면 열린다. 시트 목록과 각 시트의 사용 범위를 돌려준다.",
                    new Dictionary<string, object>
                    {
                        { "path", Prop("string", "문서의 전체 경로, 또는 Excel이 직접 열 수 있는 http(s) 주소") },
                        { "read_only", Prop("boolean", "읽기 전용으로 연다 (기본 true)") },
                        { "password", Prop("string", "문서 열기 암호가 있을 때만") },
                    }, "path"),
                Tool("excel_new", "새 통합 문서를 만든다. 결과를 쓰고 excel_save로 저장할 때 쓴다.", new Dictionary<string, object>()),
                Tool("excel_list", "이 도구가 연 통합 문서 목록", new Dictionary<string, object>()),
                Tool("excel_read", "시트의 표를 읽는다. range가 없으면 사용 범위 전체. header가 true(기본)면 첫 행을 열 이름으로 쓴다. 결과는 JSON (columns, total_rows, rows).",
                    new Dictionary<string, object>
                    {
                        { "workbook", Workbook },
                        { "sheet", Prop("string", "시트 이름. 없으면 첫 시트") },
                        { "range", Prop("string", "예: A1:F200. 없으면 사용 범위") },
                        { "header", Prop("boolean", "첫 행이 열 이름인지 (기본 true)") },
                        { "max_rows", Prop("integer", "돌려줄 최대 행 수 (기본 1000)") },
                    }, "workbook"),
                Tool("excel_write", "시트에 표를 쓴다. start(기본 A1)부터 columns(있으면 첫 행)와 rows를 차례로 채운다. 시트가 없으면 만든다.",
                    new Dictionary<string, object>
                    {
                        { "workbook", Workbook },
                        { "sheet", Prop("string", "시트 이름. 없으면 첫 시트") },
                        { "start", Prop("string", "왼쪽 위 칸 (기본 A1)") },
                        { "columns", Prop("array", "열 이름. 주면 첫 행에 쓴다") },
                        { "rows", Prop("array", "행 배열. 행은 값 배열") },
                    }, "workbook", "rows"),
                Tool("excel_save", "Excel로 저장한다. path가 없으면 연 파일에, 있으면 그 경로에 다른 이름으로 저장한다 (.xlsx/.xlsm/.xls/.csv). 이미 있는 파일은 overwrite가 true일 때만 덮어쓴다.",
                    new Dictionary<string, object>
                    {
                        { "workbook", Workbook },
                        { "path", Prop("string", "다른 이름으로 저장할 전체 경로") },
                        { "overwrite", Prop("boolean", "있는 파일을 덮어쓸지 (기본 false)") },
                    }, "workbook"),
                Tool("excel_user_workbooks", "사용자의 Excel에 지금 열려 있는 문서 목록 (이 도구가 따로 연 문서는 빠짐)", new Dictionary<string, object>()),
                Tool("excel_attach", "사용자의 Excel에 이미 열린 문서를 잡는다. 사내 문서 공유망(EDM)에서 읽기·편집 버튼을 눌러 Excel이 연 문서처럼 경로를 모르는 문서에 쓴다. 저장하면 열린 곳(EDM)에 저장되고, 닫아도 사용자의 문서는 닫지 않는다.",
                    new Dictionary<string, object>
                    {
                        { "name", Prop("string", "문서 이름이나 주소에 든 글자. 없으면 아직 잡지 않은 문서가 하나일 때 그 문서") },
                        { "wait_sec", Prop("integer", "문서가 열리기를 기다릴 시간 (기본 0, 최대 600)") },
                    }),
                Tool("excel_close", "통합 문서를 닫는다. 저장하지 않은 변경은 버린다. excel_attach로 잡은 사용자의 문서는 닫지 않고 놓기만 한다.",
                    new Dictionary<string, object> { { "workbook", Workbook } }, "workbook"),
            };
        }
    }
}
