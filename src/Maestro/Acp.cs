using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Maestro;

/// <summary>An error an ACP agent answered a request with.</summary>
sealed class AcpException(int code, string message, JsonNode? data = null) : Exception(message)
{
    public int Code { get; } = code;
    public JsonNode? ErrorData { get; } = data;
}

/// <summary>
/// A connection to an agent that speaks the Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0,
/// one message per line, over the agent process's stdin and stdout. Claude, Codex, Gemini, and most other coding
/// agents speak it, so one client covers them all.
/// </summary>
sealed class AcpConnection : IDisposable
{
    readonly Process process;
    readonly StreamWriter input;
    readonly SemaphoreSlim writing = new(1);
    readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> pending = new();
    readonly StringBuilder stderr = new();
    long nextId;
    volatile bool disposed;

    /// <summary>A notification from the agent, such as session/update.</summary>
    public event Action<string, JsonNode?>? Notified;

    /// <summary>The process ended; the argument is the end of what it wrote to stderr.</summary>
    public event Action<string>? Exited;

    /// <summary>Answers requests the agent makes of us (permission prompts and the like). Throw AcpException to refuse.</summary>
    public Func<string, JsonNode?, Task<JsonNode?>>? HandleRequest { get; set; }

    public bool Alive => !process.HasExited;

    public AcpConnection(ProcessStartInfo start)
    {
        start.RedirectStandardInput = start.RedirectStandardOutput = start.RedirectStandardError = true;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.StandardInputEncoding = start.StandardOutputEncoding = start.StandardErrorEncoding = new UTF8Encoding(false);
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (stderr)
            {
                stderr.AppendLine(e.Data);
                if (stderr.Length > 8000) stderr.Remove(0, stderr.Length - 8000);
            }
        };
        process.Start();
        process.BeginErrorReadLine();
        input = process.StandardInput;
        input.AutoFlush = true;
        input.NewLine = "\n";
        _ = Task.Run(ReadLoop);
    }

    public string StderrTail()
    {
        lock (stderr) return stderr.ToString().Trim();
    }

    public async Task<JsonNode?> Request(string method, JsonNode? parameters, TimeSpan? timeout = null)
    {
        var id = Interlocked.Increment(ref nextId);
        var reply = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = reply;
        try
        {
            await Send(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters }).ConfigureAwait(false);
            return timeout is { } t ? await reply.Task.WaitAsync(t).ConfigureAwait(false) : await reply.Task.ConfigureAwait(false);
        }
        finally
        {
            pending.TryRemove(id, out _);
        }
    }

    public Task Notify(string method, JsonNode? parameters) =>
        Send(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = method, ["params"] = parameters });

    async Task Send(JsonObject message)
    {
        // ConfigureAwait(false) throughout: Maestro waits for the session to close on the UI thread when it quits.
        await writing.WaitAsync().ConfigureAwait(false);
        try
        {
            if (process.HasExited) throw new IOException("The agent has stopped.");
            await input.WriteLineAsync(message.ToJsonString()).ConfigureAwait(false);
        }
        finally
        {
            writing.Release();
        }
    }

    async Task ReadLoop()
    {
        var output = process.StandardOutput;
        try
        {
            while (await output.ReadLineAsync() is { } line)
            {
                if (line.Length == 0 || line[0] != '{') continue; // some agents log to stdout before they start
                JsonObject? msg;
                try { msg = JsonNode.Parse(line) as JsonObject; }
                catch (System.Text.Json.JsonException) { continue; }
                if (msg == null) continue;

                var method = msg.Str("method");
                var id = msg["id"];
                if (method == null && id != null)
                {
                    if (id is JsonValue v && v.TryGetValue<long>(out var n) && pending.TryGetValue(n, out var reply))
                    {
                        if (msg["error"] is JsonObject err)
                            reply.TrySetException(new AcpException((int)(err.Num("code") ?? 0), err.Str("message") ?? "Agent error", err["data"]?.DeepClone()));
                        else
                            reply.TrySetResult(msg["result"]?.DeepClone());
                    }
                }
                else if (method != null && id != null)
                {
                    _ = Answer(id.DeepClone(), method, msg["params"]?.DeepClone());
                }
                else if (method != null)
                {
                    Notified?.Invoke(method, msg["params"]?.DeepClone());
                }
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }

        if (disposed) return;
        try { await process.WaitForExitAsync(); }
        catch (InvalidOperationException) { }
        foreach (var reply in pending.Values) reply.TrySetException(new IOException("The agent stopped. " + StderrTail()));
        Exited?.Invoke(StderrTail());
    }

    async Task Answer(JsonNode id, string method, JsonNode? parameters)
    {
        JsonObject reply = new() { ["jsonrpc"] = "2.0", ["id"] = id };
        try
        {
            if (HandleRequest == null) throw new AcpException(-32601, "Method not found");
            reply["result"] = await HandleRequest(method, parameters);
        }
        catch (Exception e)
        {
            reply["error"] = new JsonObject { ["code"] = e is AcpException a ? a.Code : -32603, ["message"] = e.Message };
        }
        try { await Send(reply); }
        catch (IOException) { }
    }

    public void Dispose()
    {
        disposed = true;
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
