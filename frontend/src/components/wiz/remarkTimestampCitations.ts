import type { Root, RootContent, Text, Parent } from 'mdast';

const excluded = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'html']);

/** Transform prose only; Markdown remains responsible for links and code. */
export default function remarkTimestampCitations() {
  return (tree: Root) => {
    function visit(parent: Root | RootContent) {
      if (excluded.has(parent.type) || !('children' in parent)) return;
      const children: RootContent[] = [];
      for (const child of parent.children) {
        if (child.type !== 'text') {
          visit(child);
          children.push(child);
          continue;
        }
        const pattern = /\[((?:\s*\d{1,2}:\d{2}(?::\d{2})?\s*)(?:,\s*\d{1,2}:\d{2}(?::\d{2})?\s*)*)\](?!\()/g;
        let offset = 0;
        for (const match of child.value.matchAll(pattern)) {
          if (match.index > offset) children.push({ type: 'text', value: child.value.slice(offset, match.index) });
          match[1].split(',').forEach((part, index) => {
            if (index) children.push({ type: 'text', value: ', ' });
            const units = part.trim().split(':');
            const seconds = units.reduce((total, unit) => total * 60 + Number(unit), 0);
            const label = [String(Number(units[0])), ...units.slice(1)].join(':');
            const citation: Text = {
              type: 'text', value: label,
              data: { hName: 'button', hProperties: { type: 'button', value: String(seconds), 'aria-label': `Seek video to ${label}` } },
            };
            children.push(citation);
          });
          offset = match.index + match[0].length;
        }
        if (offset < child.value.length) children.push({ type: 'text', value: child.value.slice(offset) });
      }
      // Every replacement of an inline text node remains phrasing content.
      (parent as Parent).children = children;
    }
    visit(tree);
  };
}
