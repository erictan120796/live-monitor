using System;
using System.Text;
using System.Diagnostics;
public class FakeAgent {
    public static void Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("fake-agent 1.2.3"); return; }
        string input = args.Length > 0 && args[args.Length - 1] == "-" ? Console.In.ReadToEnd() : "";
        Console.WriteLine("{\"type\":\"fixture.stdin\",\"stdin_b64\":\"" + Convert.ToBase64String(Encoding.UTF8.GetBytes(input)) + "\"}");
        var values = Array.ConvertAll(args, s => "\"" + Convert.ToBase64String(Encoding.UTF8.GetBytes(s)) + "\"");
        Console.WriteLine("{\"type\":\"fixture.native\",\"arguments_b64\":[" + string.Join(",", values) + "],\"pid\":" + Process.GetCurrentProcess().Id + "}");
        Console.Error.WriteLine("native stderr: caf\u00e9 \u4e2d\u6587");
        Console.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"native-thread\"}");
    }
}
