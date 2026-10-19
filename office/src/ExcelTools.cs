using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

namespace Dogent.Office
{
    /// <summary>
    /// Excel COM 작업. 사용자가 이미 띄운 Excel은 건드리지 않도록 이 도구 전용 Excel을 따로 띄운다.
    /// 끝날 때 연 문서는 저장하지 않고 닫고 Excel을 끝낸다.
    /// </summary>
    internal sealed class ExcelTools : IDisposable
    {
        private const int DefaultMaxRows = 1000;
        private static readonly Regex DateFormat = new Regex(@"(yy|dd|mm/|/mm|m/d|d/m|-mm|mm-|년|월|일|h:mm)", RegexOptions.IgnoreCase);

        private readonly Action<string> log;
        private readonly Dictionary<string, dynamic> books = new Dictionary<string, dynamic>();
        private readonly Dictionary<string, string> paths = new Dictionary<string, string>();
        /// <summary>사용자의 Excel에 이미 열려 있던 문서 (EDM 링크로 연 문서 등). 닫지도, Excel을 끝내지도 않는다.</summary>
        private readonly HashSet<string> attached = new HashSet<string>();
        private dynamic app;
        private int next = 1;
        private bool disposed;

        public ExcelTools(Action<string> log)
        {
            this.log = log;
        }

        private dynamic App
        {
            get
            {
                if (app != null) return app;
                Type type = Type.GetTypeFromProgID("Excel.Application");
                if (type == null) throw new InvalidOperationException("이 PC에 Excel이 없습니다. Excel이 설치된 PC에서 실행하세요");
                app = Activator.CreateInstance(type);
                // 화면에 띄우지 않는다. 문서 보안 프로그램이 창을 요구하면 DOGENT_OFFICE_VISIBLE=1로 띄운다.
                app.Visible = Environment.GetEnvironmentVariable("DOGENT_OFFICE_VISIBLE") == "1";
                app.DisplayAlerts = false;
                log("Excel " + Convert.ToString(app.Version) + "을(를) 띄웠습니다");
                return app;
            }
        }

        public object Call(string name, Dictionary<string, object> a)
        {
            switch (name)
            {
                case "excel_open": return Open(a);
                case "excel_new": return New();
                case "excel_list": return List();
                case "excel_read": return Read(a);
                case "excel_write": return Write(a);
                case "excel_save": return Save(a);
                case "excel_close": return Close(a);
                case "excel_user_workbooks": return UserWorkbooks();
                case "excel_attach": return Attach(a);
                default: throw new ArgumentException("모르는 도구: " + name);
            }
        }

        private static string Text(Dictionary<string, object> a, string key)
        {
            return Program.Str(a, key);
        }

        private static bool Flag(Dictionary<string, object> a, string key, bool fallback)
        {
            object v = Program.Get(a, key);
            return v is bool ? (bool)v : fallback;
        }

        private static int Number(Dictionary<string, object> a, string key, int fallback)
        {
            object v = Program.Get(a, key);
            if (v == null) return fallback;
            return Convert.ToInt32(v, CultureInfo.InvariantCulture);
        }

        private dynamic Book(Dictionary<string, object> a)
        {
            string id = Text(a, "workbook");
            dynamic wb;
            if (id == null || !books.TryGetValue(id, out wb)) throw new ArgumentException("열린 통합 문서 \"" + id + "\"이(가) 없습니다. excel_open으로 먼저 여세요");
            return wb;
        }

        private static dynamic Sheet(dynamic wb, string name, bool create)
        {
            if (string.IsNullOrEmpty(name)) return wb.Worksheets[1];
            foreach (dynamic ws in wb.Worksheets)
            {
                if (string.Equals((string)ws.Name, name, StringComparison.OrdinalIgnoreCase)) return ws;
            }
            if (!create) throw new ArgumentException("시트 \"" + name + "\"이(가) 없습니다");
            dynamic added = wb.Worksheets.Add(After: wb.Worksheets[wb.Worksheets.Count]);
            added.Name = name;
            return added;
        }

