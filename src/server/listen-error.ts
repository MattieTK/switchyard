export function describeListenError(e: NodeJS.ErrnoException, port: number): string {
  if (e.code === "EADDRINUSE") {
    return [
      `Port ${port} is already in use, so Switchyard can't start.`,
      `It needs this exact port because the Cloudflare login redirects to http://localhost:${port}.`,
      `Find the other process with: lsof -i :${port}`,
    ].join("\n");
  }
  return `Switchyard couldn't start: ${e.message}`;
}
