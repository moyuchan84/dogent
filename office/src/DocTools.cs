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
    /// Word·PowerPoint 같은 문서 프로그램을 COM으로 다루는 공통 부분: 열기, 새로 만들기, 저장, 닫기, 사용자가 연 문서 잡기.
    /// 읽기·쓰기처럼 프로그램마다 다른 일은 하위 클래스가 한다. 사용자가 띄운 프로그램은 건드리지 않도록 이 도구 전용으로 따로 띄운다.
    /// </summary>
    internal abstract class DocTools : IDisposable
    {
        protected readonly Action<string> log;
        protected readonly Dictionary<string, dynamic> docs = new Dictionary<string, dynamic>();
        protected readonly Dictionary<string, string> paths = new Dictionary<string, string>();
        /// <summary>사용자의 프로그램에 이미 열려 있던 문서. 닫지도, 프로그램을 끝내지도 않는다.</summary>
        protected readonly HashSet<string> attached = new HashSet<string>();
        private dynamic app;
        private int next = 1;
        private bool disposed;

        protected DocTools(Action<string> log)
        {
            this.log = log;
        }

        /// <summary>도구 이름 앞부분 (word, ppt)</summary>
        public abstract string Prefix { get; }
        /// <summary>핸들 앞글자 (wd, pp)</summary>
        protected abstract string HandlePrefix { get; }
        protected abstract string ProgId { get; }
        protected abstract string Label { get; }
        /// <summary>ROT에 등록된 이름(소문자)이 이 프로그램의 문서인지</summary>
        protected abstract bool RotName(string lower);
        /// <summary>ROT에서 얻은 개체가 이 프로그램의 문서인지</summary>
        protected abstract bool IsDoc(dynamic obj);
        protected abstract dynamic Collection(dynamic application);
        protected abstract dynamic OpenDoc(dynamic application, string path, bool readOnly, string password);
        protected abstract dynamic NewDoc(dynamic application);
        protected abstract void Prepare(dynamic application);
        protected abstract object Summary(dynamic doc);
        protected abstract object ReadDoc(dynamic doc, Dictionary<string, object> a);
        protected abstract object WriteDoc(dynamic doc, Dictionary<string, object> a);
        /// <summary>다른 이름으로 저장. 사용자 창의 문서면 이름이 바뀌지 않는 방법으로 해야 한다.</summary>
        protected abstract void SaveTo(dynamic doc, string path, bool isAttached);
        protected abstract void CloseDoc(dynamic doc);

        protected dynamic App
        {
            get
            {
                if (app != null) return app;
                Type type = Type.GetTypeFromProgID(ProgId);
                if (type == null) throw new InvalidOperationException("이 PC에 " + Label + "이(가) 없습니다. " + Label + "이(가) 설치된 PC에서 실행하세요");
                app = Activator.CreateInstance(type);
                Prepare(app);
                log(Label + " " + Convert.ToString(app.Version) + "을(를) 띄웠습니다");
                return app;
            }
        }

        public object Call(string name, Dictionary<string, object> a)
        {
            string op = name.Substring(Prefix.Length + 1);
            switch (op)
            {
                case "open": return Open(a);
                case "new": return New();
                case "list": return List();
                case "read": return ReadDoc(Doc(a), a);
                case "write": return WriteDoc(Doc(a), a);
                case "save": return Save(a);
                case "close": return Close(a);
                case "user_docs": return UserDocs();
                case "attach": return Attach(a);
                default: throw new ArgumentException("모르는 도구: " + name);
            }
        }

        // ----- 인자 읽기 -----
        protected static string Text(Dictionary<string, object> a, string key)
        {
            return Program.Str(a, key);
        }

        protected static bool Flag(Dictionary<string, object> a, string key, bool fallback)
        {
            object v = Program.Get(a, key);
            return v is bool ? (bool)v : fallback;
        }

        protected static int Number(Dictionary<string, object> a, string key, int fallback)
        {
            object v = Program.Get(a, key);
            if (v == null) return fallback;
            return Convert.ToInt32(v, CultureInfo.InvariantCulture);
        }

        /// <summary>COM의 참/거짓 (bool 또는 MsoTriState -1/0)</summary>
        protected static bool Truthy(object v)
        {
            if (v is bool) return (bool)v;
            if (v == null) return false;
            return Convert.ToInt32(v, CultureInfo.InvariantCulture) != 0;
        }

        protected static Dictionary<string, object> Obj(object v)
        {
            return v as Dictionary<string, object>;
        }

        protected static object[] Arr(object v)
        {
            return v as object[];
        }

        protected dynamic Doc(Dictionary<string, object> a)
        {
            string id = Text(a, "doc");
            dynamic d;
            if (id == null || !docs.TryGetValue(id, out d)) throw new ArgumentException("열린 문서 \"" + id + "\"이(가) 없습니다. " + Prefix + "_open으로 먼저 여세요");
            return d;
        }

        // ----- 열기·새로 만들기·목록 -----
        private object Register(dynamic d, string path)
        {
            string id = HandlePrefix + next++;
            docs[id] = d;
            paths[id] = path;
            var r = new Dictionary<string, object> { { "doc", id }, { "name", (string)d.Name }, { "path", path ?? "" } };
            var sum = Summary(d) as Dictionary<string, object>;
            if (sum != null) foreach (var kv in sum) r[kv.Key] = kv.Value;
            return r;
        }

        private object Open(Dictionary<string, object> a)
        {
            string path = Text(a, "path");
            bool url = path != null && Regex.IsMatch(path, "^https?://", RegexOptions.IgnoreCase);
            if (!url)
            {
                if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) throw new ArgumentException("path는 전체 경로나 http(s) 주소여야 합니다 (예: D:\\자료\\보고서.docx)");
                path = Path.GetFullPath(path);
                if (!File.Exists(path)) throw new FileNotFoundException("파일이 없습니다: " + path);
            }
            dynamic d = OpenDoc(App, path, Flag(a, "read_only", true), Text(a, "password"));
            log("열었습니다: " + path);
            return Register(d, path);
        }

        private object New()
        {
            return Register(NewDoc(App), null);
        }

        private object List()
        {
            var list = new List<object>();
            foreach (var kv in docs)
            {
                list.Add(new Dictionary<string, object> { { "doc", kv.Key }, { "name", (string)kv.Value.Name }, { "path", paths[kv.Key] ?? "" } });
            }
            return list;
        }

        // ----- 저장·닫기 -----
        private object Save(Dictionary<string, object> a)
        {
            dynamic d = Doc(a);
            string id = Text(a, "doc");
            string path = Text(a, "path");
            if (string.IsNullOrEmpty(path))
            {
                if (paths[id] == null) throw new ArgumentException("새 문서는 path를 주어야 저장할 수 있습니다");
                if (Truthy(d.ReadOnly)) throw new InvalidOperationException("읽기 전용으로 연 문서입니다. path를 주어 다른 이름으로 저장하세요");
                d.Save();
                return new Dictionary<string, object> { { "saved", paths[id] } };
            }
            if (!Path.IsPathRooted(path)) throw new ArgumentException("path는 전체 경로여야 합니다");
            path = Path.GetFullPath(path);
            if (File.Exists(path) && !Flag(a, "overwrite", false)) throw new IOException("이미 있는 파일입니다: " + path + ". 덮어쓰려면 overwrite를 true로");
            string dir = Path.GetDirectoryName(path);
            if (!Directory.Exists(dir)) throw new DirectoryNotFoundException("폴더가 없습니다: " + dir);
            bool isAttached = attached.Contains(id);
            SaveTo(d, path, isAttached);
            if (!isAttached) paths[id] = path;
            log((isAttached ? "사본을 저장했습니다: " : "저장했습니다: ") + path);
            return new Dictionary<string, object> { { "saved", path } };
        }

        private object Close(Dictionary<string, object> a)
        {
            dynamic d = Doc(a);
            string id = Text(a, "doc");
            // 사용자의 프로그램에서 잡은 문서는 닫지 않고 놓기만 한다.
            bool user = attached.Remove(id);
            if (!user) CloseDoc(d);
            Release((object)d);
            docs.Remove(id);
            paths.Remove(id);
            return new Dictionary<string, object> { { "closed", id }, { "note", user ? "사용자의 " + Label + " 문서라 닫지 않고 놓기만 했습니다" : "" } };
        }

        // ----- 사용자가 연 문서 -----
        private dynamic UserApp()
        {
            try
            {
                return Marshal.GetActiveObject(ProgId);
            }
            catch (COMException)
            {
                return null;
            }
        }

        private bool Mine(string fullName)
        {
            foreach (var kv in docs)
            {
                if (attached.Contains(kv.Key)) continue;
                if (string.Equals(paths[kv.Key], fullName, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private string Held(string fullName)
        {
            foreach (var kv in docs)
            {
                if (attached.Contains(kv.Key) && string.Equals(paths[kv.Key], fullName, StringComparison.OrdinalIgnoreCase)) return kv.Key;
            }
            return "";
        }

        private List<Dictionary<string, object>> UserBooks(List<object> objects)
        {
            var list = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var candidates = new List<object>();
            foreach (var kv in Rot.Items(RotName)) candidates.Add(kv.Value);
            dynamic user = UserApp();
            if (user != null)
            {
                foreach (dynamic d in Collection(user)) candidates.Add((object)d);
            }
            foreach (object o in candidates)
            {
                dynamic d = o;
                string full;
                try
                {
                    if (!IsDoc(d)) continue;
                    full = (string)d.FullName;
                }
                catch
                {
                    continue;
                }
                if (!seen.Add(full) || Mine(full)) continue;
                bool ro = false;
                try { ro = Truthy(d.ReadOnly); } catch { }
                list.Add(new Dictionary<string, object>
                {
                    { "name", (string)d.Name },
                    { "full_name", full },
                    { "read_only", ro },
                    { "doc", Held(full) },
                });
                objects.Add(o);
            }
            return list;
        }

        private object UserDocs()
        {
            return UserBooks(new List<object>());
        }

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
                    if ((string)list[i]["doc"] != "") continue;
                    string name = (string)list[i]["name"];
                    string full = (string)list[i]["full_name"];
                    if (match == null || name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0 || full.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) found.Add(i);
                }
                if (found.Count > 1 && match == null)
                {
                    var names = new List<string>();
                    foreach (int i in found) names.Add((string)list[i]["name"]);
                    throw new InvalidOperationException(Label + "에 문서가 여러 개 열려 있습니다: " + string.Join(", ", names) + ". name으로 고르세요");
                }
                if (found.Count > 0)
                {
                    int pick = found[found.Count - 1];
                    dynamic d = objects[pick];
                    string id = HandlePrefix + next++;
                    docs[id] = d;
                    paths[id] = (string)list[pick]["full_name"];
                    attached.Add(id);
                    log("사용자의 " + Label + " 문서를 잡았습니다: " + paths[id]);
                    var r = new Dictionary<string, object>
                    {
                        { "doc", id },
                        { "name", (string)d.Name },
                        { "path", paths[id] },
                        { "read_only", Truthy(d.ReadOnly) },
                        { "attached", true },
                    };
                    var sum = Summary(d) as Dictionary<string, object>;
                    if (sum != null) foreach (var kv in sum) r[kv.Key] = kv.Value;
                    return r;
                }
                if (DateTime.Now >= end)
                {
                    string what = match == null ? "새로 열린 문서" : "\"" + match + "\"이(가) 든 문서";
                    throw new InvalidOperationException(list.Count == 0
                        ? "열려 있는 " + Label + " 문서가 없습니다. 문서를 연 뒤 다시 하세요"
                        : Label + "에서 " + what + "를 찾지 못했습니다");
                }
                Thread.Sleep(1000);
            }
        }

        protected static void Release(object com)
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
            foreach (var kv in docs)
            {
                if (!attached.Contains(kv.Key))
                {
                    try { CloseDoc(kv.Value); } catch { }
                }
                Release((object)kv.Value);
            }
            docs.Clear();
            if (app != null)
            {
                // PowerPoint처럼 이미 실행 중인 프로그램에 붙는 경우가 있다. 사용자의 문서가 남아 있으면 프로그램을 끝내지 않는다.
                bool othersOpen = false;
                try { othersOpen = (int)Collection(app).Count > 0; } catch { }
                if (!othersOpen)
                {
                    try { app.Quit(); } catch { }
                }
                else
                {
                    log(Label + "에 사용자의 문서가 열려 있어 프로그램은 끝내지 않습니다");
                }
                Release((object)app);
                app = null;
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
    }
}
