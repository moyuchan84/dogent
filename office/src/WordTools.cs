using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Dogent.Office
{
    /// <summary>사용자의 Word로 문서를 열고, 읽고(문단·표), 쓰고(문단 덧붙이기·표·찾아 바꾸기), 저장한다.</summary>
    internal sealed class WordTools : DocTools
    {
        private const int DefaultMaxParagraphs = 500;

        public WordTools(Action<string> log) : base(log) { }

        public override string Prefix { get { return "word"; } }
        protected override string HandlePrefix { get { return "wd"; } }
        protected override string ProgId { get { return "Word.Application"; } }
        protected override string Label { get { return "Word"; } }

        protected override bool RotName(string lower)
        {
            if (lower.StartsWith("!")) return false;
            return lower.Contains(".doc") || lower.Contains(".rtf") || lower.StartsWith("http");
        }

        protected override bool IsDoc(dynamic obj)
        {
            return obj.Paragraphs != null && obj.Tables != null;
        }

        protected override dynamic Collection(dynamic application)
        {
            return application.Documents;
        }

        protected override void Prepare(dynamic application)
        {
            application.Visible = Environment.GetEnvironmentVariable("DOGENT_OFFICE_VISIBLE") == "1";
            application.DisplayAlerts = 0; // wdAlertsNone
        }

        protected override dynamic OpenDoc(dynamic application, string path, bool readOnly, string password)
        {
            return password == null
                ? application.Documents.Open(FileName: path, ConfirmConversions: false, ReadOnly: readOnly, AddToRecentFiles: false)
                : application.Documents.Open(FileName: path, ConfirmConversions: false, ReadOnly: readOnly, AddToRecentFiles: false, PasswordDocument: password);
        }

        protected override dynamic NewDoc(dynamic application)
        {
            return application.Documents.Add();
        }

        protected override object Summary(dynamic doc)
        {
            return new Dictionary<string, object>
            {
                { "paragraphs", (int)doc.Paragraphs.Count },
                { "tables", (int)doc.Tables.Count },
                { "characters", (int)doc.Characters.Count },
            };
        }

        /// <summary>칸·문단 글에서 끝의 문단 표시(\r)와 칸 표시(\a)를 뗀다.</summary>
        private static string Clean(string s)
        {
            if (s == null) return "";
            return s.TrimEnd('\r', '\a', '\n', ' ').Replace("\r", "\n").Replace("\a", "");
        }

        private static string StyleName(dynamic para)
        {
            try
            {
                return Convert.ToString(para.Style.NameLocal);
            }
            catch
            {
                return "";
            }
        }

        protected override object ReadDoc(dynamic doc, Dictionary<string, object> a)
        {
            int maxParagraphs = Math.Max(1, Number(a, "max_paragraphs", DefaultMaxParagraphs));
            int maxRows = Math.Max(1, Number(a, "max_rows", 1000));
            bool includeParagraphs = Flag(a, "paragraphs", true);
            int total = (int)doc.Paragraphs.Count;

            var paragraphs = new List<object>();
            int nonEmpty = 0;
            if (includeParagraphs)
            {
                for (int i = 1; i <= total; i++)
                {
                    dynamic p = doc.Paragraphs.Item(i);
                    string text = Clean((string)p.Range.Text);
                    if (text.Length == 0) continue;
                    // 표 안의 문단은 표로 따로 돌려주므로 여기서는 뺀다.
                    bool inTable;
                    try { inTable = (int)p.Range.Tables.Count > 0; } catch { inTable = false; }
                    if (inTable) continue;
                    nonEmpty++;
                    if (paragraphs.Count < maxParagraphs)
                        paragraphs.Add(new Dictionary<string, object> { { "text", text }, { "style", StyleName(p) } });
                }
            }

            var tables = new List<object>();
            int tableCount = (int)doc.Tables.Count;
            for (int t = 1; t <= tableCount; t++) tables.Add(ReadTable(doc.Tables.Item(t), t, maxRows));

            return new Dictionary<string, object>
            {
                { "name", (string)doc.Name },
                { "total_paragraphs", nonEmpty },
                { "paragraphs", paragraphs },
                { "tables", tables },
            };
        }

        /// <summary>표를 칸 단위로 읽는다 (세로로 합친 칸이 있어도 읽힌다). 첫 줄은 열 이름.</summary>
        private static object ReadTable(dynamic table, int index, int maxRows)
        {
            dynamic cells = table.Range.Cells;
            int count = (int)cells.Count;
            int rowsN = 0, colsN = 0;
            var map = new Dictionary<long, string>();
            for (int i = 1; i <= count; i++)
            {
                dynamic c = cells.Item(i);
                int r = (int)c.RowIndex, col = (int)c.ColumnIndex;
                if (r > rowsN) rowsN = r;
                if (col > colsN) colsN = col;
                map[(long)r * 100000 + col] = Clean((string)c.Range.Text);
            }
            var columns = new List<string>();
            for (int c = 1; c <= colsN; c++)
            {
                string name;
                if (!map.TryGetValue(1L * 100000 + c, out name) || name.Trim().Length == 0) name = "열" + c;
                columns.Add(name.Trim());
            }
            var rows = new List<object>();
            for (int r = 2; r <= rowsN && rows.Count < maxRows; r++)
            {
                var row = new object[colsN];
                for (int c = 1; c <= colsN; c++)
                {
                    string v;
                    row[c - 1] = map.TryGetValue((long)r * 100000 + c, out v) ? v : "";
                }
                rows.Add(row);
            }
            return new Dictionary<string, object>
            {
                { "index", index },
                { "columns", columns },
                { "total_rows", Math.Max(0, rowsN - 1) },
                { "rows", rows },
            };
        }

        /// <summary>스타일 이름을 Word 기본 스타일 번호로. 모르는 이름은 그 이름 그대로 쓴다.</summary>
        private static object StyleOf(string style)
        {
            if (string.IsNullOrEmpty(style)) return null;
            switch (style.Trim().ToLowerInvariant())
            {
                case "normal": case "본문": return -1;
                case "title": case "제목": return -63;
                case "heading1": case "h1": return -2;
                case "heading2": case "h2": return -3;
                case "heading3": case "h3": return -4;
                case "bullet": case "list": return -49;
                case "number": return -50;
                default: return style;
            }
        }

        protected override object WriteDoc(dynamic doc, Dictionary<string, object> a)
        {
            if (Truthy(doc.ReadOnly)) throw new InvalidOperationException("읽기 전용으로 연 문서입니다. read_only를 false로 다시 열거나 다른 이름으로 저장할 사본을 쓰세요");
            int replaced = 0, appended = 0, tableRows = 0;

            // 1) 찾아 바꾸기 (문서 전체)
            var replace = Arr(Program.Get(a, "replace"));
            if (replace != null)
            {
                foreach (object o in replace)
                {
                    var r = Obj(o);
                    string find = r == null ? null : Text(r, "find");
                    string with = r == null ? null : (Text(r, "with") ?? "");
                    if (string.IsNullOrEmpty(find)) throw new ArgumentException("replace의 각 항목에는 find가 있어야 합니다");
                    if (with.Length > 250) throw new ArgumentException("바꿀 글은 250자까지입니다 (Word의 한도). 긴 글은 append로 덧붙이세요");
                    string body = Convert.ToString(doc.Content.Text);
                    int n = 0, at = 0;
                    while ((at = body.IndexOf(find, at, StringComparison.OrdinalIgnoreCase)) >= 0) { n++; at += find.Length; }
                    if (n == 0) continue;
                    dynamic range = doc.Content;
                    dynamic f = range.Find;
                    f.ClearFormatting();
                    f.Replacement.ClearFormatting();
                    f.Execute(FindText: find, MatchCase: false, MatchWholeWord: false, MatchWildcards: false, Forward: true, Wrap: 0, ReplaceWith: with, Replace: 2);
                    replaced += n;
                }
            }

            // 2) 문단 덧붙이기: 문자열이거나 {text, style}
            var append = Arr(Program.Get(a, "append"));
            if (append != null)
            {
                foreach (object o in append)
                {
                    string text, style = null;
                    var d = Obj(o);
                    if (d != null) { text = Text(d, "text") ?? ""; style = Text(d, "style"); }
                    else text = Convert.ToString(o, CultureInfo.InvariantCulture) ?? "";
                    AppendParagraph(doc, text, style);
                    appended++;
                }
            }

            // 3) 표 덧붙이기
            var table = Obj(Program.Get(a, "table"));
            if (table != null) tableRows = AppendTable(doc, table);

            return new Dictionary<string, object>
            {
                { "replaced", replaced },
                { "appended_paragraphs", appended },
                { "appended_table_rows", tableRows },
                { "paragraphs", (int)doc.Paragraphs.Count },
            };
        }

        private static void AppendParagraph(dynamic doc, string text, string style)
        {
            int end = (int)doc.Content.End;
            dynamic r = doc.Range(end - 1, end - 1);
            r.InsertAfter(text);
            r.InsertParagraphAfter();
            object st = StyleOf(style);
            // 방금 쓴 문단은 마지막(빈) 문단 바로 앞
            int count = (int)doc.Paragraphs.Count;
            dynamic para = doc.Paragraphs.Item(Math.Max(1, count - 1));
            // 직전 문단의 서식을 이어받지 않도록 스타일을 항상 정한다 (기본은 본문)
            para.Style = st ?? (object)(-1);
        }

        private static int AppendTable(dynamic doc, Dictionary<string, object> spec)
        {
            var columns = Arr(Program.Get(spec, "columns"));
            var rows = Arr(Program.Get(spec, "rows"));
            if (rows == null) throw new ArgumentException("table.rows는 행 배열이어야 합니다");
            var lines = new List<object[]>();
            if (columns != null && columns.Length > 0) lines.Add(columns);
            foreach (object r in rows)
            {
                var cells = r as object[];
                if (cells == null) throw new ArgumentException("table.rows의 각 행은 값 배열이어야 합니다");
                lines.Add(cells);
            }
            if (lines.Count == 0) return 0;
            int width = 1;
            foreach (var l in lines) width = Math.Max(width, l.Length);
            int end = (int)doc.Content.End;
            dynamic range = doc.Range(end - 1, end - 1);
            dynamic tbl = doc.Tables.Add(range, lines.Count, width);
            try { tbl.Borders.Enable = true; } catch { }
            for (int r = 0; r < lines.Count; r++)
                for (int c = 0; c < lines[r].Length; c++)
                    tbl.Cell(r + 1, c + 1).Range.Text = Convert.ToString(lines[r][c], CultureInfo.InvariantCulture) ?? "";
            if (columns != null && columns.Length > 0)
            {
                try { tbl.Rows.Item(1).Range.Font.Bold = 1; } catch { }
            }
            // 표 뒤에 이어 쓸 빈 문단이 남는다 (Word가 표 다음에 늘 문단을 둔다)
            return rows.Length;
        }

        protected override void SaveTo(dynamic doc, string path, bool isAttached)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (isAttached)
            {
                // Word에는 사본 저장이 없다. SaveAs를 하면 사용자 창의 문서 이름이 바뀌므로 PDF 내보내기만 허용한다.
                if (ext != ".pdf") throw new ArgumentException("사용자의 Word 문서는 PDF(.pdf) 사본으로만 다른 이름 저장을 할 수 있습니다. 같은 문서를 고쳐 저장하려면 path 없이 저장하세요");
                doc.ExportAsFixedFormat(path, 17); // wdExportFormatPDF
                return;
            }
            int format;
            switch (ext)
            {
                case ".docx": format = 16; break;   // wdFormatDocumentDefault
                case ".docm": format = 13; break;
                case ".doc": format = 0; break;
                case ".pdf": format = 17; break;
                case ".rtf": format = 6; break;
                case ".txt": format = 2; break;
                default: throw new ArgumentException("저장할 수 있는 형식은 .docx, .docm, .doc, .pdf, .rtf, .txt 입니다: " + path);
            }
            doc.SaveAs2(FileName: path, FileFormat: format);
        }

        protected override void CloseDoc(dynamic doc)
        {
            doc.Close(0); // wdDoNotSaveChanges
        }
    }
}
