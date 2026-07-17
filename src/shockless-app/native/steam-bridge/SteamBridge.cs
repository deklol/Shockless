using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class SteamBridge
{
    private const uint InvalidAuthTicket = 0;
    private const int TicketBufferSize = 4096;
    private const int InitialTicketCount = 1;
    private const int MaxOutstandingTickets = 2;
    private const int CommandShutdown = 1;
    private const int CommandIssueTicket = 2;
    private const int CommandRetireSupersededTicket = 3;
    private const int NonceLength = 16;
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("SKSB");

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)]
    private delegate bool SteamApiInitSafe();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void SteamApiShutdown();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void SteamApiRunCallbacks();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate IntPtr SteamApiGetInterface();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)]
    private delegate bool SteamUserLoggedOn(IntPtr steamUser);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate ulong SteamUserGetSteamId(IntPtr steamUser);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint SteamUserGetAuthSessionTicket(
        IntPtr steamUser,
        IntPtr ticketBuffer,
        int ticketBufferSize,
        out uint ticketSize,
        IntPtr networkingIdentity);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void SteamUserCancelAuthTicket(IntPtr steamUser, uint ticketHandle);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate uint SteamUtilsGetAppId(IntPtr steamUtils);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)]
    private delegate bool SteamUtilsIsOverlayEnabled(IntPtr steamUtils);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryW(string fileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string procedureName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(
        IntPtr namedPipe,
        byte[] buffer,
        uint bufferSize,
        IntPtr bytesRead,
        out uint totalBytesAvailable,
        IntPtr bytesLeftThisMessage);

    private static int Main(string[] args)
    {
        string steamApiPath;
        uint expectedAppId;
        string pipeName;
        byte[] nonce;
        if (!TryParseArguments(args, out steamApiPath, out expectedAppId, out pipeName, out nonce)) return 2;
        FreeConsole();

        NamedPipeClientStream pipe = null;
        string previousDirectory = Environment.CurrentDirectory;
        string contextDirectory = Path.Combine(Path.GetTempPath(), "shockless-steam-" + Guid.NewGuid().ToString("N"));
        IntPtr module = IntPtr.Zero;
        IntPtr ticketBuffer = IntPtr.Zero;
        IntPtr steamUser = IntPtr.Zero;
        List<uint> ticketHandles = new List<uint>();
        bool initialized = false;
        SteamApiShutdown shutdown = null;
        SteamUserCancelAuthTicket cancelTicket = null;

        try
        {
            pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None);
            pipe.Connect(5000);
            if (IntPtr.Size != 4) return Fail(pipe, nonce, expectedAppId, 1, 3);
            if (!Path.IsPathRooted(steamApiPath) || !File.Exists(steamApiPath)) return Fail(pipe, nonce, expectedAppId, 2, 4);

            Directory.CreateDirectory(contextDirectory);
            File.WriteAllText(
                Path.Combine(contextDirectory, "steam_appid.txt"),
                expectedAppId.ToString(CultureInfo.InvariantCulture),
                new UTF8Encoding(false));
            Environment.CurrentDirectory = contextDirectory;
            string appIdText = expectedAppId.ToString(CultureInfo.InvariantCulture);
            Environment.SetEnvironmentVariable("SteamAppId", appIdText, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("SteamGameId", appIdText, EnvironmentVariableTarget.Process);

            module = LoadLibraryW(Path.GetFullPath(steamApiPath));
            if (module == IntPtr.Zero) return Fail(pipe, nonce, expectedAppId, 3, 5);

            SteamApiInitSafe initialize = LoadExport<SteamApiInitSafe>(module, "SteamAPI_InitSafe");
            shutdown = LoadExport<SteamApiShutdown>(module, "SteamAPI_Shutdown");
            SteamApiRunCallbacks runCallbacks = LoadExport<SteamApiRunCallbacks>(module, "SteamAPI_RunCallbacks");
            SteamApiGetInterface getSteamUser = LoadVersionedInterface(module, "SteamAPI_SteamUser");
            SteamApiGetInterface getSteamUtils = LoadVersionedInterface(module, "SteamAPI_SteamUtils");
            SteamUserLoggedOn isLoggedOn = LoadExport<SteamUserLoggedOn>(module, "SteamAPI_ISteamUser_BLoggedOn");
            SteamUserGetSteamId getSteamId = LoadExport<SteamUserGetSteamId>(module, "SteamAPI_ISteamUser_GetSteamID");
            SteamUserGetAuthSessionTicket getTicket = LoadExport<SteamUserGetAuthSessionTicket>(module, "SteamAPI_ISteamUser_GetAuthSessionTicket");
            cancelTicket = LoadExport<SteamUserCancelAuthTicket>(module, "SteamAPI_ISteamUser_CancelAuthTicket");
            SteamUtilsGetAppId getAppId = LoadExport<SteamUtilsGetAppId>(module, "SteamAPI_ISteamUtils_GetAppID");
            SteamUtilsIsOverlayEnabled isOverlayEnabled = LoadExport<SteamUtilsIsOverlayEnabled>(module, "SteamAPI_ISteamUtils_IsOverlayEnabled");

            initialized = initialize();
            if (!initialized) return Fail(pipe, nonce, expectedAppId, 4, 6);
            runCallbacks();

            steamUser = getSteamUser();
            IntPtr steamUtils = getSteamUtils();
            if (steamUser == IntPtr.Zero || steamUtils == IntPtr.Zero) return Fail(pipe, nonce, expectedAppId, 5, 7);
            uint actualAppId = getAppId(steamUtils);
            if (actualAppId != expectedAppId) return Fail(pipe, nonce, actualAppId, 6, 8);
            ulong steamId = getSteamId(steamUser);
            if (!isLoggedOn(steamUser) || steamId == 0) return Fail(pipe, nonce, actualAppId, 7, 9);

            ticketBuffer = Marshal.AllocHGlobal(TicketBufferSize);
            bool overlayEnabled = isOverlayEnabled(steamUtils);
            for (int index = 0; index < InitialTicketCount; index++)
            {
                if (!TryIssueTicket(
                    pipe,
                    nonce,
                    actualAppId,
                    steamId,
                    overlayEnabled,
                    steamUser,
                    ticketBuffer,
                    getTicket,
                    cancelTicket,
                    ticketHandles))
                {
                    return Fail(pipe, nonce, actualAppId, 8, 10);
                }
            }

            while (true)
            {
                runCallbacks();
                int command = int.MinValue;
                uint commandBytesAvailable;
                if (!PeekNamedPipe(
                    pipe.SafePipeHandle.DangerousGetHandle(),
                    null,
                    0,
                    IntPtr.Zero,
                    out commandBytesAvailable,
                    IntPtr.Zero))
                {
                    return 11;
                }
                if (commandBytesAvailable > 0) command = pipe.ReadByte();
                if (command < 0 && command != int.MinValue) return 11;
                if (command == CommandShutdown) return 0;
                if (command == CommandIssueTicket)
                {
                    if (ticketHandles.Count >= MaxOutstandingTickets
                        || !TryIssueTicket(
                            pipe,
                            nonce,
                            actualAppId,
                            steamId,
                            isOverlayEnabled(steamUtils),
                            steamUser,
                            ticketBuffer,
                            getTicket,
                            cancelTicket,
                            ticketHandles))
                    {
                        return Fail(pipe, nonce, actualAppId, 8, 10);
                    }
                }
                else if (command == CommandRetireSupersededTicket)
                {
                    if (ticketHandles.Count < 2) return 11;
                    uint supersededHandle = ticketHandles[0];
                    ticketHandles.RemoveAt(0);
                    if (supersededHandle != InvalidAuthTicket)
                    {
                        try { cancelTicket(steamUser, supersededHandle); } catch { return 11; }
                    }
                }
                else if (command != int.MinValue)
                {
                    return 11;
                }
                Thread.Sleep(16);
            }
        }
        catch (EntryPointNotFoundException)
        {
            TryWriteFailure(pipe, nonce, expectedAppId, 9);
            return 12;
        }
        catch
        {
            TryWriteFailure(pipe, nonce, expectedAppId, 10);
            return 13;
        }
        finally
        {
            if (steamUser != IntPtr.Zero && cancelTicket != null)
            {
                foreach (uint ticketHandle in ticketHandles)
                {
                    if (ticketHandle == InvalidAuthTicket) continue;
                    try { cancelTicket(steamUser, ticketHandle); } catch { }
                }
            }
            if (ticketBuffer != IntPtr.Zero)
            {
                ZeroMemory(ticketBuffer, TicketBufferSize);
                Marshal.FreeHGlobal(ticketBuffer);
            }
            if (initialized && shutdown != null)
            {
                try { shutdown(); } catch { }
            }
            if (module != IntPtr.Zero) FreeLibrary(module);
            if (pipe != null) pipe.Dispose();
            Environment.CurrentDirectory = previousDirectory;
            TryDeleteDirectory(contextDirectory);
            if (nonce != null) Array.Clear(nonce, 0, nonce.Length);
        }
    }

    private static int Fail(NamedPipeClientStream pipe, byte[] nonce, uint appId, byte reason, int exitCode)
    {
        WriteFailure(pipe, nonce, appId, reason);
        return exitCode;
    }

    private static bool TryIssueTicket(
        Stream stream,
        byte[] nonce,
        uint appId,
        ulong steamId,
        bool overlayEnabled,
        IntPtr steamUser,
        IntPtr ticketBuffer,
        SteamUserGetAuthSessionTicket getTicket,
        SteamUserCancelAuthTicket cancelTicket,
        List<uint> ticketHandles)
    {
        ZeroMemory(ticketBuffer, TicketBufferSize);
        uint ticketSize;
        uint ticketHandle = getTicket(steamUser, ticketBuffer, TicketBufferSize, out ticketSize, IntPtr.Zero);
        if (ticketHandle == InvalidAuthTicket || ticketSize == 0 || ticketSize > TicketBufferSize || ticketSize > ushort.MaxValue)
        {
            if (ticketHandle != InvalidAuthTicket)
            {
                try { cancelTicket(steamUser, ticketHandle); } catch { }
            }
            return false;
        }

        byte[] ticketBytes = new byte[ticketSize];
        bool retained = false;
        try
        {
            Marshal.Copy(ticketBuffer, ticketBytes, 0, (int)ticketSize);
            WriteCredentials(stream, nonce, appId, steamId, overlayEnabled, ticketBytes);
            ticketHandles.Add(ticketHandle);
            retained = true;
            return true;
        }
        finally
        {
            Array.Clear(ticketBytes, 0, ticketBytes.Length);
            ZeroMemory(ticketBuffer, TicketBufferSize);
            if (!retained)
            {
                try { cancelTicket(steamUser, ticketHandle); } catch { }
            }
        }
    }

    private static void WriteFailure(Stream stream, byte[] nonce, uint appId, byte reason)
    {
        WriteFrame(stream, nonce, 0, reason, appId, 0, false, null);
    }

    private static void TryWriteFailure(Stream stream, byte[] nonce, uint appId, byte reason)
    {
        if (stream == null || nonce == null) return;
        try { WriteFailure(stream, nonce, appId, reason); } catch { }
    }

    private static void WriteCredentials(Stream stream, byte[] nonce, uint appId, ulong steamId, bool overlayEnabled, byte[] ticket)
    {
        WriteFrame(stream, nonce, 1, 0, appId, steamId, overlayEnabled, ticket);
    }

    private static void WriteFrame(Stream stream, byte[] nonce, byte status, byte reason, uint appId, ulong steamId, bool overlayEnabled, byte[] ticket)
    {
        int ticketLength = ticket == null ? 0 : ticket.Length;
        byte[] frame = new byte[38 + ticketLength];
        try
        {
            Buffer.BlockCopy(Magic, 0, frame, 0, Magic.Length);
            frame[4] = 1;
            frame[5] = status;
            Buffer.BlockCopy(nonce, 0, frame, 6, NonceLength);
            frame[22] = reason;
            WriteUInt32(frame, 23, appId);
            WriteUInt64(frame, 27, steamId);
            frame[35] = overlayEnabled ? (byte)1 : (byte)0;
            WriteUInt16(frame, 36, (ushort)ticketLength);
            if (ticketLength > 0) Buffer.BlockCopy(ticket, 0, frame, 38, ticketLength);
            stream.Write(frame, 0, frame.Length);
            stream.Flush();
        }
        finally
        {
            Array.Clear(frame, 0, frame.Length);
        }
    }

    private static T LoadExport<T>(IntPtr module, string name) where T : class
    {
        IntPtr address = GetProcAddress(module, name);
        if (address == IntPtr.Zero) throw new EntryPointNotFoundException(name);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
    }

    private static SteamApiGetInterface LoadVersionedInterface(IntPtr module, string exportPrefix)
    {
        // Steam exports one active interface revision under a zero-padded
        // suffix. Probe newest-to-oldest so the bridge follows the installed
        // Steam API instead of pinning a revision that can change upstream.
        for (int version = 999; version >= 1; version--)
        {
            string exportName = exportPrefix + "_v" + version.ToString("D3", CultureInfo.InvariantCulture);
            IntPtr address = GetProcAddress(module, exportName);
            if (address == IntPtr.Zero) continue;
            return (SteamApiGetInterface)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(SteamApiGetInterface));
        }
        throw new EntryPointNotFoundException(exportPrefix + "_v###");
    }

    private static bool TryParseArguments(string[] args, out string steamApiPath, out uint appId, out string pipeName, out byte[] nonce)
    {
        steamApiPath = null;
        appId = 0;
        pipeName = null;
        nonce = null;
        string nonceHex = null;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--steam-api" && index + 1 < args.Length) steamApiPath = args[++index];
            else if (args[index] == "--app-id" && index + 1 < args.Length)
            {
                if (!uint.TryParse(args[++index], NumberStyles.None, CultureInfo.InvariantCulture, out appId)) return false;
            }
            else if (args[index] == "--pipe-name" && index + 1 < args.Length) pipeName = args[++index];
            else if (args[index] == "--nonce" && index + 1 < args.Length) nonceHex = args[++index];
        }
        return !string.IsNullOrWhiteSpace(steamApiPath)
            && Path.IsPathRooted(steamApiPath)
            && appId != 0
            && IsSafePipeName(pipeName)
            && TryDecodeHex(nonceHex, NonceLength, out nonce);
    }

    private static bool IsSafePipeName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 120) return false;
        foreach (char character in value)
        {
            if (!char.IsLetterOrDigit(character) && character != '-' && character != '_') return false;
        }
        return true;
    }

    private static bool TryDecodeHex(string value, int expectedLength, out byte[] bytes)
    {
        bytes = null;
        if (string.IsNullOrEmpty(value) || value.Length != expectedLength * 2) return false;
        byte[] decoded = new byte[expectedLength];
        for (int index = 0; index < decoded.Length; index++)
        {
            byte parsed;
            if (!byte.TryParse(value.Substring(index * 2, 2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out parsed))
            {
                Array.Clear(decoded, 0, decoded.Length);
                return false;
            }
            decoded[index] = parsed;
        }
        bytes = decoded;
        return true;
    }

    private static void WriteUInt16(byte[] bytes, int offset, ushort value)
    {
        bytes[offset] = (byte)value;
        bytes[offset + 1] = (byte)(value >> 8);
    }

    private static void WriteUInt32(byte[] bytes, int offset, uint value)
    {
        for (int index = 0; index < 4; index++) bytes[offset + index] = (byte)(value >> (index * 8));
    }

    private static void WriteUInt64(byte[] bytes, int offset, ulong value)
    {
        for (int index = 0; index < 8; index++) bytes[offset + index] = (byte)(value >> (index * 8));
    }

    private static void ZeroMemory(IntPtr pointer, int length)
    {
        for (int index = 0; index < length; index++) Marshal.WriteByte(pointer, index, 0);
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
    }
}
