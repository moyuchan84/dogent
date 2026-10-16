using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace Dogent.Office
{
    /// <summary>
    /// 실행 중인 개체 테이블(ROT)에서 열린 엑셀 문서를 찾는다.
    /// Excel은 연 문서를 경로나 주소로 ROT에 등록한다. Excel 창이 여러 개(여러 프로세스)여도 모두 보인다.
    /// GetActiveObject("Excel.Application")는 그중 하나만 주므로, 사용자가 연 문서를 찾을 때는 이것을 쓴다.
    /// </summary>
    internal static class Rot
    {
        [DllImport("ole32.dll")]
        private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable rot);

        [DllImport("ole32.dll")]
        private static extern int CreateBindCtx(int reserved, out IBindCtx ctx);

        /// <summary>열린 통합 문서들 (경로나 주소, 문서 개체). 엑셀 문서가 아닌 항목은 뺀다.</summary>
        public static List<KeyValuePair<string, object>> Workbooks()
        {
            var found = new List<KeyValuePair<string, object>>();
            IRunningObjectTable rot;
            IBindCtx ctx;
            if (GetRunningObjectTable(0, out rot) != 0 || CreateBindCtx(0, out ctx) != 0) return found;
            IEnumMoniker monikers;
            rot.EnumRunning(out monikers);
            var one = new IMoniker[1];
            while (monikers.Next(1, one, IntPtr.Zero) == 0)
            {
                string name;
                try
                {
                    one[0].GetDisplayName(ctx, null, out name);
                }
                catch
                {
                    continue;
                }
                if (name == null || !LooksLikeWorkbook(name)) continue;
                object obj;
                if (rot.GetObject(one[0], out obj) != 0 || obj == null) continue;
                found.Add(new KeyValuePair<string, object>(name, obj));
            }
            return found;
        }

        private static bool LooksLikeWorkbook(string name)
        {
            string n = name.ToLowerInvariant();
            // 경로나 주소로 등록된 문서만. Excel 자신은 !{클래스 ID}로 등록된다.
            if (n.StartsWith("!")) return false;
            return n.Contains(".xls") || n.Contains(".csv") || n.StartsWith("http");
        }
    }
}
