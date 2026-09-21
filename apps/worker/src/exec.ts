import { execFile } from "node:child_process";

export type Exec = (file: string, args: string[], env?: Record<string, string>) => Promise<string>;

/** Run a program without a shell; resolve with stdout. On failure the error carries `stdout`. */
export const realExec: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", ...env },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30 * 60_000,
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve(stdout);
      },
    );
  });
