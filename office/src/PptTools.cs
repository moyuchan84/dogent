using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Dogent.Office
{
    /// <summary>사용자의 PowerPoint로 발표 자료를 열고, 읽고(슬라이드 글·표·메모), 쓰고(슬라이드 덧붙이기·찾아 바꾸기), 저장한다.</summary>
    internal sealed class PptTools : DocTools
    {
        private const int DefaultMaxSlides = 200;

        public PptTools(Action<string> log) : base(log) { }

        public override string Prefix { get { return "ppt"; } }
        protected override string HandlePrefix { get { return "pp"; } }
        protected override string ProgId { get { return "PowerPoint.Application"; } }
        protected override string Label { get { return "PowerPoint"; } }

        protected override bool RotName(string lower)
        {
            if (lower.StartsWith("!")) return false;
            return lower.Contains(".ppt") || lower.Contains(".pot") || lower.Contains(".pps") || lower.StartsWith("http");
        }

        protected override bool IsDoc(dynamic obj)
        {
            return obj.Slides != null;
        }

        protected override dynamic Collection(dynamic application)
        {
            return application.Presentations;
        }

        protected override void Prepare(dynamic application)
        {
            // PowerPoint는 창을 숨길 수 없다(Visible=false는 오류). 문서를 창 없이 여는 것으로 대신한다.
            application.DisplayAlerts = 1; // ppAlertsNone
        }

        private static int WithWindow
        {
            get { return Environment.GetEnvironmentVariable("DOGENT_OFFICE_VISIBLE") == "1" ? -1 : 0; }
        }

        protected override dynamic OpenDoc(dynamic application, string path, bool readOnly, string password)
        {
            // 암호는 파일 이름 뒤에 "::암호::"를 붙여 준다 (PowerPoint의 방식)
            string name = password == null ? path : path + "::" + password + "::";
            return application.Presentations.Open(FileName: name, ReadOnly: readOnly ? -1 : 0, Untitled: 0, WithWindow: WithWindow);
        }

        protected override dynamic NewDoc(dynamic application)
        {
            return application.Presentations.Add(WithWindow);
        }

        protected override object Summary(dynamic doc)
        {
            return new Dictionary<string, object> { { "slides", (int)doc.Slides.Count } };
        }

        private static string ShapeText(dynamic shape)
        {
            try
            {
                if (!Truthy(shape.HasTextFrame)) return "";
                if (!Truthy(shape.TextFrame.HasText)) return "";
                return Convert.ToString(shape.TextFrame.TextRange.Text).Replace("\r", "\n").Trim();
            }
            catch
            {
                return "";
            }
        }

        private static string TitleOf(dynamic slide)
        {
            try
            {
                if (Truthy(slide.Shapes.HasTitle)) return ShapeText(slide.Shapes.Title);
            }
            catch { }
            return "";
        }

        private static string NotesOf(dynamic slide)
        {
            try
            {
                foreach (dynamic s in slide.NotesPage.Shapes)
                {
                    // 메모는 본문 자리표시자(ppPlaceholderBody = 2)에 있다
                    if ((int)s.Type == 14 && (int)s.PlaceholderFormat.Type == 2) return ShapeText(s);
                }
            }
            catch { }
            return "";
        }

        protected override object ReadDoc(dynamic doc, Dictionary<string, object> a)
        {
            int maxSlides = Math.Max(1, Number(a, "max_slides", DefaultMaxSlides));
            bool withNotes = Flag(a, "notes", true);
            int total = (int)doc.Slides.Count;
            var slides = new List<object>();
            for (int i = 1; i <= total && slides.Count < maxSlides; i++)
            {
                dynamic slide = doc.Slides.Item(i);
                string title = TitleOf(slide);
                var texts = new List<object>();
                var tables = new List<object>();
                foreach (dynamic shape in slide.Shapes)
                {
                    bool isTable = false;
                    try { isTable = Truthy(shape.HasTable); } catch { }
                    if (isTable)
                    {
                        tables.Add(ReadTable(shape.Table));
                        continue;
                    }
                    string text = ShapeText(shape);
                    if (text.Length == 0 || text == title) continue;
                    texts.Add(text);
                }
                var item = new Dictionary<string, object> { { "index", i }, { "title", title }, { "texts", texts }, { "tables", tables } };
                if (withNotes) item["notes"] = NotesOf(slide);
                slides.Add(item);
            }
            return new Dictionary<string, object> { { "name", (string)doc.Name }, { "total_slides", total }, { "slides", slides } };
        }

        private static object ReadTable(dynamic table)
        {
            int rowsN = (int)table.Rows.Count, colsN = (int)table.Columns.Count;
            Func<int, int, string> cell = delegate(int r, int c)
            {
                try { return Convert.ToString(table.Cell(r, c).Shape.TextFrame.TextRange.Text).Replace("\r", "\n").Trim(); }
                catch { return ""; }
            };
            var columns = new List<string>();
            for (int c = 1; c <= colsN; c++)
            {
                string name = cell(1, c);
                columns.Add(name.Length == 0 ? "열" + c : name);
            }
            var rows = new List<object>();
            for (int r = 2; r <= rowsN; r++)
            {
                var row = new object[colsN];
                for (int c = 1; c <= colsN; c++) row[c - 1] = cell(r, c);
                rows.Add(row);
            }
            return new Dictionary<string, object> { { "columns", columns }, { "rows", rows } };
        }

        protected override object WriteDoc(dynamic doc, Dictionary<string, object> a)
        {
            if (Truthy(doc.ReadOnly)) throw new InvalidOperationException("읽기 전용으로 연 문서입니다. read_only를 false로 다시 열거나 다른 이름으로 저장할 사본을 쓰세요");
            int replaced = 0, added = 0;

            var replace = Arr(Program.Get(a, "replace"));
            if (replace != null)
            {
                foreach (object o in replace)
                {
                    var r = Obj(o);
                    string find = r == null ? null : Text(r, "find");
                    string with = r == null ? null : (Text(r, "with") ?? "");
                    if (string.IsNullOrEmpty(find)) throw new ArgumentException("replace의 각 항목에는 find가 있어야 합니다");
                    int total = (int)doc.Slides.Count;
                    for (int i = 1; i <= total; i++)
                    {
                        foreach (dynamic shape in doc.Slides.Item(i).Shapes)
                        {
                            if (!HasText(shape)) continue;
                            // TextRange.Replace는 처음 한 곳만 바꾸므로 더 없을 때까지 되풀이한다 (바꿀 글에 찾는 글이 들어 있어도 끝나도록 상한을 둔다)
                            for (int guard = 0; guard < 500; guard++)
                            {
                                dynamic hit = shape.TextFrame.TextRange.Replace(FindWhat: find, ReplaceWhat: with, MatchCase: 0);
                                if (hit == null) break;
                                replaced++;
                            }
                        }
                    }
                }
            }

            var slides = Arr(Program.Get(a, "slides"));
            if (slides != null)
            {
                foreach (object o in slides)
                {
                    var spec = Obj(o);
                    if (spec == null) throw new ArgumentException("slides의 각 항목은 {title, bullets, notes, table} 객체여야 합니다");
                    AddSlide(doc, spec);
                    added++;
                }
            }

            // 기존 슬라이드의 메모 고치기: [{slide, text}]
            var notes = Arr(Program.Get(a, "notes"));
            int notesSet = 0;
            if (notes != null)
            {
                foreach (object o in notes)
                {
                    var n = Obj(o);
                    if (n == null) continue;
                    int idx = Number(n, "slide", 0);
                    if (idx < 1 || idx > (int)doc.Slides.Count) throw new ArgumentException("notes의 slide 번호가 범위 밖입니다: " + idx);
                    SetNotes(doc.Slides.Item(idx), Text(n, "text") ?? "");
                    notesSet++;
                }
            }

            return new Dictionary<string, object>
            {
                { "replaced", replaced },
                { "added_slides", added },
                { "notes_set", notesSet },
                { "slides", (int)doc.Slides.Count },
            };
        }

        private static bool HasText(dynamic shape)
        {
            try { return Truthy(shape.HasTextFrame) && Truthy(shape.TextFrame.HasText); }
            catch { return false; }
        }

        private static void SetNotes(dynamic slide, string text)
        {
            foreach (dynamic s in slide.NotesPage.Shapes)
            {
                if ((int)s.Type == 14 && (int)s.PlaceholderFormat.Type == 2)
                {
                    s.TextFrame.TextRange.Text = text;
                    return;
                }
            }
            throw new InvalidOperationException("이 슬라이드에는 메모 칸이 없습니다");
        }

        private static void AddSlide(dynamic doc, Dictionary<string, object> spec)
        {
            string title = Text(spec, "title") ?? "";
            var bullets = Arr(Program.Get(spec, "bullets"));
            var table = Obj(Program.Get(spec, "table"));
            // 제목과 내용(2), 제목만(11)
            int layout = (bullets != null && bullets.Length > 0 && table == null) ? 2 : 11;
            dynamic slide = doc.Slides.Add((int)doc.Slides.Count + 1, layout);
            if (title.Length > 0)
            {
                try { slide.Shapes.Title.TextFrame.TextRange.Text = title; }
                catch { slide.Shapes.AddTextbox(1, 40, 20, 640, 50).TextFrame.TextRange.Text = title; }
            }
            if (layout == 2)
            {
                var lines = new List<string>();
                foreach (object b in bullets) lines.Add(Convert.ToString(b, CultureInfo.InvariantCulture) ?? "");
                string joined = string.Join("\r", lines.ToArray());
                bool placed = false;
                foreach (dynamic s in slide.Shapes)
                {
                    // 제목이 아닌 첫 글 칸(본문 자리표시자)에 넣는다
                    bool isTitle = false;
                    try { isTitle = (int)s.PlaceholderFormat.Type == 1 || (int)s.PlaceholderFormat.Type == 3; } catch { }
                    if (isTitle || !HasFrame(s)) continue;
                    s.TextFrame.TextRange.Text = joined;
                    placed = true;
                    break;
                }
                if (!placed) slide.Shapes.AddTextbox(1, 40, 90, 640, 380).TextFrame.TextRange.Text = joined;
            }
            if (table != null) AddTable(doc, slide, table);
            string notes = Text(spec, "notes");
            if (!string.IsNullOrEmpty(notes)) SetNotes(slide, notes);
        }

        private static bool HasFrame(dynamic shape)
        {
            try { return Truthy(shape.HasTextFrame); }
            catch { return false; }
        }

        private static void AddTable(dynamic doc, dynamic slide, Dictionary<string, object> spec)
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
            if (lines.Count == 0) return;
            int width = 1;
            foreach (var l in lines) width = Math.Max(width, l.Length);
            float slideW = Convert.ToSingle(doc.PageSetup.SlideWidth), slideH = Convert.ToSingle(doc.PageSetup.SlideHeight);
            dynamic shape = slide.Shapes.AddTable(lines.Count, width, 40, 100, slideW - 80, Math.Min(slideH - 140, 30 * lines.Count));
            for (int r = 0; r < lines.Count; r++)
                for (int c = 0; c < lines[r].Length; c++)
                    shape.Table.Cell(r + 1, c + 1).Shape.TextFrame.TextRange.Text = Convert.ToString(lines[r][c], CultureInfo.InvariantCulture) ?? "";
        }

        protected override void SaveTo(dynamic doc, string path, bool isAttached)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            int format;
            switch (ext)
            {
                case ".pptx": format = 24; break;  // ppSaveAsOpenXMLPresentation
                case ".pptm": format = 25; break;
                case ".ppt": format = 1; break;
                case ".pdf": format = 32; break;
                default: throw new ArgumentException("저장할 수 있는 형식은 .pptx, .pptm, .ppt, .pdf 입니다: " + path);
            }
            // 사용자 창의 문서는 이름이 바뀌지 않도록 사본으로 저장한다.
            if (isAttached) doc.SaveCopyAs(path, format);
            else doc.SaveAs(path, format);
        }

        protected override void CloseDoc(dynamic doc)
        {
            try { doc.Saved = -1; } catch { } // 저장하지 않고 닫아도 묻지 않게
            doc.Close();
        }
    }
}
