import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export interface GitRunOptions {
  /** Pass `--git-dir=<dir>` (bare/mirror repositories). */
  gitDir?: string;
  /** Working directory for the process. */
  cwd?: string;
  /** Cap on captured stdout bytes. */
  maxBytes?: number;
}

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout was cut off at `maxBytes`. */
  truncated: boolean;
}

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;

  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  bin: string;
  token?: string;
  caInfo?: string;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

/**
 * Thin wrapper around the `git` CLI.
 *
 * Everything is passed as an argument array (never a shell string), the token is
 * injected through `http.extraheader` so it never lands in `.git/config`, and
 * terminal prompts are disabled so a bad credential fails fast instead of
 * hanging.
 */
export class Git {
  constructor(private readonly options: GitOptions) {}

  private globalArgs(gitDir?: string): string[] {
    const args = ["--no-pager"];
    if (gitDir) {
      args.push(`--git-dir=${gitDir}`);
    }
    args.push("-c", "core.longpaths=true");
    args.push("-c", "core.quotepath=false");
    if (this.options.caInfo) {
      args.push("-c", `http.sslCAInfo=${this.options.caInfo}`);
    }
    // Neutralise any configured credential helper so only our header is used.
    args.push("-c", "credential.helper=");
    if (this.options.token) {
      const basic = Buffer.from(`oauth2:${this.options.token}`, "utf8").toString("base64");
      args.push("-c", `http.extraheader=Authorization: Basic ${basic}`);
    }
    return args;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    };
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    return env;
  }

  /** Run git and always resolve with the exit code (spawn failures reject). */
  run(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
    const argv = [...this.globalArgs(options.gitDir), ...args];
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

    return new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn(this.options.bin, argv, {
        cwd: options.cwd,
        env: this.childEnv(),
        shell: false,
        windowsHide: true,
      });

      if (!child.stdout || !child.stderr) {
        reject(new GitError("Failed to attach to git stdio.", null, ""));
        return;
      }

      const out: Buffer[] = [];
      const errs: Buffer[] = [];
      let outLen = 0;
      let errLen = 0;
      let truncated = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (outLen >= maxBytes) {
          truncated = true;
          return;
        }
        const remaining = maxBytes - outLen;
        if (chunk.length > remaining) {
          out.push(chunk.subarray(0, remaining));
          outLen = maxBytes;
          truncated = true;
        } else {
          out.push(chunk);
          outLen += chunk.length;
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (errLen >= MAX_STDERR_BYTES) {
          return;
        }
        const remaining = MAX_STDERR_BYTES - errLen;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        errs.push(slice);
        errLen += slice.length;
      });

      child.on("error", (error) => {
        reject(new GitError(`Failed to run git: ${error.message}`, null, ""));
      });

      child.on("close", (code) => {
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(errs).toString("utf8"),
          truncated,
        });
      });
    });
  }

  /** Run git and throw `GitError` on a non-zero exit code. */
  async runOrThrow(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      throw new GitError(
        `git ${args[0] ?? ""} failed (exit ${result.code ?? "?"})`,
        result.code,
        this.redact(result.stderr.trim()),
      );
    }
    return result;
  }

  /**
   * Remove the configured token from any text before it reaches a log or a tool
   * result. git should never echo an `http.extraheader` value, but a failure
   * message is exactly where a secret tends to leak, so redact defensively.
   */
  redact(text: string): string {
    const token = this.options.token;
    if (!token) {
      return text;
    }
    return text.split(token).join("***");
  }
}
