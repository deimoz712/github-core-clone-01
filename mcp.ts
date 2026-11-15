// mcp.ts — MCP over streamable HTTP (Fase 3).
//
// Fase 2 stub: the endpoint exists and answers a JSON 404, so the surface is
// present but unimplemented. JSON-RPC 2.0, the 6 required tools and the
// 2026-07-28 / 2025-11-25 handshakes land in Fase 3.

import { HttpError } from './rest.ts';

export function handleMcp(_body: unknown): never {
  throw new HttpError(404, 'Not Found');
}
