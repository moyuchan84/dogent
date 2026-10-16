// dogent-office: Excel을 COM으로 다루는 MCP 서버 (stdio, 한 줄에 JSON-RPC 메시지 하나).
//
// 문서 보안(NASCA)이 걸린 파일은 라이브러리로 직접 열 수 없고, 권한 있는 사용자의 Excel이 열어야 한다 (docs/09 D5).
// 그래서 이 도구는 사용자의 Excel을 띄워 열고, 읽고, 쓰고, Excel로 저장한다.
//
// 윈도우에 기본으로 있는 C# 컴파일러(.NET Framework 4.x, C# 5)로도 빌드되도록 C# 5 문법만 쓴다.
// Excel은 늦은 바인딩(dynamic)으로 부르므로 Interop DLL이 필요 없다.
//
// stdout은 MCP가 쓰므로 기록은 stderr로만 낸다.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Dogent.Office
{
    internal static class Program
    {
        private const string Version = "0.1.0";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };

        [STAThread]
        private static int Main(string[] args)
        {
            var utf8 = new UTF8Encoding(false);
            Console.InputEncoding = utf8;
            Console.OutputEncoding = utf8;
            var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
            var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8);
            stdout.AutoFlush = true;

            if (args.Length > 0 && (args[0] == "--version" || args[0] == "-v"))
            {
                stdout.WriteLine("dogent-office " + Version);
                return 0;
            }

            // Excel이 바빠 호출을 거절하면 잠시 뒤 다시 부른다.
            MessageFilter.Register();
            var excel = new ExcelTools(Log);
            AppDomain.CurrentDomain.ProcessExit += delegate { excel.Dispose(); };
            Log("대기 중 (stdio). Excel은 처음 도구를 부를 때 띄웁니다");
            try
            {
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    string reply = Handle(excel, line);
                    if (reply != null) stdout.WriteLine(reply);
                }
            }
            finally
            {
                excel.Dispose();
            }
            return 0;
        }

        internal static void Log(string message)
        {
            Console.Error.WriteLine("[dogent-office] " + message);
        }

        /// <summary>JSON-RPC 요청 하나를 처리한다. 알림(id 없음)이면 null.</summary>
        private static string Handle(ExcelTools excel, string line)
        {
            Dictionary<string, object> req;
            try
            {
                req = Json.DeserializeObject(line) as Dictionary<string, object>;
            }
            catch (Exception e)
            {
                return Error(null, -32700, "JSON 형식 오류: " + e.Message);
            }
            if (req == null) return Error(null, -32600, "요청은 JSON 객체여야 합니다");
            object id;
            if (!req.TryGetValue("id", out id) || id == null) return null;
            string method = Str(req, "method");
            var prms = Get(req, "params") as Dictionary<string, object> ?? new Dictionary<string, object>();
            switch (method)
            {
                case "initialize":
                    return Result(id, new Dictionary<string, object>
                    {
                        { "protocolVersion", Str(prms, "protocolVersion") ?? "2025-06-18" },
                        { "capabilities", new Dictionary<string, object> { { "tools", new Dictionary<string, object>() } } },
                        { "serverInfo", new Dictionary<string, object> { { "name", "dogent-office" }, { "version", Version } } },
                        { "instructions", "사용자의 Excel로 엑셀 문서를 열고 읽고 쓰고 저장한다. 문서 보안(NASCA)이 걸린 문서도 사용자의 Excel이 열 수 있으면 다룰 수 있다. excel_open으로 연 뒤 받은 workbook 번호로 다른 도구를 부른다." },
                    });
                case "ping":
                    return Result(id, new Dictionary<string, object>());
                case "tools/list":
                    return Result(id, new Dictionary<string, object> { { "tools", ToolList.All() } });
                case "tools/call":
                    {
                        string name = Str(prms, "name");
                        var toolArgs = Get(prms, "arguments") as Dictionary<string, object> ?? new Dictionary<string, object>();
                        try
                        {
                            object result = excel.Call(name, toolArgs);
                            return Result(id, ToolResult(Json.Serialize(result), false));
                        }
                        catch (Exception e)
                        {
                            Exception inner = e;
                            while (inner.InnerException != null) inner = inner.InnerException;
                            Log(name + " 실패: " + inner.GetType().Name + ": " + inner.Message + Environment.NewLine + inner.StackTrace);
                            return Result(id, ToolResult(inner.Message, true));
                        }
                    }
                default:
                    return Error(id, -32601, "지원하지 않는 메서드: " + method);
            }
        }

        private static Dictionary<string, object> ToolResult(string text, bool isError)
        {
            var content = new object[] { new Dictionary<string, object> { { "type", "text" }, { "text", text } } };
            var r = new Dictionary<string, object> { { "content", content } };
            if (isError) r["isError"] = true;
            return r;
        }

        private static string Result(object id, object result)
        {
            return Json.Serialize(new Dictionary<string, object> { { "jsonrpc", "2.0" }, { "id", id }, { "result", result } });
        }

        private static string Error(object id, int code, string message)
        {
            return Json.Serialize(new Dictionary<string, object>
            {
                { "jsonrpc", "2.0" },
                { "id", id },
                { "error", new Dictionary<string, object> { { "code", code }, { "message", message } } },
            });
        }

        internal static object Get(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) ? v : null;
        }

        internal static string Str(Dictionary<string, object> d, string key)
        {
            object v = Get(d, key);
            return v == null ? null : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }
    }
}
