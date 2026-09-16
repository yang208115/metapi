import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('proxy route semantic ownership boundaries', () => {
  it('keeps chat stream closeout semantics out of the route', () => {
    const source = readSource('./chat.ts');

    expect(source).not.toContain('const finalizeChatStream =');
    expect(source).not.toContain('openAiChatTransformer.buildSyntheticChunks(');
    expect(source).not.toContain('openAiChatTransformer.aggregator.finalize(');
  });

  it('keeps responses stream closeout semantics out of the route', () => {
    const source = readSource('./responses.ts');

    expect(source).not.toContain('const finalizeResponsesSse =');
    expect(source).not.toContain("reply.raw.write('data: [DONE]");
    expect(source).not.toContain('successfulUpstreamPath === \'/v1/responses\'');
  });
});
