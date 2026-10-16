using System;
using System.Runtime.InteropServices;

namespace Dogent.Office
{
    /// <summary>
    /// Excel이 바쁠 때(문서를 여는 중, 사용자가 칸을 편집 중) 들어온 호출을 거절하면(RPC_E_CALL_REJECTED)
    /// 실패로 끝내지 않고 잠시 뒤 다시 부른다. COM 자동화에서 쓰는 표준 방법이다.
    /// </summary>
    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleMessageFilter
    {
        [PreserveSig]
        int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);

        [PreserveSig]
        int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);

        [PreserveSig]
        int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
    }

    internal sealed class MessageFilter : IOleMessageFilter
    {
        /// <summary>이 시간 동안 다시 부르고, 넘으면 실패로 돌려준다.</summary>
        private const int GiveUpMs = 60000;
        private const int SERVERCALL_RETRYLATER = 2;

        [DllImport("ole32.dll")]
        private static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);

        public static void Register()
        {
            IOleMessageFilter old;
            CoRegisterMessageFilter(new MessageFilter(), out old);
        }

        public int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo)
        {
            return 0; // SERVERCALL_ISHANDLED
        }

        public int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType)
        {
            // 0.2초 뒤 다시 부른다. -1이면 포기.
            if (dwRejectType == SERVERCALL_RETRYLATER && dwTickCount < GiveUpMs) return 200;
            return -1;
        }

        public int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType)
        {
            return 2; // PENDINGMSG_WAITDEFPROCESS
        }
    }
}
