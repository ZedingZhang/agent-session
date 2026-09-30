// Load with: ctxcrate --plugin ./examples/custom-adapter.mjs import notes.txt --adapter notes
export default {
  id: 'notes', version: '1.0.0', description: 'Treat a plain text note as a user message',
  detect: input => input.filename.endsWith('.txt'),
  parse: input => [{
    title: 'Imported note', sourceFormat: 'text', sourceContent: input.content,
    events: [{ type: 'message', timestamp: null, data: { role: 'user', content: input.content } }],
  }],
};
