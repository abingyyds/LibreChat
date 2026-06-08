import type { TAttachment } from 'librechat-data-provider';
import { mapAttachments } from '../map';

describe('mapAttachments', () => {
  it('groups attachments by camelCase toolCallId', () => {
    const attachment = {
      messageId: 'msg-1',
      toolCallId: 'call-1',
      conversationId: 'conv-1',
      filepath: '/images/image.png',
    } as TAttachment;

    expect(mapAttachments([attachment])).toEqual({
      'call-1': [attachment],
    });
  });

  it('groups attachments by OpenAI-style tool_call_id', () => {
    const attachment = {
      messageId: 'msg-1',
      tool_call_id: 'call-1',
      conversationId: 'conv-1',
      filepath: '/images/image.png',
    } as unknown as TAttachment;

    expect(mapAttachments([attachment])).toEqual({
      'call-1': [attachment],
    });
  });
});