        private static List<object> Sheets(dynamic wb)
        {
            var list = new List<object>();
            foreach (dynamic ws in wb.Worksheets)
            {
                dynamic used = ws.UsedRange;
                list.Add(new Dictionary<string, object>
                {
                    { "name", (string)ws.Name },
                    { "range", Addr(used) },
                    { "rows", (int)used.Rows.Count },
                    { "columns", (int)used.Columns.Count },
                });
            }
            return list;
        }

        private object Register(dynamic wb, string path)
        {
            string id = "wb" + next++;
            books[id] = wb;
            paths[id] = path;
            return new Dictionary<string, object> { { "workbook", id }, { "name", (string)wb.Name }, { "path", path ?? "" }, { "sheets", Sheets(wb) } };
        }

        private object Open(Dictionary<string, object> a)
        {
            string path = Text(a, "path");
            // Excel이 직접 여는 주소 (문서 공유망의 공유 링크 중 Excel이 열 수 있는 것)
            bool url = path != null && Regex.IsMatch(path, "^https?://", RegexOptions.IgnoreCase);
            if (!url)
            {
                if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) throw new ArgumentException("path는 전체 경로나 http(s) 주소여야 합니다 (예: D:\\자료\\재공.xlsx)");
                path = Path.GetFullPath(path);
                if (!File.Exists(path)) throw new FileNotFoundException("파일이 없습니다: " + path);
            }
            bool readOnly = Flag(a, "read_only", true);
            string password = Text(a, "password");
            dynamic wb = password == null
                ? App.Workbooks.Open(Filename: path, UpdateLinks: 0, ReadOnly: readOnly)
                : App.Workbooks.Open(Filename: path, UpdateLinks: 0, ReadOnly: readOnly, Password: password);
            log("열었습니다: " + path);
            return Register(wb, path);
        }

        private object New()
        {
            return Register(App.Workbooks.Add(), null);
        }

        private object List()
        {
            var list = new List<object>();
            foreach (var kv in books)
            {
                list.Add(new Dictionary<string, object> { { "workbook", kv.Key }, { "name", (string)kv.Value.Name }, { "path", paths[kv.Key] ?? "" } });
            }
            return list;
        }

        /// <summary>칸 값을 JSON으로 보낼 값으로. 날짜 서식 열의 숫자는 날짜 글자로 바꾼다.</summary>
        private static object Cell(object v, bool isDate)
        {
            if (v == null) return "";
            if (v is double)
            {
                double d = (double)v;
                if (isDate && d > 0 && d < 2958466)
                {
                    DateTime t = DateTime.FromOADate(d);
                    return t.TimeOfDay.Ticks == 0 ? t.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : t.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
                }
                if (Math.Abs(d) < 9e15 && d == Math.Floor(d)) return (long)d;
                return d;
            }
            if (v is int) return "#오류"; // Value2는 #N/A 같은 오류 칸을 정수 코드로 준다
            if (v is bool || v is string) return v;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        private object Read(Dictionary<string, object> a)
        {
            dynamic wb = Book(a);
            dynamic ws = Sheet(wb, Text(a, "sheet"), false);
            string address = Text(a, "range");
            dynamic range = string.IsNullOrEmpty(address) ? ws.UsedRange : ws.Range[address];
            bool header = Flag(a, "header", true);
            int maxRows = Math.Max(1, Number(a, "max_rows", DefaultMaxRows));
            int rows = (int)range.Rows.Count;
            int cols = (int)range.Columns.Count;

            // 한 번에 읽는다 (칸마다 부르면 느리다). 칸 하나면 배열이 아니라 값 하나가 온다.
            object raw = range.Value2;
            object[,] grid;
            if (raw is object[,]) grid = (object[,])raw;
            else
            {
                grid = (object[,])Array.CreateInstance(typeof(object), new[] { 1, 1 }, new[] { 1, 1 });
                grid[1, 1] = raw;
            }

            int first = header ? 2 : 1;
            var isDate = new bool[cols + 1];
            if (rows >= first)
            {
                for (int c = 1; c <= cols; c++)
                {
                    string format = Convert.ToString(range.Cells[first, c].NumberFormat);
                    isDate[c] = format != null && format != "General" && DateFormat.IsMatch(format);
                }
            }

            var columns = new List<string>();
            for (int c = 1; c <= cols; c++)
            {
                string name = header ? Convert.ToString(Cell(grid[1, c], false), CultureInfo.InvariantCulture) : "";
                columns.Add(string.IsNullOrWhiteSpace(name) ? "열" + c : name.Trim());
            }

            var outRows = new List<object>();
            int total = 0;
            for (int r = first; r <= rows; r++)
            {
                var row = new object[cols];
                bool empty = true;
                for (int c = 1; c <= cols; c++)
                {
                    row[c - 1] = Cell(grid[r, c], isDate[c]);
                    if (!(row[c - 1] is string) || (string)row[c - 1] != "") empty = false;
                }
                if (empty) continue; // 사용 범위 안의 빈 줄
                total++;
                if (outRows.Count < maxRows) outRows.Add(row);
            }
            return new Dictionary<string, object>
            {
                { "sheet", (string)ws.Name },
                { "range", Addr(range) },
                { "columns", columns },
                { "total_rows", total },
                { "rows", outRows },
            };
        }

