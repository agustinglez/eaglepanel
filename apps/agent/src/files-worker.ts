/**
 * File manager process. The agent launches it as the account user (`setpriv`), with HOME set to
 * its home directory, so everything it does is limited to its permissions and quota. It never runs as root.
 *
 *   files-worker.ts             JSON request on stdin, JSON result on stdout
 *   files-worker.ts download P  the content of file P on stdout
 *   files-worker.ts upload P 1  stores stdin as P; the 1 allows overwriting an existing one
 *
 * An error exits with code 1 and the message on stderr.
 */
import { fileRequestSchema, filePathSchema } from "@eaglepanel/shared";
import { explain, openDownload, runFileRequest, saveUpload } from "./files";

if (process.getuid?.() === 0) {
  process.stderr.write("The file process does not run as root");
  process.exit(1);
}

const home = process.env.HOME ?? "";
// What is created stays readable by OLS (which reads as another user) but not writable by others.
process.umask(0o022);

try {
  const [mode, rawPath, overwrite] = process.argv.slice(2);
  if (mode === "download" || mode === "upload") {
    const path = filePathSchema.parse(rawPath);
    if (mode === "download") {
      const { stream } = await openDownload(home, path);
      const writer = Bun.stdout.writer();
      for await (const chunk of stream) {
        writer.write(chunk);
        await writer.flush();
      }
      await writer.end();
    } else {
      process.stdout.write(JSON.stringify(await saveUpload(home, path, overwrite === "1", Bun.stdin.stream())));
    }
  } else {
    const request = fileRequestSchema.parse(JSON.parse(await Bun.stdin.text()));
    process.stdout.write(JSON.stringify(await runFileRequest(home, request)));
  }
} catch (error) {
  process.stderr.write(explain(error).message);
  process.exit(1);
}
