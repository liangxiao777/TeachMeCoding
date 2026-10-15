import type { Lesson } from './workspace.js';

// Read compatibility only. Keep every saved field; never rewrite old versions
// or use another model to summarize a historical lesson for review.
export function lessonMarkdown(lesson: Lesson): string {
  const blocks = lesson.blocks?.map((block) => {
    switch (block.type) {
      case 'h2': return /^\s*#{1,6}\s/.test(block.text) ? block.text : `## ${block.text}`;
      case 'p': case 'markdown': return block.text;
      case 'list': case 'practice': return block.items.map((item) => `- ${item}`).join('\n');
      case 'callout': return `### ${block.title}\n\n${block.text}`;
      case 'code': {
        const fence = '`'.repeat(Math.max(3, ...(block.code.match(/`+/g) ?? []).map((match) => match.length + 1)));
        return `${fence}${block.language} file=${JSON.stringify(block.file)}\n${block.code}${block.code.endsWith('\n') ? '' : '\n'}${fence}${block.caption === undefined ? '' : `\n\n${block.caption}`}`;
      }
    }
  }) ?? [];
  return [lesson.content, lesson.intro, ...blocks].filter((part) => part !== undefined && part !== '').join('\n\n');
}