        private object Write(Dictionary<string, object> a)
        {
            dynamic wb = Book(a);
            dynamic ws = Sheet(wb, Text(a, "sheet"), true);
            string start = Text(a, "start");
            dynamic origin = ws.Range[string.IsNullOrEmpty(start) ? "A1" : start];
            int top = (int)origin.Row;
            int left = (int)origin.Column;

            var lines = new List<object[]>();
            var columns = Program.Get(a, "columns") as object[];
            if (columns != null && columns.Length > 0) lines.Add(columns);
            var rows = Program.Get(a, "rows") as object[];
            if (rows == null) throw new ArgumentException("rows는 행 배열이어야 합니다");
            foreach (object r in rows)
            {
                var cells = r as object[];
                if (cells == null) throw new ArgumentException("rows의 각 행은 값 배열이어야 합니다");
                lines.Add(cells);
            }
            if (lines.Count == 0) return new Dictionary<string, object> { { "written", 0 } };
            int width = 1;
            foreach (var l in lines) width = Math.Max(width, l.Length);

            var grid = new object[lines.Count, width];
            for (int r = 0; r < lines.Count; r++)
                for (int c = 0; c < width; c++)
                    grid[r, c] = c < lines[r].Length ? ToExcel(lines[r][c]) : null;

            dynamic target = ws.Range[ws.Cells[top, left], ws.Cells[top + lines.Count - 1, left + width - 1]];
            target.Value2 = grid;
            return new Dictionary<string, object>
            {
                { "sheet", (string)ws.Name },
                { "range", Addr(target) },
                { "written", rows.Length },
            };
        }

        /// <summary>범위 주소 (A1:F10). 늦은 바인딩으로는 Address의 인자를 줄 수 없어 $를 지운다.</summary>
        private static string Addr(dynamic range)
        {
            return ((string)range.Address).Replace("$", "");
        }

        private static object ToExcel(object v)
        {
            if (v == null) return null;
            if (v is int || v is long || v is decimal || v is double) return Convert.ToDouble(v, CultureInfo.InvariantCulture);
            return v;
        }

        private static int FormatOf(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".xlsx": return 51;
                case ".xlsm": return 52;
                case ".xls": return 56;
                case ".csv": return 6;
                default: throw new ArgumentException("저장할 수 있는 형식은 .xlsx, .xlsm, .xls, .csv 입니다: " + path);
            }
        }

