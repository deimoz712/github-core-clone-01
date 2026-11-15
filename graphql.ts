// graphql.ts — GraphQL v4 (Fase 3).
//
// Fase 2 stub: the endpoint exists and answers a JSON 404, so the surface is
// present but unimplemented. The executor for the 18 documents in
// checks-graphql.ts lands in Fase 3.

import { HttpError } from './rest.ts';

export function handleGraphql(_body: Record<string, unknown> | undefined): never {
  throw new HttpError(404, 'Not Found');
}
