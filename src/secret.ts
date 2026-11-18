// Reading from stdin: the whole input for piped data, and one hidden line (passwords, keys) for a terminal.
let stdinQueue: string[] | null = null;
export const stdinLines = async (): Promise<string[]> => {
  if (stdinQueue === null) {
    let all = "";
    process.stdin.setEncoding("utf8");
    for await (const c of process.stdin) all += c;
    stdinQueue = all.split("\n");
  }
  return stdinQueue;
};
export const readStdinAll = async (): Promise<string> => (await stdinLines()).join("\n").replace(/\r/g, "");
export const readSecret = async (prompt: string): Promise<string> => {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) return ((await stdinLines()).shift() ?? "").replace(/\r$/, "");
  return new Promise((res) => {
    stdin.setRawMode(true);
    stdin.resume();
    let pw = "";
    const done = (): void => {
      stdin.removeAllListeners("data");
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      res(pw);
    };
    stdin.on("data", (c: Buffer) => {
      for (const b of c.toString("utf8")) {
        if (b === "\r" || b === "\n" || b === "\u0004" || b === "\u001a") return done();
        if (b === "\u0003") process.exit(130);
        else if (b === "\b" || b === "\u007f") pw = pw.slice(0, -1);
        else pw += b;
      }
      return;
    });
  });
};