        private object Save(Dictionary<string, object> a)
        {
            dynamic wb = Book(a);
            string id = Text(a, "workbook");
            string path = Text(a, "path");
            if (string.IsNullOrEmpty(path))
            {
                if (paths[id] == null) throw new ArgumentException("새 통합 문서는 path를 주어야 저장할 수 있습니다");
                if ((bool)wb.ReadOnly) throw new InvalidOperationException("읽기 전용으로 연 문서입니다. path를 주어 다른 이름으로 저장하세요");
                wb.Save();
                return new Dictionary<string, object> { { "saved", paths[id] } };
            }
            if (!Path.IsPathRooted(path)) throw new ArgumentException("path는 전체 경로여야 합니다");
            path = Path.GetFullPath(path);
            if (File.Exists(path) && !Flag(a, "overwrite", false)) throw new IOException("이미 있는 파일입니다: " + path + ". 덮어쓰려면 overwrite를 true로");
            string dir = Path.GetDirectoryName(path);
            if (!Directory.Exists(dir)) throw new DirectoryNotFoundException("폴더가 없습니다: " + dir);
            if (attached.Contains(id))
            {
                // 사용자의 Excel에서 잡은 문서는 SaveAs를 하면 사용자 창의 파일 이름이 바뀐다. 복사본만 저장한다 (같은 형식만).
                if (!string.Equals(Path.GetExtension(path), Path.GetExtension((string)wb.Name), StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("사용자의 Excel 문서는 같은 형식(" + Path.GetExtension((string)wb.Name) + ")으로만 다른 이름 저장(사본)을 할 수 있습니다");
                wb.SaveCopyAs(path);
                log("사본을 저장했습니다: " + path);
                return new Dictionary<string, object> { { "saved", path } };
            }
            wb.SaveAs(Filename: path, FileFormat: FormatOf(path));
            paths[id] = path;
            log("저장했습니다: " + path);
            return new Dictionary<string, object> { { "saved", path } };
        }

        private object Close(Dictionary<string, object> a)
        {
            dynamic wb = Book(a);
            string id = Text(a, "workbook");
            // 사용자의 Excel에서 잡은 문서는 닫지 않고 놓기만 한다.
            bool user = attached.Remove(id);
            if (!user) wb.Close(SaveChanges: false);
            Release((object)wb);
            books.Remove(id);
            paths.Remove(id);
            return new Dictionary<string, object> { { "closed", id }, { "note", user ? "사용자의 Excel 문서라 닫지 않고 놓기만 했습니다" : "" } };
        }

        /// <summary>사용자가 띄운 Excel. 없으면 null</summary>
        private static dynamic UserExcel()
        {
            try
            {
                return Marshal.GetActiveObject("Excel.Application");
            }
            catch (COMException)
            {
                return null;
            }
        }

        /// <summary>이 도구가 따로 연 문서인지 (사용자의 문서와 섞지 않는다)</summary>
        private bool Mine(string fullName)
        {
            foreach (var kv in books)
            {
                if (attached.Contains(kv.Key)) continue;
                if (string.Equals(paths[kv.Key], fullName, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>이미 잡은 사용자 문서의 번호. 없으면 ""</summary>
        private string Held(string fullName)
        {
            foreach (var kv in books)
            {
                if (attached.Contains(kv.Key) && string.Equals(paths[kv.Key], fullName, StringComparison.OrdinalIgnoreCase)) return kv.Key;
            }
            return "";
        }

        /// <summary>사용자의 Excel에 열려 있는 문서들. 이 도구가 따로 연 문서는 뺀다.</summary>
        private List<Dictionary<string, object>> UserBooks(List<object> objects)
        {
            var list = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            // Excel 창이 여러 개여도 모든 문서가 보이는 실행 중인 개체 테이블을 먼저 보고, 거기 없으면 실행 중인 Excel 하나를 본다.
            var candidates = new List<object>();
            foreach (var kv in Rot.Workbooks()) candidates.Add(kv.Value);
            dynamic user = UserExcel();
            if (user != null)
            {
                foreach (dynamic wb in user.Workbooks) candidates.Add((object)wb);
            }
            foreach (object o in candidates)
            {
                dynamic wb = o;
                string full;
                try
                {
                    full = (string)wb.FullName;
                    if (wb.Worksheets == null) continue;
                }
                catch
                {
                    continue; // 엑셀 문서가 아닌 등록 항목
                }
                if (!seen.Add(full) || Mine(full)) continue;
                list.Add(new Dictionary<string, object>
                {
                    { "name", (string)wb.Name },
                    { "full_name", full },
                    { "read_only", (bool)wb.ReadOnly },
                    { "workbook", Held(full) },
                });
                objects.Add(o);
            }
            return list;
        }

        private object UserWorkbooks()
        {
            return UserBooks(new List<object>());
        }

        /// <summary>
        /// 사용자의 Excel에 이미 열린 문서를 잡는다. 사내 문서 공유망(EDM)의 읽기·편집 버튼처럼 링크를 눌러 Excel이 문서를 연 경우에 쓴다.
        /// name이 있으면 이름이나 주소에 그 글자가 든 문서, 없으면 아직 잡지 않은 문서가 하나일 때 그 문서. wait_sec 동안 열리기를 기다린다.
        /// </summary>
        private object Attach(Dictionary<string, object> a)
        {
            string match = Text(a, "name");
            int wait = Math.Min(600, Math.Max(0, Number(a, "wait_sec", 0)));
            DateTime end = DateTime.Now.AddSeconds(wait);
            for (;;)
            {
                var objects = new List<object>();
                var list = UserBooks(objects);
                var found = new List<int>();
                for (int i = 0; i < list.Count; i++)
                {
                    if ((string)list[i]["workbook"] != "") continue;
                    string name = (string)list[i]["name"];
                    string full = (string)list[i]["full_name"];
                    if (match == null || name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0 || full.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) found.Add(i);
                }
                if (found.Count > 1 && match == null)
                {
                    var names = new List<string>();
                    foreach (int i in found) names.Add((string)list[i]["name"]);
                    throw new InvalidOperationException("Excel에 문서가 여러 개 열려 있습니다: " + string.Join(", ", names) + ". name으로 고르세요");
                }
                if (found.Count > 0)
                {
                    // 같은 글자가 든 문서가 여럿이면 가장 나중에 열린 것
                    int pick = found[found.Count - 1];
                    dynamic wb = objects[pick];
                    string id = "wb" + next++;
                    books[id] = wb;
                    paths[id] = (string)list[pick]["full_name"];
                    attached.Add(id);
                    log("사용자의 Excel 문서를 잡았습니다: " + paths[id]);
                    return new Dictionary<string, object>
                    {
                        { "workbook", id },
                        { "name", (string)wb.Name },
                        { "path", paths[id] },
                        { "read_only", (bool)wb.ReadOnly },
                        { "attached", true },
                        { "sheets", Sheets(wb) },
                    };
                }
                if (DateTime.Now >= end)
                {
                    string what = match == null ? "새로 열린 문서" : "\"" + match + "\"이(가) 든 문서";
                    throw new InvalidOperationException(list.Count == 0
                        ? "열려 있는 Excel이 없습니다. 문서 공유망에서 읽기·편집을 눌러 문서를 연 뒤 다시 하세요"
                        : "Excel에서 " + what + "를 찾지 못했습니다");
                }
                Thread.Sleep(1000);
            }
        }

        private static void Release(object com)
        {
            try
            {
                if (com != null && Marshal.IsComObject(com)) Marshal.FinalReleaseComObject(com);
            }
            catch
            {
                // 이미 풀린 객체
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            foreach (var kv in books)
            {
                // 사용자의 Excel에서 잡은 문서는 닫지 않는다.
                if (!attached.Contains(kv.Key))
                {
                    try { kv.Value.Close(SaveChanges: false); } catch { }
                }
                Release((object)kv.Value);
            }
            books.Clear();
            if (app != null)
            {
                try { app.Quit(); } catch { }
                Release((object)app);
                app = null;
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
    }
}
